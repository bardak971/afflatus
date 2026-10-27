import { setTimeout as sleep } from "node:timers/promises";
import { notFilled, plural, type Recipe } from "@afflatus/core";
import { z } from "zod";
import type { Tables } from "./db";
import { compose, lookSchema, withMentions, type Look } from "./entities";
import { httpError } from "./errors";
import { jobBody, queueRender } from "./jobs-api";
import { oneAtATime } from "./keyedLock";
import { readJson } from "./queueModel";
import { formArgs, formAsked, machineName, machineOf, seen, spends, wholeOf, type Seen } from "./mcpForms";
import { tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { runwayNeed } from "./rentedBilling";
import { EXPORT_JOB } from "./timelineModel";
import type { Services } from "./services";
import { readSettings, type Machine } from "./settings";

/**
 * Rendering and the queue, from outside (MCP): a draft (or a form with values) rendered through the same path as the
 * web's Render (jobs-api.ts queueRender, the queue's own refusals), the queue read, a job followed, cancelled or done
 * again, a machine paused or resumed, a model loaded ahead.
 *
 * A money path (memory money-paths-critical): a token without Spend never lands on a rented pod, pinned there (refused
 * here) or picked by the queue (queuePlan.ts offPods keeps its jobs off the pods at every pass, whatever its scopes become);
 * a token with Spend is held to its own cap with its queued and running work counted, not only its finished renders
 * (mcpTokens.ts spentThisMonth counts those), checked when it queues and again where the queue hands a job to a pod
 * (capHeld), and the app's own caps hold over it as over anyone. A token's checks and its queueing go one call at a time
 * (`mcp-render:<token>`): two renders at once both passed a cap that holds one.
 */

const HOUR = 3_600_000;

/** A pod in these states takes no job now (stopped, terminated, gone from the account, failed): only a render pinned there may wait for it. */
const IDLE_POD = new Set(["EXITED", "TERMINATED", "GONE", "ERROR"]);

/**
 * Each rented pod's hourly rate (its RunPod price; null while it is not known), and whether it may take a job now, as the
 * pods are watched (rented.ts view, in memory: never the queue's last status, which may predate a pod just started). A pod
 * not read yet counts as up with no known price: a render that may land there is refused rather than counted as free.
 */
function podsOf(s: Services, machines: readonly Machine[]): Map<string, { rate: number | null; up: boolean }> {
  return new Map(machines.flatMap((machine) => {
    if (!machine.rented) return [];
    const v = s.rented.view(machine);
    return [[machine.id, { rate: v?.rate ?? null, up: !v || !IDLE_POD.has(v.status) }] as const];
  }));
}

/** Why a pod is not counted when its price is not known (said by a refused render, and on a held job's Queue row). */
const unpriced = (pod: Machine) => `${machineName(pod)}'s price is not known yet, so this token's spend cap cannot be held`;

/**
 * What one render of a form may cost on the rented pods it may land on (USD): its forecast there, else the queue's floor
 * for a render with no forecast (rentedBilling.ts runwayNeed), at the dearest of those pods' rates. 0 when it can land on
 * none (pinned to a machine of the user's own, or no pod).
 */
async function mayCostEach(s: Services, recipe: string, input: unknown, pods: readonly Machine[], rates: ReadonlyMap<string, { rate: number | null }>): Promise<number> {
  if (!pods.length) return 0;
  const got = await s.queue.forecast(recipe, input).catch(() => null);
  let most = 0;
  for (const pod of pods) {
    const f = got?.on?.[pod.id] ?? got?.forecast;
    const ms = runwayNeed({ renderMs: f ? f.ms + f.loadMs : null, fetchMs: 0, sure: (got?.forecast.samples ?? 0) >= 3 });
    // a pod whose price is not known yet cannot be held to a cap: nothing goes there through a token until it is
    const rate = rates.get(pod.id)?.rate;
    if (rate === null || rate === undefined) throw refusal(`${unpriced(pod)}: pin the render to another machine, or wait until the pod is up.`);
    most = Math.max(most, (ms / HOUR) * rate);
  }
  return most;
}

/** A token's renders waiting or running now, the running first, then in the queue's order (a model load alone is no render). */
const activeJobs = (s: Services, tokenId: string) => s.db.selectFrom("jobs").select(["id", "recipe_id", "inputs", "pin_machine", "machine_id", "status"])
  .where("mcp_token_id", "=", tokenId).where("status", "in", ["queued", "running"]).where("warm", "=", 0)
  .orderBy("priority").orderBy("created_at").execute();

/** Where a token's job is or may go: the pod it runs on, else its pin, else any pod up that the queue may send it to. */
function podsFor(j: { status: string; machine_id?: string | null; pin_machine?: string | null }, pods: readonly Machine[], rates: ReadonlyMap<string, { up: boolean }>): Machine[] {
  const on = j.status === "running" ? j.machine_id : j.pin_machine;
  return on ? pods.filter((p) => p.id === on) : pods.filter((p) => rates.get(p.id)?.up);
}

/** What this token's renders waiting or running now may still cost on rented pods (USD): its work counted before it is billed. */
export async function committedSpend(s: Services, machines: readonly Machine[], tokenId: string): Promise<number> {
  const jobs = await activeJobs(s, tokenId);
  if (!jobs.length) return 0;
  const rates = podsOf(s, machines);
  const pods = machines.filter((m) => m.rented);
  let sum = 0;
  for (const j of jobs) sum += await mayCostEach(s, j.recipe_id, readJson(j.inputs, {}), podsFor(j, pods, rates), rates);
  return sum;
}

/** Why a Spend token's job waits for its cap (its Queue row says it). */
export const CAP_FULL = "its MCP token's spend cap has no room for it on a rented pod (its renders running and waiting ahead counted): raise the cap in Settings › Interface › Access, or it runs on a machine of the user's own";

/**
 * The jobs among these, queued by MCP tokens with Spend, that no rented pod takes this pass, each with why (the planner,
 * queuePlan.ts offPods, keeps them off the pods and their Queue rows say it). render checks a token's cap when it queues;
 * this checks it again where the queue hands a job to a pod, since a job queued with no pod up cost nothing then and would
 * land, uncounted, on a pod the user starts later. Each token's month so far and its running renders are counted first,
 * then its waiting ones in the queue's order: a job whose cost there would pass the cap waits (on the user's own machines
 * it may still run), as does one that may go only to a pod whose price is not known yet. A money path.
 */
export async function capHeld(s: Services, rows: ReadonlyArray<{ id: string; mcp_token_id?: string | null }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const asked = new Set(rows.map((r) => r.id));
  const tokenIds = [...new Set(rows.map((r) => r.mcp_token_id).filter((id): id is string => Boolean(id)))];
  if (!tokenIds.length) return out;
  const machines = (await readSettings(s.db)).machines;
  const pods = machines.filter((m) => m.rented);
  if (!pods.length) return out;
  const rates = podsOf(s, machines);
  for (const id of tokenIds) {
    const token = await s.mcp.tokens.get(id);
    if (!token) continue;
    const cap = token.spendCapCents / 100;
    let total = await s.mcp.tokens.spentThisMonth(id);
    for (const j of await activeJobs(s, id)) {
      const may = podsFor(j, pods, rates);
      if (!may.length) continue;
      if (j.status === "running") {
        total += await mayCostEach(s, j.recipe_id, readJson(j.inputs, {}), may, rates).catch(() => 0);
        continue;
      }
      const unknown = may.find((p) => rates.get(p.id)?.rate == null);
      if (unknown) {
        if (asked.has(j.id)) out.set(j.id, `${unpriced(unknown)} for the MCP token that sent it`);
        continue;
      }
      const cost = await mayCostEach(s, j.recipe_id, readJson(j.inputs, {}), may, rates);
      if (total + cost > cap) {
        if (asked.has(j.id)) out.set(j.id, CAP_FULL);
        continue;
      }
      total += cost;
    }
  }
  return out;
}

/**
 * Whether this token may send `takes` renders of a form, pinned to `machine` or left to the queue: its renders an hour, and
 * on rented pods its Spend and its cap with what it has waiting and running counted. Answers what they may cost (USD).
 */
export async function mayQueue(s: Services, ctx: ToolCtx, at: Seen, o: { recipe: string; input: unknown; takes: number; machine?: Machine; renders: boolean }): Promise<number> {
  return mayQueueAll(s, ctx, at, [o], { machine: o.machine, renders: o.renders ? o.takes : 0 });
}

/**
 * The same for several jobs sent together (a timeline's clips, a finish): each `takes` times, `renders` of them counted
 * against the renders an hour, their costs on rented pods added up before the cap is asked. What they may cost (USD).
 */
export async function mayQueueAll(s: Services, ctx: ToolCtx, at: Seen, jobs: ReadonlyArray<{ recipe: string; input: unknown; takes: number }>, o: { machine?: Machine; renders: number }): Promise<number> {
  if (o.renders) await ctx.mayRender(o.renders);
  const rates = podsOf(s, at.machines.map((m) => m.machine));
  // the pods the queue may send it to: those up now (a stopped pod takes nothing until it is started)
  const pods = at.machines.map((m) => m.machine).filter((m) => m.rented && rates.get(m.id)?.up);
  if (!spends(ctx)) {
    if (o.machine?.rented) throw refusal(`This token cannot spend on rented GPUs, and ${machineName(o.machine)} is one: tick Spend on it in Settings › Interface › Access, or render on a machine of the user's own.`);
    if (!o.machine && !at.machines.some((m) => !m.machine.rented)) throw refusal("This token cannot spend on rented GPUs, and the user has no machine of their own to render on: tick Spend on it in Settings › Interface › Access.");
    return 0;
  }
  const may = o.machine ? (o.machine.rented ? [o.machine] : []) : pods;
  if (!may.length) return 0;
  let usd = 0;
  for (const j of jobs) usd += (await mayCostEach(s, j.recipe, j.input, may, rates)) * j.takes;
  await ctx.maySpend(usd + (await committedSpend(s, at.machines.map((m) => m.machine), ctx.token.id)));
  return usd;
}

/** A form as a render sends it: what it starts on, what the draft holds over it, refused as Render refuses an unfilled one. */
async function sendable(s: Services, at: Seen, args: { draft?: string; form?: string; values?: Record<string, unknown> }) {
  const asked = await formAsked(s, args);
  const input = await wholeOf(s, at, asked.recipe, asked.stored);
  const missing = notFilled(asked.recipe, input);
  if (missing) throw httpError(`${asked.name}: ${missing}`);
  const look = asked.draft?.look ? lookSchema.nullable().catch(null).parse(asked.draft.look) : null;
  return { ...asked, input, look: look && (look.cast.length || look.style || look.snippets.length) ? look : undefined };
}

const render = tool({
  name: "render",
  scope: "make",
  title: "Render",
  description: "Render a draft as it stands (or a form with values): N takes, on a machine or wherever the queue would end it first. The same path as Create's Render, with the same refusals (an unfilled input, files that give black frames). The token's renders-an-hour limit holds; a rented pod needs Spend (a token without it never lands on one, picked or pinned) and stays within the token's spend cap, its waiting and running work counted. Answers the job ids (job, queue_status follow them; job with wait waits for the end) and what it may cost. Render a draft when the user should be able to open and change what made the take in Create (new_draft, edit_draft); a form with values leaves no draft. A video comes out on the model's own frame count, a little off the seconds asked (H3's 6 s: 5.875 s): not a failure.",
  input: {
    ...formArgs,
    takes: z.number().int().min(1).max(8).optional().describe("How many takes (1–8); a draft's own batch when left out."),
    machine: z.string().optional().describe("A machine's id or name (overview); left out, the queue picks among those this token may use."),
    label: z.string().max(200).optional(),
  },
  run: (args, ctx) => renderForm(args, ctx),
});

/**
 * A render of a draft or a form with values, as the render tool sends it (run_workflow too, for an imported workflow's form):
 * the money rules held in one turn per token, then the web's own queueRender.
 */
export async function renderForm(args: { draft?: string; form?: string; values?: Record<string, unknown>; takes?: number; machine?: string; label?: string }, ctx: ToolCtx) {
  const { s, token } = ctx;
  const at = await seen(s);
  const form = await sendable(s, at, args);
  const machine = args.machine ? machineOf(at, args.machine) : undefined;
  const takes = args.takes ?? form.count;
  // the checks and the queueing in one turn per token: a second render waits for the first to be counted
  return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
    const usd = await mayQueue(s, ctx, at, { recipe: form.recipe.id, input: form.input, takes, machine, renders: true });
    const ids = await queueRender(s, jobBody.parse({ recipe: form.recipe.id, input: form.input, count: takes, look: form.look, draft: form.draft?.id, label: args.label, machine: machine?.id }), { mcpToken: token.id });
    ctx.said(`Rendered ${plural(takes, "take")} of ${form.name}${machine ? ` on ${machineName(machine)}` : ""}`);
    return { jobs: ids, takes, on: machine ? machineName(machine) : spends(ctx) ? "wherever the queue ends it first" : "the user's own machines (this token has no Spend)", ...(usd ? { mayCostUsd: Math.round(usd * 100) / 100 } : {}) };
  });
}

