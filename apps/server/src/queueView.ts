import { SqliteAdapter, sql, type Expression } from "kysely";
import { modelName, modelOf, type JoinKind, joinKindOf } from "@afflatus/core";
import type { Comfy } from "./comfy";
import type { Lack } from "./machineScans";
import { finishForecast, usesGpu } from "./queueTools";
import type { CutOptions } from "./timelines";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";
import { readJson, type JobRow, type QueueCore, type Resume } from "./queueModel";
import type { Db } from "./db";
import type { Machine } from "./settings";

/** What the queue screen shows: the line as it stands with the running job's progress, the history of finished jobs, and a live preview. */

/** What a job is, as the queue screen tells them apart. */
const kindOf = (r: Pick<JobRow, "recipe_id" | "warm">) => (r.recipe_id === EXPORT_JOB ? ("export" as const) : r.recipe_id === CUT_JOB ? ("cut" as const) : r.warm ? ("load" as const) : ("render" as const));
/** A job's inputs as the screen reads them: a render's form (a tool job's options are not one); empty when the row cannot be read. */
const inputsOf = (r: Pick<JobRow, "recipe_id" | "inputs">) => (r.recipe_id === EXPORT_JOB || r.recipe_id === CUT_JOB ? {} : readJson<Record<string, unknown>>(r.inputs, {}));
/** What a finish upscales with, by name (SeedVR2, RTX VSR, the upscale model's file); null for any other job. */
const upscalerOf = (r: Pick<JobRow, "recipe_id" | "inputs">): string | null => {
  if (r.recipe_id !== CUT_JOB) return null;
  const o = readJson<{ action?: string; route?: string; upscaleModel?: string }>(r.inputs, {});
  if (o.action !== "finish") return null;
  if (o.route === "rtx") return "RTX VSR";
  if (o.route === "model") return o.upscaleModel ? o.upscaleModel.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") : "upscale model";
  return "SeedVR2";
};

/** Spilling out of video memory: the memory full and twice what was expected already gone (see renders.spilled). */
async function spillingNow(core: QueueCore): Promise<boolean> {
  const r = core.running;
  if (!r?.gpu || !r.expectedMs || !r.startedAt || Date.now() - r.startedAt < 2 * r.expectedMs) return false;
  const load = await (await core.comfy()).load().catch(() => null);
  return Boolean(load?.gpus.some((g) => g.vramPercent >= 95));
}

const FINISHED = ["done", "failed", "cancelled"] as const;
/**
 * The status column, as the finished-jobs lists test it. On SQLite it is written `+status`, which keeps the planner off
 * jobs_by_status: nearly every job is finished, so that index finds them all and then sorts them, where jobs_by_finish
 * reads them already in order and stops at the page. Postgres plans from its own figures and has no such form.
 */
const statusOf = (db: Db): Expression<string> => (db.getExecutor().adapter instanceof SqliteAdapter ? sql<string>`+status` : sql.ref<string>("status"));

/** A number of milliseconds as said: rounded, null when not known (or after a job whose end cannot be told). */
const finite = (ms: number | undefined): number | null => (ms !== undefined && Number.isFinite(ms) ? Math.round(ms) : null);

/** A lane as the screens read it: its machine (null for the lane of the jobs that need no ComfyUI), its queue, whether it is paused on its own and answered when last asked. */
export interface LaneView {
  machine: Machine | null;
  core: QueueCore;
  paused: boolean;
  reachable: boolean | null;
  /** Its ComfyUI answered, but locked against the token Afflatus has for it. */
  locked: boolean;
}

