import { createHash } from "node:crypto";
import { SqliteAdapter, sql, type Expression } from "kysely";
import { modelName, modelOf, type JoinKind, joinKindOf } from "@afflatus/core";
import type { Comfy } from "./comfy";
import type { Lack } from "./machineScans";
import type { PodDisk, PodFileView } from "./podFiles";
import type { PodPackView } from "./podPacks";
import type { PackWait } from "./jobPacks";
import { finishForecast, usesGpu } from "./queueTools";
import type { ToolPaces } from "./renders";
import type { CutOptions } from "./timelines";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";
import { readJson, type JobRow, type QueueCore, type Resume } from "./queueModel";
import type { Db } from "./db";
import type { Machine } from "./settings";
import type { RentedView } from "./rentedModel";

/** What a machine row says of a rented pod (rented.ts). */
/** A rented pod's row: its state, and the model files it is getting (podFiles.ts). */
export type RentedRow = RentedView & { files: PodFileView[]; packs: PodPackView[]; /** Its disk as its node pack last said it (0.19.0 on); null: not known. */ disk: PodDisk | null };

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
  /** The prompts its ComfyUI has from outside Afflatus (its own page, another tool), running and waiting; null when not known. */
  outside?: { running: number; pending: number } | null;
  /** Its ComfyUI answered, but locked against the token Afflatus has for it. */
  locked: boolean;
  /** A rented pod: its state and cost (rented.ts); null for a ComfyUI of its own. */
  rented: RentedRow | null;
  /** Of a ComfyUI of its own: the model files downloading into it now, as a pod's are said. */
  files?: PodFileView[];
  /** It takes no job: node packs wait for its ComfyUI to restart, or it restarts now (podPacks.ts holding). */
  packsHold?: boolean;
}