const loadModel = tool({
  name: "load_model",
  scope: "make",
  title: "Load the model",
  description: "Load the models a draft (or a form with values) would render with, ahead of the render, as Create does while the prompt is written: a job in the queue that makes nothing. On a machine, or where its render would run. A rented pod needs Spend.",
  input: { ...formArgs, machine: z.string().optional().describe("A machine's id or name (overview).") },
  async run(args, ctx) {
    const { s, token } = ctx;
    const at = await seen(s);
    const asked = await formAsked(s, args);
    const input = await wholeOf(s, at, asked.recipe, asked.stored);
    const machine = args.machine ? machineOf(at, args.machine) : undefined;
    await mayQueue(s, ctx, at, { recipe: asked.recipe.id, input, takes: 1, machine, renders: false });
    const picked = asked.draft?.look ? (lookSchema.nullable().catch(null).parse(asked.draft.look) as Look | null) : null;
    // "@Name" in a text casts that person here too, as it does for the render (jobs-api.ts queueRender)
    const look = picked ?? (await withMentions(s.db, asked.recipe, input, null)).look;
    const withCast = look ? (await compose(s.db, asked.recipe, input, look).catch(() => null))?.input ?? input : input;
    const id = await s.queue.enqueue(asked.recipe.id, withCast, { label: `Load the model: ${asked.recipe.title}`, warm: true, machine: machine?.id ?? null, mcpToken: token.id });
    ctx.said(`Loaded the model of ${asked.name}${machine ? ` on ${machineName(machine)}` : ""}`);
    return { job: id };
  },
});