export async function status(
  core: QueueCore, lanes: LaneView[] = [{ machine: null, core, paused: false, reachable: null, locked: false }], paused = core.paused,
  /** Where each waiting job will probably run and when it starts (schedule.ts plan), and each machine's learned pace. */
  planned: ReadonlyMap<string, { lane: string; startsInMs: number }> = new Map(), paces: ReadonlyMap<string, number> = new Map(),
  /** With several machines, the machines that can run each waiting render (queue.ts ableOf). */
  able: ReadonlyMap<string, { can: ReadonlySet<string>; lacks: Record<string, Lack> }> = new Map(),
) {
  const rows = await core.db
    .selectFrom("jobs")
    .selectAll()
    .where("status", "in", ["queued", "running"])
    .orderBy("priority")
    .orderBy("created_at")
    .execute();
  const recent = await core.db
    .selectFrom("jobs")
    .selectAll()
    .where(statusOf(core.db), "in", FINISHED)
    .orderBy("finished_at", "desc")
    .limit(20)
    .execute();
  const finishes = await finishesWaiting(core, rows);
  const renders = await rendersWaiting(core, rows);
  // a waiting job's forecast at the pace of the machine it will probably run on
  const estimate = (r: JobRow) => {
    const ms = (r.status === "queued" && (finishes.get(r.id) ?? renders.get(r.id))) || null;
    const on = planned.get(r.id)?.lane;
    return ms && on ? Math.round(ms * (paces.get(on) ?? 1)) : ms;
  };
  const brief = (r: JobRow) => ({ ...plain(r), estimateMs: estimate(r) });
  /** The machines that can run a waiting render, when that is not all of them; null when every one can. */
  const machineIds = lanes.flatMap((l) => (l.machine ? [l.machine.id] : []));
  const onlyOn = (id: string): string[] | null => {
    const can = able.get(id)?.can;
    return can && machineIds.some((m) => !can.has(m)) ? machineIds.filter((m) => can.has(m)) : null;
  };
  /** How a clip render joins the clip before, once its graph is built: in the latent, or on pinned frames; null when it starts on its own or is not a clip. */
  const joinOf = (r: JobRow): JoinKind | null => {
    if (!r.clip_id || !r.resume) return null;
    return joinKindOf(readJson<Partial<Resume>>(r.resume, {}).overlap);
  };
  const plain = (r: JobRow) => ({
    id: r.id, recipe: r.recipe_id, label: r.label, status: r.status, error: r.error, warning: r.warning ?? null, generationId: r.generation_id, clipId: r.clip_id, draftId: r.draft_id, join: joinOf(r),
    kind: kindOf(r),
    upscaler: upscalerOf(r),
    // what a failed job was asked: a retry can change it (a smaller size after running out of memory)
    input: r.status === "failed" && kindOf(r) !== "export" && kindOf(r) !== "cut" ? inputsOf(r) : null,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    /** The machine it runs or ran on, or for a waiting job the one it will probably run on; the one it was pinned to by hand (null: whichever the queue picks). */
    machine: r.machine_id ?? planned.get(r.id)?.lane ?? null,
    pinned: r.pin_machine ?? null,
    /** Of a waiting job: in about how long it starts, when that can be told. */
    startsInMs: r.status === "queued" ? finite(planned.get(r.id)?.startsInMs) : null,
    /** Of a waiting render, when not every machine can run it: the ones that have its files (empty: none). */
    runsOn: r.status === "queued" ? onlyOn(r.id) : null,
    /** Of such a render: what keeps it off each other machine (its family off there, the files it lacks there), by machine id. */
    lacks: r.status === "queued" && onlyOn(r.id) ? able.get(r.id)?.lacks ?? null : null,
  });
  const idle = (r: JobRow) => (r.recipe_id === EXPORT_JOB ? ("exporting" as const) : r.recipe_id === CUT_JOB ? ("cutting" as const) : ("waiting" as const));
  /** A running job with its figures, from its lane's monitor; a job a ComfyUI had when this process last stopped, not picked up again yet, has none. */
  const card = async (r: JobRow, lane: LaneView | null) => {
    const own = lane?.core.running?.id === r.id ? lane.core.running : null;
    const monitor = own && lane ? (await lane.core.comfy()).monitor : null;
    // the seed it was built with, once sent: from memory, or from the job when another process sent it
    const seed = own?.seed ?? readJson<Partial<Resume>>(r.resume, {}).seed ?? null;
    return { ...brief(r), seed, ...figures(monitor, own, own?.promptId, idle(r)), spilling: own && lane ? await spillingNow(lane.core) : false };
  };
  const ran = rows.filter((r) => r.status === "running");
  const cards = await Promise.all(lanes.map((l) => {
    const r = l.core.running ? ran.find((x) => x.id === l.core.running!.id) : undefined;
    return r ? card(r, l) : null;
  }));
  const shown = cards.find((c) => c !== null) ?? null;
  const stray = ran.find((r) => !cards.some((c) => c?.id === r.id));
  const running = shown ?? (stray ? await card(stray, null) : null);
  const machines = lanes.flatMap((l, i) => {
    if (!l.machine) return [];
    const c = l.core;
    return [{
      id: l.machine.id, name: l.machine.name, url: l.machine.url, takes: l.machine.takes,
      paused: l.paused,
      /** Whether it answered when last asked (null before it was asked: nothing was waiting for it). */
      online: l.reachable ?? (core.offlineSince === null ? null : false),
      /** Offline because it is locked against Afflatus's token (Settings › ComfyUI: paste its token), not because it is away. */
      locked: l.locked,
      model: c.lastLoads === null ? null : c.lastModel,
      /** Its learned pace against the others (1 the common pace, 2 half as fast); null with nothing to compare yet. */
      pace: paces.get(l.machine.id) ?? null,
      running: cards[i] ?? null,
    }];
  });
  return {
    /** Pause all; each machine says its own in `machines`. */
    paused,
    /** The model the first ComfyUI was last asked to load, by name. Null when none is, or when it is not known. */
    model: core.lastLoads === null ? null : core.lastModel,
    online: core.offlineSince === null,
    offlineForMs: core.offlineSince ? Date.now() - core.offlineSince : 0,
    /** The first running job (the screens that show one); every machine's is in `machines`. */
    running,
    machines,
    /** The job that needs no ComfyUI running beside them (an export, a cut by ffmpeg), when one is. */
    tool: lanes.flatMap((l, i) => (l.machine ? [] : [cards[i] ?? null])).find(Boolean) ?? null,
    waiting: rows.filter((r) => r.status === "queued").map(brief),
    recent: recent.map(brief),
  };
}

