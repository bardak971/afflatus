import { plural } from "@afflatus/core";
import { z } from "zod";
import { httpError } from "./errors";
import { askSchema, changeSchema, rankSchema, type HuntState } from "./hunt";
import { oneAtATime } from "./keyedLock";
import { machineName, machineOf, seen, spends } from "./mcpForms";
import { mayStart } from "./mcpMachines";
import { jobRow, madeOwn, mayMove, mayTouch, podsUp } from "./mcpRender";
import { quoted, tool, type ToolCtx } from "./mcpTool";
import { refusal } from "./mcpTokens";
import { dollars } from "./notifyWords";
import { needsComfy } from "./queueOffline";
import { runningRate } from "./runpod";
import type { Services } from "./services";
import { deploySchema, readSettings } from "./settings";

/**
 * The queue's own controls and the GPU hunt, from outside (MCP): the waiting jobs put in order, one moved to a machine
 * ("Run on") or every one sent to one machine ("Use only"), the waiting ones cancelled at once, the models unloaded; and
 * Hunt a GPU started, changed, cancelled and ranked. Each goes through the route's own code (queue.ts, hunt.ts).
 *
 * A money path (memory money-paths-critical). What sends waiting work onto a rented pod (run_on, use_only, run_on "any"
 * while pods are up) needs Spend and room in the token's cap with the moved jobs counted (mcpRender.ts mayMove); the
 * user's jobs a token moves there become its own, counted as its own from then on. Unloading a pod's models makes its next
 * render load them again, billed: Spend. A hunt deploys a pod by itself: start_hunt needs Spend and room in the token's
 * cap and the app's for a pod at its ceiling; its pod is then the token's run (counted whole, stopped at its cap) and its
 * deploy is asked of the caps again once a GPU is found (hunt.ts mayDeploy). A token cancels its own jobs and the user's,
 * never another token's; it changes only a hunt it started, and cancels its own or the user's. The checks and the moves
 * go one call at a time per token, with its renders (`mcp-render:<token>`).
 */

/** The waiting jobs, in the queue's order. */
const waitingRows = (s: Services) => s.db.selectFrom("jobs").selectAll().where("status", "=", "queued").orderBy("priority").orderBy("created_at").execute();

const orderQueue = tool({
  name: "order_queue",
  scope: "make",
  title: "Order the queue",
  description: "Put waiting jobs first, in this order, as dragging rows in Queue does: the jobs named go to the front in the order given, the others keep theirs behind them. A clip still waits for the clip it continues, wherever it is put. queue_status gives the ids.",
  input: { jobs: z.array(z.string().min(1).max(64)).min(1).max(500).describe("Waiting jobs' ids, first to run first.") },
  async run({ jobs }, ctx) {
    const { s } = ctx;
    const waiting = new Set((await waitingRows(s)).map((r) => r.id));
    const known = jobs.filter((id) => waiting.has(id));
    if (!known.length) throw httpError("None of these jobs is waiting: queue_status lists those that are.");
    await s.queue.reorder(known);
    const notWaiting = jobs.filter((id) => !waiting.has(id));
    ctx.said(`Ordered the queue: ${plural(known.length, "job")} first`);
    return { first: known, ...(notWaiting.length ? { notWaiting } : {}) };
  },
});