/** A job as the queue tools say it: its words, where it is, how far, how long left, what it made. */
function jobSaid(j: { id: string; label: string; recipe: string; status: string; machine?: string | null; by?: { name: string } | null; progress?: number; eta?: number; phase?: string; estimateMs?: number | null; startsInMs?: number | null; error?: string | null }, names: ReadonlyMap<string, string>) {
  return {
    job: j.id, label: j.label, form: j.recipe, status: j.status,
    ...(j.machine ? { machine: names.get(j.machine) ?? j.machine } : {}),
    ...(j.by ? { by: j.by.name } : {}),
    ...(typeof j.progress === "number" ? { progress: Math.round(j.progress * 100) / 100 } : {}),
    ...(j.eta ? { leftMs: j.eta } : {}),
    ...(j.phase ? { phase: j.phase } : {}),
    ...(j.estimateMs ? { takesMs: j.estimateMs } : {}),
    ...(j.startsInMs ? { startsInMs: j.startsInMs } : {}),
    ...(j.error ? { error: j.error } : {}),
  };
}

const machineNames = async (s: Services) => new Map((await s.machines()).map(({ machine }) => [machine.id, machineName(machine)]));

const queueStatus = tool({
  name: "queue_status",
  scope: "look",
  title: "Queue",
  description: "The queue now: what each machine renders (progress, time left, phase), the jobs waiting in order (when each starts, how long it takes, who queued it), whether it is paused, and when it is all done.",
  input: { waiting: z.number().int().min(0).max(200).optional().describe("How many waiting jobs to list (20 when left out).") },
  async run({ waiting }, ctx) {
    const st = await ctx.s.queue.statusRecent();
    const names = await machineNames(ctx.s);
    const running = st.machines.flatMap((m) => (m.running ? [jobSaid({ ...(m.running as Parameters<typeof jobSaid>[0]), machine: m.id }, names)] : []));
    ctx.said(`Looked at the queue: ${running.length} running, ${st.waiting.length} waiting`);
    return {
      paused: st.paused,
      machines: st.machines.map((m) => ({ id: m.id, name: names.get(m.id) ?? m.name, paused: m.paused, online: m.online })),
      running,
      waiting: st.waiting.slice(0, waiting ?? 20).map((j) => jobSaid(j as Parameters<typeof jobSaid>[0], names)),
      waitingCount: st.waiting.length,
      doneInMs: st.waitingEndsInMs,
    };
  },
});