/** What each waiting render should take (the forecast, queue.expected), by job, in the line's order: down the line, a job whose model is not the one before it has to load it first. */
async function rendersWaiting(core: QueueCore, rows: JobRow[]): Promise<Map<string, number | null>> {
  let held = core.lastLoads === null ? null : new Set(core.lastLoads.split("|").map(modelName));
  const asked: Array<Promise<[string, number | null]>> = [];
  for (const r of rows) {
    if (r.status !== "queued") continue;
    // a tool on the GPU frees the model before it: the render after it loads its own again
    if (held && usesGpu(r)) held = new Set();
    const recipe = core.registry.recipe(r.recipe_id);
    if (!recipe || r.warm) continue;
    const input = inputsOf(r);
    const model = modelOf(recipe.inputs, input);
    const cold = Boolean(model && held && !held.has(model));
    if (model) held = new Set([model]);
    asked.push(core.expected(recipe, input, cold, r).then((ms) => [r.id, ms]));
  }
  return new Map(await Promise.all(asked));
}

/** What each waiting finish should take (finishForecast), by job; a finish whose video is gone is left out. */
async function finishesWaiting(core: QueueCore, rows: JobRow[]): Promise<Map<string, number | null>> {
  const asked = rows.flatMap((r) => {
    const o = r.status === "queued" && r.recipe_id === CUT_JOB ? readJson<CutOptions | null>(r.inputs, null) : null;
    return o?.action === "finish" ? [{ id: r.id, o }] : [];
  });
  const out = new Map<string, number | null>();
  if (!asked.length) return out;
  const videos = new Map((await core.db.selectFrom("assets").select(["id", "width", "height", "duration_ms", "fps"]).where("id", "in", [...new Set(asked.map((a) => a.o.asset))]).execute()).map((v) => [v.id, v]));
  const paces = new Map<string, Promise<number | null>>();
  for (const { id, o } of asked) {
    const v = videos.get(o.asset);
    if (v) out.set(id, await finishForecast(core.db, { width: v.width, height: v.height, durationMs: v.duration_ms, fps: v.fps }, o, paces));
  }
  return out;
}