const runOn = tool({
  name: "run_on",
  scope: "make",
  title: "Run on",
  description: "Move a waiting job to a machine (pinned there, as Run on or dragging it onto a lane does), or with machine \"any\" back to whichever the queue picks. This token's jobs and the user's; another token's are refused. Onto a rented pod, or to \"any\" with the user's job while pods are up, it needs Spend and room in this token's spend cap with the job counted there; a job of the user's moved onto a pod becomes this token's (its spend, its Queue row).",
  input: {
    job: z.string().min(1),
    machine: z.string().min(1).describe("A machine's id or name (overview), or \"any\"."),
  },
  async run({ job: id, machine }, ctx) {
    const { s, token } = ctx;
    const row = await jobRow(s, id);
    await mayTouch(s, ctx, row);
    if (row.status !== "queued") throw httpError(`${quoted(row.label)} is not waiting (${row.status === "running" ? "it runs" : `it ended: ${row.status}`}): only a waiting job is moved.`);
    const at = await seen(s);
    const machines = at.machines.map((m) => m.machine);
    const to = machine.toLowerCase() === "any" ? null : machineOf(at, machine);
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      // pinned to a pod: it goes there; let go: to any pod up the queue may pick
      const onto = to ? (to.rented ? [to] : []) : podsUp(s, machines);
      const own = await mayMove(s, ctx, [row], onto, { machines, pinned: Boolean(to), what: to ? `running ${quoted(row.label)} on ${quoted(machineName(to))}` : `letting ${quoted(row.label)} go to any machine` });
      await madeOwn(s, token.id, own);
      if (!(await s.queue.pin(id, to?.id ?? null))) throw httpError(`${quoted(row.label)} is not waiting any more: only a waiting job is moved.`);
      ctx.said(to ? `Moved ${quoted(row.label)} to ${quoted(machineName(to))}` : `Let ${quoted(row.label)} go to any machine`);
      return { job: id, on: to ? machineName(to) : "whichever the queue picks", ...(own.length ? { said: "It was the user's: it is this token's from now, its time on the pod counted against this token's spend cap." } : {}) };
    });
  },
});

const useOnly = tool({
  name: "use_only",
  scope: "make",
  title: "Use only",
  description: "Every other machine paused and this one going, as Queue's \"Use only\" does: everything waiting goes to it (a render under way elsewhere ends first). resume_machine undoes it. Onto a rented pod it needs Spend and room in this token's spend cap with every waiting job that would go there counted; the user's among them become this token's (its spend, their Queue rows). Another token's jobs keep their own rules.",
  input: { machine: z.string().min(1).describe("A machine's id or name (overview).") },
  async run({ machine }, ctx) {
    const { s, token } = ctx;
    const at = await seen(s);
    const machines = at.machines.map((m) => m.machine);
    const to = machineOf(at, machine);
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      let own: string[] = [];
      if (to.rented) {
        // every machine of the user's own paused: what waits, and what the user queues next, goes to the pod
        if (!spends(ctx)) throw refusal(`This token cannot spend on rented GPUs, and using only ${quoted(machineName(to))} would send the queue's work onto it: tick Spend on it in Settings › Access.`);
        // what would go there: waiting work for a ComfyUI, not pinned elsewhere, this token's or the user's
        const rows = (await waitingRows(s)).filter((r) => needsComfy(r) && (!r.pin_machine || r.pin_machine === to.id) && (!r.mcp_token_id || r.mcp_token_id === token.id));
        own = await mayMove(s, ctx, rows, [to], { machines, pinned: true, what: `using only ${quoted(machineName(to))}` });
        await madeOwn(s, token.id, own);
      }
      await s.queue.useOnly(to.id);
      ctx.said(`Used only ${quoted(machineName(to))}`);
      return { using: machineName(to), paused: machines.filter((m) => m.id !== to.id).map(machineName), ...(own.length ? { said: `${plural(own.length, "job")} of the user's are this token's from now, their time on the pod counted against its spend cap.` } : {}) };
    });
  },
});

const cancelWaiting = tool({
  name: "cancel_waiting",
  scope: "make",
  title: "Cancel all waiting",
  description: "Cancel every waiting job at once, as Queue's \"Cancel all waiting\" does: this token's and the user's (with mine, this token's only); another token's are left. What runs goes on (cancel stops one).",
  input: { mine: z.boolean().optional().describe("Only this token's own jobs.") },
  async run({ mine }, ctx) {
    const { s, token } = ctx;
    const rows = await waitingRows(s);
    const ids = rows.filter((r) => r.mcp_token_id === token.id || (!mine && !r.mcp_token_id)).map((r) => r.id);
    const cancelled = ids.length ? await s.queue.cancelWaiting(ids) : 0;
    const left = rows.length - ids.length;
    ctx.said(`Cancelled ${plural(cancelled, "waiting job")}${left ? `, ${left} left (${mine ? "not this token's" : "another token's"})` : ""}`);
    return { cancelled, ...(left ? { left, said: mine ? "Jobs not queued by this token are left." : "Jobs queued by another token are left: that token's, or the user's in Afflatus, to cancel." } : {}) };
  },
});