export async function status(
  core: QueueCore, lanes: LaneView[] = [{ machine: null, core, paused: false, reachable: null, locked: false, rented: null }], paused = core.paused,
  /** Where each waiting job will probably run and when it starts (schedule.ts plan), and each machine's learned pace. */
  planned: ReadonlyMap<string, { lane: string; startsInMs: number }> = new Map(), paces: ReadonlyMap<string, number> = new Map(),
  /** With several machines, the machines that can run each waiting render (queue.ts ableOf). */
  able: ReadonlyMap<string, { can: ReadonlySet<string>; lacks: Record<string, Lack>; fetch?: Record<string, { files: Lack["files"]; ms: number }>; startPod?: string }> = new Map(),
  /** Of a waiting job on a machine of the user's own: the node packs it waits for there, and where they stand (queuePacks.ts). */
  packWait: (job: string) => PackWait | undefined = () => undefined,
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
  const finishes = await finishesOf(core.db, rows, lanes.flatMap((l) => (l.machine ? [{ id: l.machine.id, pace: paces.get(l.machine.id) ?? 1 }] : [])));
  const by = await tokensBehind(core.db, rows);
  const renders = await rendersWaiting(core, rows, planned, lanes);
  // a waiting job's forecast on the machine it will probably run on: a render's from that machine's own renders (rendersWaiting),
  // a finish's from that machine's own finishes, else at its pace
  const estimate = (r: JobRow) => {
    if (r.status !== "queued") return null;
    const render = renders.get(r.id);
    if (render !== undefined) return render || null;
    const finish = finishes.get(r.id);
    const on = planned.get(r.id)?.lane;
    return (on ? finish?.on.get(on) : undefined) ?? finish?.ms ?? null;
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
    /** The MCP token whose call queued it, by name, and how many renders of that token wait or run now (the status bar's "Claude Desktop rendering 2 takes"); null: the page queued it. */
    by: r.mcp_token_id ? by.get(r.mcp_token_id) ?? null : null,
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
    /** Of a waiting render no machine can run now: the stopped pod that holds its files, which its row offers to Start. */
    startPod: r.status === "queued" ? able.get(r.id)?.startPod ?? null : null,
    /**
     * Of a waiting render: the rented pods it can run on once its files are sent there, with the files and how long they take
     * (ms); and a machine of the user's own it waits on for files to be downloaded there (its row's Download, never unasked).
     */
    fetch: r.status === "queued" && Object.keys(able.get(r.id)?.fetch ?? {}).length ? able.get(r.id)!.fetch! : null,
    /** Of a waiting render: the node packs it waits for on a machine of the user's own, and where they stand (Install and restart, Run without). */
    packs: r.status === "queued" ? packWait(r.id) ?? null : null,
  });
  const idle = (r: JobRow) => (r.recipe_id === EXPORT_JOB ? ("exporting" as const) : r.recipe_id === CUT_JOB ? ("cutting" as const) : ("waiting" as const));
  /** A running job with its figures, from its lane's monitor; a job a ComfyUI had when this process last stopped, not picked up again yet, has none. */
  const card = async (r: JobRow, lane: LaneView | null) => {
    const own = lane?.core.running?.id === r.id ? lane.core.running : null;
    const monitor = own && lane ? (await lane.core.comfy()).monitor : null;
    // the seed it was built with, once sent: from memory, or from the job when another process sent it
    const seed = own?.seed ?? readJson<Partial<Resume>>(r.resume, {}).seed ?? null;
    return { ...brief(r), seed, ...behind(figures(monitor, own, own?.promptId, idle(r)), lane), spilling: own && lane ? await spillingNow(lane.core) : false };
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
      /**
       * The prompts its ComfyUI has from outside Afflatus (queued from its own page, another tool), running and waiting: it
       * takes no job while it has any. Null when not known (not read yet, or not answering).
       */
      outside: l.outside ?? null,
      /**
       * It takes no job while node packs wait for its ComfyUI to restart, or while it restarts: the waiting jobs planned there
       * that do not ask for those packs say so, rather than waiting with no reason given.
       */
      packsHold: l.packsHold ?? false,
      /** A rented pod: started, stopped, what it has cost; null for a ComfyUI of its own. */
      rented: l.rented,
      ...(l.files?.length ? { files: l.files } : {}),
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

/**
 * What each waiting render should take (the forecast, queue.expected), by job, in the line's order: on the machine it will
 * probably run on (`planned`), as that machine's renders say it, and with its model to load when it is not the one before it
 * on that machine. Each machine holds its own model: judged by the first machine's, a pod holding another was told its
 * render warm, 8 s for what took 13 with the load.
 */
async function rendersWaiting(core: QueueCore, rows: JobRow[], planned: ReadonlyMap<string, { lane: string }>, lanes: readonly LaneView[] = []): Promise<Map<string, number | null>> {
  const heldOf = (c: QueueCore) => (c.lastLoads === null ? null : new Set(c.lastLoads.split("|").map(modelName)));
  // what each machine holds, down the line; a job no machine is planned to take is judged by the first machine's
  const first = lanes.find((l) => l.machine)?.machine?.id ?? "";
  const held = new Map<string, Set<string> | null>(lanes.flatMap((l) => (l.machine ? [[l.machine.id, heldOf(l.core)] as const] : [])));
  if (!held.has(first)) held.set(first, heldOf(core));
  const asked: Array<Promise<[string, number | null]>> = [];
  for (const r of rows) {
    if (r.status !== "queued") continue;
    const lane = planned.get(r.id)?.lane ?? null;
    const on = lane !== null && held.has(lane) ? lane : first;
    // a tool on the GPU frees the model before it: the render after it there loads its own again
    if (held.get(on) && usesGpu(r)) held.set(on, new Set());
    const recipe = core.registry.recipe(r.recipe_id);
    if (!recipe || r.warm) continue;
    const input = inputsOf(r);
    // the model as the plan reads it: a recipe that loads its family's slot (SCAIL-2) names none on its form, and was never cold
    const model = (core.loadsModel ? await core.loadsModel(recipe, input, r) : modelOf(recipe.inputs, input)) || null;
    const was = held.get(on);
    // a machine that holds nothing known (none asked to load since it came) loads it: it was told warm
    const cold = Boolean(model && (!was || !was.has(model)));
    if (model) held.set(on, new Set([model]));
    asked.push(core.expected(recipe, input, cold, r, lane).then((ms) => [r.id, ms]));
  }
  return new Map(await Promise.all(asked));
}

/**
 * What each waiting finish should take (finishForecast), by job: on no machine in particular (`ms`), and on each of
 * `machines` (`on`), from its own finishes, else at its pace. A finish whose video is gone is left out.
 */
export async function finishesOf(db: Db, rows: readonly JobRow[], machines: ReadonlyArray<{ id: string; pace: number }> = []): Promise<Map<string, { ms: number | null; on: Map<string, number> }>> {
  const asked = rows.flatMap((r) => {
    const o = r.status === "queued" && r.recipe_id === CUT_JOB ? readJson<CutOptions | null>(r.inputs, null) : null;
    return o?.action === "finish" ? [{ id: r.id, o }] : [];
  });
  const out = new Map<string, { ms: number | null; on: Map<string, number> }>();
  if (!asked.length) return out;
  const videos = new Map((await db.selectFrom("assets").select(["id", "width", "height", "duration_ms", "fps"]).where("id", "in", [...new Set(asked.map((a) => a.o.asset))]).execute()).map((v) => [v.id, v]));
  const paces = new Map<string, Promise<ToolPaces | null>>();
  for (const { id, o } of asked) {
    const v = videos.get(o.asset);
    if (!v) continue;
    const video = { width: v.width, height: v.height, durationMs: v.duration_ms, fps: v.fps };
    const on = new Map<string, number>();
    for (const m of machines) {
      const ms = await finishForecast(db, video, o, paces, { machine: m.id, pace: m.pace });
      if (ms) on.set(m.id, ms);
    }
    out.set(id, { ms: await finishForecast(db, video, o, paces), on });
  }
  return out;
}

/**
 * A job sent to a ComfyUI that runs work from outside Afflatus (its own page, another tool) waits there behind it: its phase
 * says so ("behind"), where "waiting" read as Afflatus's own line.
 */
function behind<F extends { phase: string }>(f: F, lane: Pick<LaneView, "outside"> | null): F {
  return f.phase === "waiting" && lane?.outside?.running ? ({ ...f, phase: "behind" } as F) : f;
}

/**
 * Before its first sampling step, a job whose models were already in memory loads none (the owner, 2026-10-18: "Loading" was
 * said through a swap's tracking and reference encoding, every model held): its phase is "preparing", not "loading", and
 * "processing" once its steps are done.
 */
export const warmPhase = <F extends { phase: string; step?: number }>(f: F, running: QueueCore["running"]): F =>
  // after its steps (a node after the sampler the monitor takes for one not started yet: "Loading model 4/4"), it processes
  f.phase === "loading" && running?.cold === false ? { ...f, phase: f.step ? "processing" : "preparing" } : f;

/** The running job's progress, its preview and what it showed on the way: from the monitor, by its prompt; `idle` names its phase while it has none. */
function figures(monitor: Comfy["monitor"] | null, running: QueueCore["running"], promptId: string | undefined, idle: "exporting" | "cutting" | "waiting") {
  // no monitor (a job this process does not follow yet) or no prompt: nothing to read but its phase
  const m = promptId && monitor ? { monitor, promptId } : null;
  return warmPhase({
    // a tool on ComfyUI (a finish, a slow motion): which step runs, not a step count (its one-step passes would read 99 % at once)
    // its ETA what its own record expected of it (finishForecast for a finish), less the time it has run
    ...(m && idle === "cutting" ? { ...m.monitor.progress(m.promptId), progress: 0, eta: toolEta(running), step: 0, steps: 0 } : m ? m.monitor.progress(m.promptId) : { progress: 0, eta: 0, phase: idle, step: 0, steps: 0 }),
    previewSeq: m ? m.monitor.preview(m.promptId).seq : 0,
    previewMime: m ? m.monitor.preview(m.promptId).mime ?? null : null,
    // what the workflow showed on the way (its Preview nodes), oldest first; the title comes from the graph it was built with
    stages: (m ? m.monitor.stages(m.promptId) : []).map((st, n) => ({ n, node: st.node, title: running?.titles?.[st.node] ?? null, count: st.files.length })),
  }, running);
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
    all.push({ id: run.id, machine: lane.machine?.id ?? null, ...behind(figures((await lane.core.comfy()).monitor, run, run.promptId, run.tool ?? "waiting"), lane), seed: run.seed ?? null, spilling: await spillingNow(lane.core) });
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
export async function history(core: QueueCore, opts: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; offset?: number; after?: string; limit?: number; ids?: string[] } = {}) {
  const { db } = core;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
  const offset = Math.max(0, opts.offset ?? 0);
  // a job that only loaded a model made nothing: not part of the history
  let query = db.selectFrom("jobs").where("warm", "=", 0);
  if (opts.ids?.length) query = query.where("id", "in", opts.ids);
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
    const resolved = r.generation_id ? readJson<{ seed?: number; face?: number; faceCopies?: number }>(gens.find((g) => g.id === r.generation_id)?.resolved, {}) : {};
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
      /** How much the face in what it made is the person of its photos (a picture for Motion transfer, with the Face Match node). */
      face: typeof resolved.face === "number" ? resolved.face : null,
      /** Copies of that person elsewhere in the picture (Face At): pasted in beside the one kept, the man behind made them too. */
      faceCopies: typeof resolved.faceCopies === "number" ? resolved.faceCopies : 0,
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

/** The MCP tokens behind these jobs: each one's name, and its renders among them (a model load aside). */
async function tokensBehind(db: QueueCore["db"], rows: readonly JobRow[]): Promise<Map<string, { name: string; jobs: number }>> {
  const ids = [...new Set(rows.map((r) => r.mcp_token_id).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const tokens = await db.selectFrom("mcp_tokens").select(["id", "name"]).where("id", "in", ids).execute();
  return new Map(tokens.map((tk) => [tk.id, { name: tk.name, jobs: rows.filter((r) => r.mcp_token_id === tk.id && !r.warm).length }]));
}

/** How many waiting jobs the queue's answer carries whole: the rest go as a few figures each (paged). */
export const WAITING_SHOWN = 50;

/** A waiting job past the first ones, in the few figures the screens count and find it by; a figure it has none of is left out. */
export interface LaterJob {
  id: string; label: string; kind: ReturnType<typeof kindOf>; recipe: string; clipId?: string; draftId?: string;
  machine?: string; pinned?: string; estimateMs?: number; startsInMs?: number; runsOn?: string[];
}
const LATER_FIGURES = ["clipId", "draftId", "machine", "pinned", "estimateMs", "startsInMs", "runsOn"] as const;
/** The parts of the queue's answer a page holds and is sent only when they changed (paged). */
const HELD_PARTS = ["waiting", "later"] as const;
/** A part's hash, as paged sends it and a read's `have` names it back. */
const hashOf = (part: unknown) => createHash("sha1").update(JSON.stringify(part)).digest("base64url").slice(0, 16);

/**
 * The queue as GET /api/queue (and the routes that change it) answer it: the first WAITING_SHOWN waiting jobs whole, the
 * others in a few figures each (`later`: what the screens count, find and order them by; the list asks for their whole
 * rows a page at a time, GET /api/queue/waiting), and their count. With 500 waiting the whole rows came to ~230 kB a
 * read, read again up to once a second by every tab while anything rendered.
 *
 * A rented pod's figures that move with the clock are said so that an answer read again without a change is the same
 * bytes, and its tag answers 304 (compress.ts): the idle stop as the moment it comes (`idleAt`, which the page counts
 * down to) rather than the time left, the cost so far to the cent (the page counts a running pod's from its rate).
 *
 * The waiting rows, whole and `later`, are most of an answer's bytes (~140 kB and ~70 kB of ~215 kB with 600 waiting), and
 * read again on every event while a long line renders though they often did not change (the 2026-10-22 review, L-12):
 * each goes with a hash of itself (`parts`), and the page's read names the hashes it holds (`have`, GET /api/queue?have=).
 * A part whose hash it holds is sent empty and named in `same`, and the page puts its own copy back (web api.ts queueOf).
 */
export function paged<S extends { waiting: W[]; machines: M[] }, W extends Pick<LaterJob, "id" | "label" | "kind" | "recipe"> & { [K in (typeof LATER_FIGURES)[number]]: LaterJob[K] | null }, M extends { rented: RentedRow | null }>(s: S, shown = WAITING_SHOWN, have: ReadonlySet<string> = new Set()) {
  const later = s.waiting.slice(shown).map((w) => {
    const l: LaterJob = { id: w.id, label: w.label, kind: w.kind, recipe: w.recipe };
    for (const k of LATER_FIGURES) if (w[k] !== null && w[k] !== undefined) Object.assign(l, { [k]: w[k] });
    return l;
  });
  const machines = s.machines.map((m) => {
    if (!m.rented) return { ...m, rented: null };
    const { idleLeftMs, ...rented } = m.rented;
    return { ...m, rented: { ...rented, spent: Math.round(rented.spent * 100) / 100, idleAt: idleLeftMs === null ? null : Math.round((Date.now() + idleLeftMs) / 1000) * 1000 } };
  });
  const waiting = s.waiting.slice(0, shown);
  const parts = { waiting: hashOf(waiting), later: hashOf(later) };
  const same = HELD_PARTS.filter((p) => have.has(parts[p]));
  return { ...s, machines, waiting: same.includes("waiting") ? [] : waiting, waitingCount: s.waiting.length, later: same.includes("later") ? [] : later, parts, same };
}