/** The running job's progress, its preview and what it showed on the way: from the monitor, by its prompt; `idle` names its phase while it has none. */
function figures(monitor: Comfy["monitor"] | null, running: QueueCore["running"], promptId: string | undefined, idle: "exporting" | "cutting" | "waiting") {
  // no monitor (a job this process does not follow yet) or no prompt: nothing to read but its phase
  const m = promptId && monitor ? { monitor, promptId } : null;
  return {
    // a tool on ComfyUI (a finish, a slow motion): which step runs, not a step count (its one-step passes would read 99 % at once)
    // its ETA what its own record expected of it (finishForecast for a finish), less the time it has run
    ...(m && idle === "cutting" ? { ...m.monitor.progress(m.promptId), progress: 0, eta: toolEta(running), step: 0, steps: 0 } : m ? m.monitor.progress(m.promptId) : { progress: 0, eta: 0, phase: idle, step: 0, steps: 0 }),
    previewSeq: m ? m.monitor.preview(m.promptId).seq : 0,
    previewMime: m ? m.monitor.preview(m.promptId).mime ?? null : null,
    // what the workflow showed on the way (its Preview nodes), oldest first; the title comes from the graph it was built with
    stages: (m ? m.monitor.stages(m.promptId) : []).map((st, n) => ({ n, node: st.node, title: running?.titles?.[st.node] ?? null, count: st.files.length })),
  };
}

/** A tool's seconds left on ComfyUI, from what its record expected of it; 0 (no ETA shown) when nothing was expected or it ran past it. */
const toolEta = (r: QueueCore["running"]) => (r?.expectedMs && r.startedAt ? Math.max(0, Math.round((r.expectedMs - (Date.now() - r.startedAt)) / 1000)) : 0);

/**
 * The running jobs' figures alone, read from memory and the monitors (no query): what each progress event carries, up to
 * four times a second. The first running job's at the top (the screens that show one), every one's in `all`. Null when nothing runs.
 */
export async function progress(lanes: LaneView[]) {
  const all = [];
  for (const lane of lanes) {
    const run = lane.core.running;
    if (!run) continue;
    all.push({ id: run.id, machine: lane.machine?.id ?? null, ...figures((await lane.core.comfy()).monitor, run, run.promptId, run.tool ?? "waiting"), seed: run.seed ?? null, spilling: await spillingNow(lane.core) });
  }
  return all.length ? { ...all[0]!, all } : null;
}

/** One picture a node of the running job showed on the way (stage `n`, its first file), fetched from ComfyUI. */
export async function stage(core: QueueCore, jobId: string, n: number) {
  if (core.running?.id !== jobId || !core.running.promptId || !Number.isInteger(n) || n < 0) return null;
  const comfy = await core.comfy();
  const file = comfy.monitor.stages(core.running.promptId)[n]?.files[0];
  if (!file) return null;
  const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "mp4" ? "video/mp4" : ext === "webm" ? "video/webm" : "image/jpeg";
  // a preview is a temporary file: ComfyUI may have cleared it already, which is no error of ours
  const bytes = await comfy.client.view(file).catch(() => null);
  return bytes ? { bytes, mime } : null;
}

/** The running job's latest live preview. */
export async function preview(core: QueueCore, jobId: string) {
  if (core.running?.id !== jobId || !core.running.promptId) return null;
  const p = (await core.comfy()).monitor.preview(core.running.promptId);
  return p.bytes ? { bytes: p.bytes, mime: p.mime ?? "image/jpeg" } : null;
}

/**
 * The finished jobs, newest first, with what each made: for the queue's history. `q` looks in the
 * label and the inputs (the prompt is there), `model` in the inputs too (the model file's name).
 * Counts say how many of each status match the search and the model, so that a filter can show its number.
 */