const unloadModels = tool({
  name: "unload_models",
  scope: "make",
  title: "Unload the models",
  description: "Unload the models now, as Queue's Unload does (the GPU's memory is wanted for something else): on a machine, or on every one that is not rendering. Refused where a render is under way. The next render loads what it needs again: on a rented pod that load is billed, so a pod needs Spend.",
  input: { machine: z.string().optional().describe("A machine's id or name (overview); left out, every machine not rendering.") },
  async run({ machine }, ctx) {
    const { s } = ctx;
    const at = await seen(s);
    const m = machine ? machineOf(at, machine) : undefined;
    const up = podsUp(s, m ? [m] : at.machines.map((x) => x.machine))[0];
    if (up && !spends(ctx)) throw refusal(`This token cannot spend on rented GPUs, and unloading the models on ${quoted(machineName(up))} makes its next render load them again, billed: tick Spend on it in Settings › Access${m ? "" : ", or name a machine of the user's own"}.`);
    await s.queue.freeMemory(m?.id);
    ctx.said(m ? `Unloaded the models on ${quoted(machineName(m))}` : "Unloaded the models");
    return { unloaded: m ? machineName(m) : "every machine not rendering" };
  },
});

export const QUEUE_TOOLS = [orderQueue, runOn, useOnly, cancelWaiting, unloadModels];

// ---------------------------------------------------------------- the GPU hunt

const modeArg = z.enum(["value", "fast", "cheap"]).describe("value: the best time for the money; fast: the quickest; cheap: the lowest price.");
const ceilingArg = z.number().positive().max(1000).describe("The most an hour for the GPU (USD).");
const leftOutArg = z.array(z.string().max(120)).max(200).describe("GPU ids never taken.");

/** Who started the hunt, as the tools say it. */
async function startedBy(s: Services, st: HuntState, ctx: ToolCtx): Promise<string> {
  if (!st.mcpToken) return "the user";
  if (st.mcpToken === ctx.token.id) return "this token";
  return `another token (${(await s.mcp.tokens.get(st.mcpToken))?.name ?? "one gone since"})`;
}

/** The hunt as the tools say it: its state, its choices, the GPUs as last ranked. */
async function huntSaid(s: Services, ctx: ToolCtx, view: ReturnType<Services["hunt"]["view"]>, ranked = 10) {
  const st = view.hunt;
  return {
    hunt: st ? {
      status: st.status, mode: st.mode, ceiling: st.ceiling, leftOut: st.leftOut, hold: st.hold, cloud: st.cloud, startedAt: st.startedAt, giveUpAt: st.giveUpAt,
      startedBy: await startedBy(s, st, ctx), asks: st.asks, ...(st.lastError ? { lastError: st.lastError } : {}),
      ...(st.machine ? { machine: st.machine } : {}), ...(st.found ? { found: { gpu: st.found.name, usdPerHour: st.found.price, dataCenter: st.found.dataCenter } } : {}),
      deploy: { template: st.deploy.template, volume: st.deploy.volume, disk: st.deploy.disk, idleMinutes: st.deploy.idleMinutes, idleDo: st.deploy.idleDo, watchdogMinutes: st.deploy.watchdogMinutes, set: st.deploy.set },
    } : null,
    ranking: view.ranking?.slice(0, ranked).map(rankedSaid) ?? null,
    ...(view.askedAt ? { askedAt: view.askedAt } : {}),
  };
}

const rankedSaid = (g: NonNullable<ReturnType<Services["hunt"]["view"]>["ranking"]>[number]) => ({
  rank: g.rank, gpu: g.id, name: g.name, usdPerHour: g.price, usable: g.fit === "yes", ...(g.fit !== "yes" ? { why: g.fits } : {}), stock: g.stock,
  ...(g.seconds !== null ? { secondsEach: Math.round(g.seconds) } : {}), ...(g.cost !== null ? { usdEach: Math.round(g.cost * 1000) / 1000 } : {}), time: g.timeSaid,
});