/** A job's row, refused with where to find the ids when there is none. */
/** The longest `job` waits for a job to end: under the minute a client's call is given. */
const JOB_WAIT_MOST_S = 50;

async function jobRow(s: Services, id: string): Promise<Tables["jobs"]> {
  const row = await s.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw httpError("There is no such job: queue_status and render give the ids.", 404);
  return row;
}

const job = tool({
  name: "job",
  scope: "look",
  title: "Job",
  description: "One job: waiting (when it starts, how long it takes), running (progress, time left, phase), or ended (done with the library items it made, which view_item shows; failed with why; cancelled). `wait` holds the answer until the job ends or that many seconds pass, rather than asking again and again.",
  input: {
    job: z.string().min(1),
    wait: z.number().int().min(0).max(JOB_WAIT_MOST_S).optional().describe(`Seconds to wait for the job to end before answering (at most ${JOB_WAIT_MOST_S}); left out, it answers at once. Ask again with wait if it is still going.`),
  },
  async run({ job: id, wait }, ctx) {
    const { s } = ctx;
    let row = await jobRow(s, id);
    // a client's call times out after a minute or so: the wait stays under it, the job read again each second
    for (const until = Date.now() + (wait ?? 0) * 1000; (row.status === "queued" || row.status === "running") && Date.now() < until;) {
      await sleep(Math.min(1000, until - Date.now()));
      row = await jobRow(s, id);
    }
    const names = await machineNames(s);
    if (row.status === "queued" || row.status === "running") {
      const st = await s.queue.statusRecent();
      const live = st.machines.find((m) => m.running?.id === id)?.running ?? st.waiting.find((w) => w.id === id);
      ctx.said(`Followed the job “${row.label}”: ${row.status === "running" ? "running" : "waiting"}`);
      return jobSaid({ ...(live as Parameters<typeof jobSaid>[0] | undefined ?? { id, label: row.label, recipe: row.recipe_id, status: row.status }), status: row.status === "running" ? "running" : "waiting", machine: row.machine_id ?? (live as { machine?: string | null } | undefined)?.machine }, names);
    }
    const page = await s.queue.history({ ids: [id] });
    const h = page.items[0];
    const made = h?.made.map((a) => ({ item: a.id, kind: a.kind, width: a.width, height: a.height, durationMs: a.durationMs })) ?? [];
    // an export makes no generation: its video is the timeline's export (the newest, the one this job made unless another came since)
    if (row.status === "done" && row.recipe_id === EXPORT_JOB && row.timeline_id && !made.length) {
      const exported = (await s.timelines.view(row.timeline_id).catch(() => null))?.exported;
      if (exported) made.push({ item: exported.id, kind: exported.kind, width: exported.width, height: exported.height, durationMs: exported.durationMs });
    }
    ctx.said(`Followed the job “${row.label}”: ${row.status}`);
    return {
      ...jobSaid({ id, label: row.label, recipe: row.recipe_id, status: row.status, machine: row.machine_id, error: row.error }, names),
      ...(h ? { tookMs: h.tookMs, seed: h.seed } : {}),
      ...(h || made.length ? { made } : {}),
    };
  },
});