export async function history(core: QueueCore, opts: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; offset?: number; after?: string; limit?: number } = {}) {
  const { db } = core;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
  const offset = Math.max(0, opts.offset ?? 0);
  // a job that only loaded a model made nothing: not part of the history
  let query = db.selectFrom("jobs").where("warm", "=", 0);
  // the text looked for, as a LIKE pattern: its own %, _ and \ made literal with a backslash, which the clause then names as
  // the escape character (SQLite has none by default; the clause reads the same on Postgres). Model files are full of underscores.
  // Both sides in lower case: SQLite's LIKE ignores case, Postgres's does not, and the search is the same on both
  const like = (text: string) => `%${text.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (opts.q?.trim()) {
    const pattern = like(opts.q);
    query = query.where(sql<boolean>`(lower(label) like ${pattern} escape '\\' or lower(inputs) like ${pattern} escape '\\')`);
  }
  if (opts.model?.trim()) query = query.where(sql<boolean>`lower(inputs) like ${like(opts.model)} escape '\\'`);
  // the counts follow the search and the model, not the status picked: each status chip says what it would show
  const counted = query.where("status", "in", FINISHED);
  query = query.where(statusOf(db), "in", FINISHED);
  if (opts.status) query = query.where(statusOf(db), "=", opts.status);
  // `after`: the page after the job it names (the `next` of the page before), read from the index where that one stopped;
  // `offset` still works, for a caller that counts
  const cursor = cursorOf(opts.after);
  if (cursor) {
    query = query.where((eb) =>
      eb.or([
        eb("finished_at", "<", cursor.finished),
        eb.and([eb("finished_at", "=", cursor.finished), eb.or([eb("created_at", "<", cursor.created), eb.and([eb("created_at", "=", cursor.created), eb("id", "<", cursor.id)])])]),
      ]),
    );
  }
  // only what the list shows: the resume of a job (its built graph, about a kilobyte) stays in the table
  const rows = await query
    .select(["id", "recipe_id", "label", "status", "error", "error_trace", "warning", "warm", "inputs", "generation_id", "clip_id", "draft_id", "created_at", "started_at", "finished_at"])
    .orderBy("finished_at", "desc").orderBy("created_at", "desc").orderBy("id", "desc")
    .limit(limit + 1).offset(cursor ? 0 : offset).execute();
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next = more && last ? [last.finished_at ?? "", last.created_at, last.id].join("|") : null;
  // what each made, and how it was settled
  const genIds = page.map((r) => r.generation_id).filter((g): g is string => Boolean(g));
  const gens = genIds.length ? await db.selectFrom("generations").select(["id", "resolved"]).where("id", "in", genIds).execute() : [];
  const made = genIds.length
    ? await db.selectFrom("assets").select(["id", "generation_id", "kind", "width", "height", "duration_ms", "kept_at", "deleted_at", "name"]).where("generation_id", "in", genIds).where("origin", "!=", "mask").orderBy("created_at").execute()
    : [];
  const counts = Object.fromEntries((await counted.select(["status", (eb) => eb.fn.countAll<number>().as("n")]).groupBy("status").execute()).map((c) => [c.status, Number(c.n)])) as Partial<Record<"done" | "failed" | "cancelled", number>>;
  const items = page.map((r) => {
    const recipe = core.registry.recipe(r.recipe_id);
    const input = inputsOf(r);
    const promptSpec = recipe?.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe?.inputs.find((i) => i.type === "prompt" && i.id !== "negative");
    const prompt = promptSpec && typeof input[promptSpec.id] === "string" ? (input[promptSpec.id] as string).trim().slice(0, 240) : "";
    const resolved = r.generation_id ? readJson<{ seed?: number }>(gens.find((g) => g.id === r.generation_id)?.resolved, {}) : {};
    const tookMs = r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null;
    const kind = kindOf(r);
    return {
      id: r.id, recipe: r.recipe_id, label: r.label, status: r.status, error: r.error, warning: r.warning ?? null, generationId: r.generation_id, clipId: r.clip_id, draftId: r.draft_id,
      kind,
      upscaler: upscalerOf(r),
      input: r.status === "failed" && kind !== "export" && kind !== "cut" ? input : null,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, tookMs,
      // the end of ComfyUI's traceback of a job that failed in a node, for the row's whole error
      trace: r.status === "failed" ? r.error_trace ?? null : null,
      model: recipe ? modelOf(recipe.inputs, input) : null,
      prompt,
      seed: typeof resolved.seed === "number" ? resolved.seed : null,
      // jobs asked for together ("Make 4"): the same form, the same second
      batch: `${r.draft_id ?? ""}|${r.recipe_id}|${r.label}|${r.created_at.slice(0, 19)}`,
      made: made.filter((a) => a.generation_id === r.generation_id).map((a) => ({ id: a.id, kind: a.kind, width: a.width, height: a.height, durationMs: a.duration_ms, kept: a.kept_at !== null, inBin: a.deleted_at !== null, name: a.name })),
    };
  });
  return { items, more, next, counts: { done: counts.done ?? 0, failed: counts.failed ?? 0, cancelled: counts.cancelled ?? 0 } };
}

/** A history page's `next`, read back: when the last job of the page before ended, was asked for, and its id. */
function cursorOf(after: string | undefined): { finished: string; created: string; id: string } | null {
  const [finished, created, id] = (after ?? "").split("|");
  return finished && created && id ? { finished, created, id } : null;
}