const hunt = tool({
  name: "hunt",
  scope: "look",
  title: "GPU hunt",
  description: "Hunt a GPU, read: the hunt under way (none: null) with its state (hunting, deploying, up), its choices, who started it and what it found, and the GPUs as it last ranked them for the renders waiting (price, usable or why not, how free, the time and cost of a render there). With `rank`, the ranking for those choices now, as the Hunt dialog shows it as it is filled (RunPod read at most every 20 s), hunt or not.",
  input: {
    rank: z.object({
      mode: modeArg.optional(), ceiling: ceilingArg, leftOut: leftOutArg.optional(),
      cloud: z.enum(["SECURE", "COMMUNITY"]).optional(), volume: z.string().max(80).optional(), cuda: z.enum(["13.0", "12.8", "either"]).optional(), template: z.enum(["afflatus", "runpod"]).optional(),
    }).optional(),
  },
  async run({ rank }, ctx) {
    const { s } = ctx;
    if (rank) {
      const r = await s.hunt.preview(rankSchema.parse(rank));
      ctx.said(`Ranked the GPUs for ${plural(r.held, "render")} waiting`);
      return { ranking: r.ranking.map(rankedSaid), rendersWaiting: r.held, ...(r.overhead ? { eachDeployBillsBesides: { bootMs: r.overhead.bootMs, fetchMs: r.overhead.fetchMs, idleMs: r.overhead.idleMs } } : {}) };
    }
    const view = s.hunt.view();
    ctx.said(view.hunt ? `Looked at the GPU hunt: ${view.hunt.status}` : "Looked at the GPU hunt: none");
    return huntSaid(s, ctx, view);
  },
});

/**
 * What a pod at this price bills an hour while it runs, as deploy_pod counts it: its GPU and its container disk (kept small
 * with a volume: rentedDeploy.ts).
 */
const hourOf = (price: number, deploy: { volume: string; disk: number }) => runningRate(price, deploy.volume ? Math.min(deploy.disk, 40) : deploy.disk, 0);

/** The hunt under way, refused when there is none or it is another's to change. */
async function ownHunt(s: Services, ctx: ToolCtx, what: string, userToo: boolean): Promise<HuntState> {
  const st = s.hunt.view().hunt;
  if (!st) throw httpError("No GPU hunt is under way.", 404);
  if (st.mcpToken === ctx.token.id || (userToo && !st.mcpToken)) return st;
  throw refusal(`This hunt was started by ${await startedBy(s, st, ctx)}: ${what} it in Afflatus${st.mcpToken ? ", or with that token" : ""}.`);
}