/**
 * A job this token may act on: its own, or one the user queued from the page. One another token queued is that token's
 * (or the user's in Afflatus) to stop or do again.
 */
async function mayTouch(s: Services, ctx: ToolCtx, row: Tables["jobs"]): Promise<void> {
  if (!row.mcp_token_id || row.mcp_token_id === ctx.token.id) return;
  const other = await s.mcp.tokens.get(row.mcp_token_id);
  throw refusal(`This job was queued by another token (${other?.name ?? "one revoked since"}): stop it or do it again in Afflatus, or with that token.`);
}

const cancel = tool({
  name: "cancel",
  scope: "make",
  title: "Cancel",
  description: "Stop a job: waiting, it is taken out; running, its render is stopped on its machine. This token's own jobs and the ones the user queued; another token's are refused.",
  input: { job: z.string().min(1) },
  async run({ job: id }, ctx) {
    const row = await jobRow(ctx.s, id);
    await mayTouch(ctx.s, ctx, row);
    if (!(await ctx.s.queue.cancel(id))) throw httpError(`“${row.label}” is not waiting or running: it ended (${row.status}).`);
    ctx.said(`Cancelled “${row.label}”`);
    return { cancelled: id, was: row.status === "running" ? "running" : "waiting" };
  },
});

const retry = tool({
  name: "retry",
  scope: "make",
  title: "Do again",
  description: "A finished, failed or cancelled job queued again as it was sent (a new seed when its seed was random), optionally with some inputs changed (`values`). The same limits as render: renders an hour, and Spend for a rented pod.",
  input: { job: z.string().min(1), values: z.record(z.string(), z.unknown()).optional().describe("Inputs by id to change for this one.") },
  async run({ job: id, values }, ctx) {
    const { s, token } = ctx;
    const row = await jobRow(s, id);
    await mayTouch(s, ctx, row);
    if (row.status === "queued" || row.status === "running") throw httpError(`“${row.label}” has not ended yet: it is ${row.status === "running" ? "running" : "waiting"}.`);
    const at = await seen(s);
    const pinned = row.pin_machine ? at.machines.find((m) => m.machine.id === row.pin_machine)?.machine : undefined;
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      // a timeline's cut or export is no render of a form: its limits are a render's all the same
      const recipe: Recipe<any> | undefined = s.registry.recipe(row.recipe_id);
      await mayQueue(s, ctx, at, { recipe: row.recipe_id, input: { ...readJson<Record<string, unknown>>(row.inputs, {}), ...values }, takes: 1, machine: pinned, renders: !row.warm });
      const again = await s.queue.again(id, values ?? {}, { mcpToken: token.id });
      ctx.said(`Queued “${row.label}” again${recipe ? "" : ` (${row.recipe_id})`}`);
      return { job: again };
    });
  },
});

const pauseArgs = { machine: z.string().optional().describe("A machine's id or name (overview); left out, every machine.") };

const pauseMachine = tool({
  name: "pause_machine",
  scope: "make",
  title: "Pause",
  description: "Pause a machine (it ends what it renders and takes nothing new) or, with no machine, the whole queue. Nothing is lost: resume_machine goes on.",
  input: pauseArgs,
  async run({ machine }, ctx) {
    const m = machine ? machineOf(await seen(ctx.s), machine) : undefined;
    await ctx.s.queue.setPaused(true, m?.id);
    ctx.said(m ? `Paused ${machineName(m)}` : "Paused the queue");
    return { paused: m ? machineName(m) : "every machine" };
  },
});

const resumeMachine = tool({
  name: "resume_machine",
  scope: "make",
  title: "Resume",
  description: "Resume a paused machine or, with no machine, the whole queue.",
  input: pauseArgs,
  async run({ machine }, ctx) {
    const m = machine ? machineOf(await seen(ctx.s), machine) : undefined;
    await ctx.s.queue.setPaused(false, m?.id);
    ctx.said(m ? `Resumed ${machineName(m)}` : "Resumed the queue");
    return { resumed: m ? machineName(m) : "every machine" };
  },
});

export const RENDER_TOOLS = [render, queueStatus, job, cancel, retry, pauseMachine, resumeMachine, loadModel];