const startHunt = tool({
  name: "start_hunt",
  scope: "spend",
  title: "Hunt a GPU",
  description: "Start a GPU hunt, as Queue's Hunt a GPU does: RunPod's stock is asked every 30 s and the best-ranked usable GPU at or under the ceiling is deployed the moment one is free, once, while renders wait for it. hold rest pauses the user's own machines meanwhile (resumed when it ends); keep lets them render on. Deploy choices as deploy_pod (the last deploy's when left out; idle 3 min then terminate here). Refused when this token's cap or the app's caps have no room for a pod's first hour at the ceiling; once found, its deploy is asked of the caps again, and refused it ends the hunt. The pod's whole run then counts against this token's cap, and it stops once that is reached. It gives up at its time, at a cap, or after three refused deploys.",
  input: {
    ceiling: ceilingArg,
    mode: modeArg.optional(),
    leftOut: leftOutArg.optional(),
    giveUpMinutes: z.number().int().min(10).max(24 * 60).optional().describe("When it gives up, minutes from now (120 when left out)."),
    hold: z.enum(["rest", "keep"]).optional().describe("rest (the default): the user's own machines paused until it ends; keep: they render on."),
    cloud: z.enum(["SECURE", "COMMUNITY"]).optional(),
    template: z.enum(["afflatus", "runpod"]).optional(),
    volume: z.string().max(80).optional().describe("A network volume's id; empty: none."),
    disk: z.number().int().min(20).max(2000).optional().describe("Its container disk, GB."),
    idleMinutes: z.number().int().min(1).max(120).optional().describe("Minutes with nothing to render, then idleDo (3 when left out)."),
    idleDo: z.enum(["stop", "terminate"]).optional(),
    watchdogMinutes: z.number().int().min(1).max(120).optional(),
    set: z.string().max(80).optional().describe("A Model set's id (model_sets): its files are fetched onto it."),
    cuda: z.enum(["13.0", "12.8", "either"]).optional(),
  },
  async run(a, ctx) {
    const { s, token } = ctx;
    const last = (await readSettings(s.db)).lastDeploy;
    // as deploy_pod asks it: the last deploy's choices, an idle stop and a watchdog always, no licence accepted from here
    const deploy = deploySchema.omit({ gpu: true }).parse({
      ...(last ?? {}), cloud: a.cloud ?? last?.cloud ?? "SECURE",
      ...(a.template ? { template: a.template } : {}), ...(a.volume !== undefined ? { volume: a.volume } : {}), ...(a.disk ? { disk: a.disk } : {}),
      idleMinutes: a.idleMinutes ?? 3, idleDo: a.idleDo ?? "terminate", watchdogMinutes: a.watchdogMinutes ?? Math.min(last?.watchdogMinutes || 15, 120),
      set: a.set ?? "", ...(a.cuda ? { cuda: a.cuda } : {}),
      files: [], leaveOut: [], accept: [], again: Boolean(a.set), cudaOnce: false,
    });
    const asked = askSchema.parse({ mode: a.mode, ceiling: a.ceiling, leftOut: a.leftOut, giveUpMinutes: a.giveUpMinutes, hold: a.hold, deploy });
    const hour = hourOf(a.ceiling, deploy);
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      await mayStart(s, token, hour, `a hunt deploys a GPU of up to ${dollars(hour)} an hour`, `a pod found by the hunt, at its ceiling`);
      const view = await s.hunt.start(asked, token.id);
      ctx.said(`Started a GPU hunt (${asked.mode}, at most ${dollars(asked.ceiling)}/h, ${asked.hold === "rest" ? "the user's machines resting" : "the user's machines rendering on"})`);
      return { ...(await huntSaid(s, ctx, view)), said: `Hunting. The pod it deploys counts whole against this token's cap (${dollars(token.spendCapCents / 100)} a month), and its deploy is asked of the caps again when a GPU is found.` };
    });
  },
});

const changeHunt = tool({
  name: "change_hunt",
  scope: "spend",
  title: "Change the hunt",
  description: "Change a hunt this token started: its mode, ceiling, GPUs left out, time (minutes from its start) or hold. A higher ceiling is asked of this token's cap and the app's caps as start_hunt asks it. A hunt the user or another token started is theirs to change.",
  input: {
    mode: modeArg.optional(), ceiling: ceilingArg.optional(), leftOut: leftOutArg.optional(),
    giveUpMinutes: z.number().int().min(10).max(24 * 60).optional().describe("When it gives up, minutes from its start."),
    hold: z.enum(["rest", "keep"]).optional(),
  },
  async run(a, ctx) {
    const { s, token } = ctx;
    const asked = changeSchema.parse(a);
    return oneAtATime(s.db, `mcp-render:${token.id}`, async () => {
      const st = await ownHunt(s, ctx, "change", false);
      if (asked.ceiling !== undefined && asked.ceiling > st.ceiling) {
        const hour = hourOf(asked.ceiling, st.deploy);
        await mayStart(s, token, hour, `a hunt deploys a GPU of up to ${dollars(hour)} an hour`, "a pod found by the hunt, at its new ceiling");
      }
      const view = await s.hunt.change(asked, token.id);
      ctx.said(`Changed the GPU hunt: ${Object.keys(a).join(", ") || "nothing"}`);
      return huntSaid(s, ctx, view);
    });
  },
});

const cancelHunt = tool({
  name: "cancel_hunt",
  scope: "spend",
  title: "Cancel the hunt",
  description: "Cancel the GPU hunt: the machines it paused go on. This token's hunt or the user's; another token's is refused. Refused while its GPU is being deployed (the pod is billed from its first second: stop it with stop_pod once it is up). A pod it deployed already is a machine like any.",
  async run(_args, ctx) {
    const { s } = ctx;
    await ownHunt(s, ctx, "cancel", true);
    await s.hunt.cancel();
    ctx.said("Cancelled the GPU hunt");
    return { cancelled: true };
  },
});

export const HUNT_TOOLS = [hunt, startHunt, changeHunt, cancelHunt];
