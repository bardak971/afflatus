import { EventEmitter } from "node:events";
import { ComfyCancelled, ComfyError, ComfyFailed, ComfyLost, ComfyUnreachable, waitForOutputs, type Measured } from "@afflatus/comfy";
import { expandWildcards, modelFileName, modelName, modelOf, parseInput, type BuiltGraph, type InputSpec, type Recipe } from "@afflatus/core";
import type { Comfy, MachineComfy } from "./comfy";
import { newId, now, OWNER, type Db } from "./db";
import { addedBy } from "./events";
import { httpError } from "./errors";
import type { HuntSummary } from "./hunt";
import { machinePaces, rates } from "./forecast";
import type { Registry } from "./registry";
import { record } from "./renders";
import { lackOn, type Lack } from "./machineScans";
import { machineSaid, type Say } from "./notifyWords";
import type { PodFiles } from "./podFiles";
import { plan, type Lane as Schedulable, type Planned, type Waiting } from "./schedule";
import { FIRST_MACHINE, readSettings, type Machine } from "./settings";
import type { Storage } from "./storage";
import type { CutOptions, ExportOptions, Timelines } from "./timelines";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";
import { DEFAULT_QUEUE_OPTIONS, readJson, SHUTDOWN, Stuck, type JobRow, type QueueCore, type QueueOptions, type Resume, type Running, type Usual } from "./queueModel";
import * as bulk from "./queueBulk";
import { needsComfy, Offline } from "./queueOffline";
import * as submitting from "./queueSubmit";
import * as storing from "./queueStore";
import * as tools from "./queueTools";
import * as view from "./queueView";

// what the routes and the services name from here: the options, and the RIFE model lookup the timelines routes share with the slow-motion tool
export { DEFAULT_QUEUE_OPTIONS, type QueueOptions };
export { rifeModelIn } from "./queueTools";

/**
 * The queue. One line of jobs, and a lane per ComfyUI (settings.ts `machines`): each machine runs one job at a time, the
 * one the scheduler (schedule.ts) gives it when it is free; the jobs that need no ComfyUI (an export, a cut by ffmpeg) have
 * a lane of their own. Jobs live in the database: a restart loses nothing. Queued jobs stay queued, and a job a ComfyUI
 * already has is waited on again by its prompt id, on that machine.
 */

const PAUSED_KEY = "queue.paused";
/** The name of the model among them that a person knows it by, to say which one is loaded. The first machine's keys are the ones from before there were several. */
const MODEL_KEY = "queue.model";
/** The base models the last job had a ComfyUI load, kept across restarts of this app (ComfyUI keeps running through them). */
const LOADS_KEY = "queue.loads";
const keyOf = (key: string, machine: string) => (machine === FIRST_MACHINE ? key : `${key}.${machine}`);
/** At most how often a running render's step count is saved on its job, when the options do not say. */
const STEPS_SAVE_MS = 5_000;
/** The GPU's load (percent) from which a render that says nothing is taken as at work, not stuck. */
const GPU_AT_WORK = 30;
/** The lane of the jobs that need no ComfyUI. */
const TOOLS = "tools";
/** How long a running job has left, from what it was expected to take; null when that cannot be told. */
const remainingOf = (run: Running | null): number | null => (run?.expectedMs && run.startedAt ? Math.max(0, run.expectedMs - (Date.now() - run.startedAt)) : null);

/** A machine's lane: its ComfyUI, the job it runs, what it was last asked to load, whether it is paused by hand. */
interface Lane {
  id: string;
  machine: Machine | null;
  comfy: Comfy | null;
  running: Running | null;
  /** The job being started on it, from the moment the pass picks it until it runs or turns out taken. */
  starting: string | null;
  /** ComfyUI holds a model this app had it load. Unknown after a restart: taken as not. */
  holds: boolean;
  unloadTimer: NodeJS.Timeout | null;
  /**
   * The base models the last job loaded (checkpoint or diffusion model, text encoders, VAE), file names joined by "|". A job
   * that needs a base model that is not among them frees the memory first; another LoRA or upscaler does not. Stored, so
   * that a restart of this app does not have ComfyUI unload a model the next job uses again; unknown (null) only before
   * the first job ever and after the memory was freed by hand.
   */
  lastLoads: string | null;
  /** The name of the model that is loaded, when it is known. */
  lastModel: string | null;
  /** Paused by hand on its own (Pause all is the queue's). */
  paused: boolean;
  /** Whether its ComfyUI answered the last time it was asked; null before. */
  reachable: boolean | null;
  /** Its state as kept across restarts, read once. */
  ready: Promise<void>;
  core: QueueCore;
}

/**
 * Of a waiting render, with several machines: the machines that can run it, and what keeps it off each of the others. A
 * rented pod that lacks only files it can be sent (`fetch`) is among the ones that can, with how long until they are there.
 */
type Able = { can: Set<string>; lacks: Record<string, Lack>; fetch: Record<string, { files: Lack["files"]; packs?: string[]; ms: number }> };

/**
 * The model files a rented pod can be sent (podFiles.ts), as the queue reads them: a job that lacks only files on a pod may
 * still go there, once they came. Set by services.ts; null: no machine is ever sent a file.
 */
export interface PodFetch {
  /** Why these files (or node packs) cannot come to that machine: one of them failed there already. Null: they can. */
  failed(machine: string, files: Lack["files"], packs?: string[]): string | null;
  /** How long until these files (and node packs) are on that machine (ms): what is left of each, at the slow end of the speeds measured. */
  untilThere(machine: string, files: Lack["files"], packs?: string[]): Promise<number>;
  /** Have them sent: for a job that will run there ("need"), or for one that went elsewhere this time ("ahead": files only, never packs, which restart its ComfyUI). */
  want(machine: string, files: Lack["files"], tier: "need" | "ahead", job?: string, packs?: string[]): void;
  /** A job's files on that machine: all there, still coming, one failed (null: it asked for none). */
  jobState(machine: string, job: string): "ready" | "waiting" | "failed" | null;
  /** The machine's node packs wait for its ComfyUI to restart, or it restarts now: no job starts there meanwhile. */
  holding(machine: string): boolean;
}

/** A rented pod's files as the queue reads them, from podFiles.ts. */
export function podFetchOf(files: Pick<PodFiles, "failed" | "failedPacks" | "untilThere" | "want" | "wantPacks" | "jobState" | "holding">): PodFetch {
  return {
    failed: (machine, list, packs = []) => list.map((f) => files.failed(machine, f.folder, f.file)).find((why) => why !== null) ?? files.failedPacks(machine, packs),
    untilThere: (machine, list, packs) => files.untilThere(machine, list, packs),
    want: (machine, list, tier, job, packs) => {
      files.want(machine, list, { tier, ...(job ? { job } : {}) });
      if (tier === "need" && job && packs?.length) files.wantPacks(machine, packs, job);
    },
    jobState: (machine, job) => files.jobState(machine, job)?.state ?? null,
    holding: (machine) => files.holding(machine),
  };
}

export class Queue {
  /** "queue": jobs changed. "library": an asset was added. "progress": a running job moved. */
  readonly events = new EventEmitter();
  /** A pass over the line is under way. */
  private dispatching = false;
  /** pump() was called while a pass was under way: one more pass is made before stopping, so a job queued meanwhile is not left waiting. */
  private dirty = false;
  /** Jobs started and not ended yet, on any lane. */
  private inflight = 0;
  /** Pause all: no queued job that needs a ComfyUI starts. */
  private paused = false;
  private readonly lanes = new Map<string, Lane>();
  /** The machine named first in the settings: the screens that know one ComfyUI read its lane. */
  private firstId = FIRST_MACHINE;
  /** No ComfyUI away and back (queueOffline.ts). */
  private readonly offline: Offline;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  /** While an update waits for the queue (updates.ts): only these jobs may start, the rest wait for the new version. Null: any. */
  private only: ReadonlySet<string> | null = null;
  /** The timelines, for jobs that render a clip of one (set once both exist). */
  clips: Timelines | null = null;
  /** Where what the user is told of goes (notify.ts; set by services.ts): a ComfyUI gone mid-render. Null: nothing is said. */
  tell: Say | null = null;
  /** The machines a ComfyUI gone mid-render was said of, until they answer again: said once, however it is found out. */
  private goneSaid = new Set<string>();
  /** How many passes picked another job over a waiting one: a job is passed over a few times at most. */

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly machines: () => Promise<MachineComfy[]>,
    private readonly registry: Registry,
    private readonly opts: QueueOptions = DEFAULT_QUEUE_OPTIONS,
  ) {
    this.offline = new Offline({
      events: this.events, opts,
      running: () => this.anyRunning(),
      forget: async () => {
        for (const lane of this.machineLanes()) await this.loaded(lane, null);
      },
      pump: () => void this.pump(),
      retryLater: () => this.retryLater(),
      fail: (r, error) => this.finish(r.id, "failed", { error }, r.status),
    });
    // a machine got a file, or its families were switched: a job that waited for one may go there now
    this.events.on("setup", () => void this.pump());
  }

  /** The door the submitting, storing, tools and view modules reach the first machine's lane through (queueModel.ts): what screens that know one ComfyUI read. */
  private get core(): QueueCore {
    return this.lane(this.firstId).core;
  }

  /** A lane by id, made (with its state from before read) the first time it is asked for. */
  private lane(id: string): Lane {
    let lane = this.lanes.get(id);
    if (lane) return lane;
    const self = this;
    lane = {
      id, machine: null, comfy: null, running: null, starting: null, holds: false, unloadTimer: null, lastLoads: null, lastModel: null, paused: false, reachable: null,
      ready: Promise.resolve(),
      core: null as unknown as QueueCore,
    };
    const l = lane;
    l.core = {
      db: this.db, storage: this.storage, registry: this.registry, opts: this.opts, events: this.events,
      machineId: id === TOOLS ? null : id,
      // the lane of the jobs that need no ComfyUI reaches the first machine's, for what it may still ask of one
      comfy: async () => (id === TOOLS ? this.comfyOfFirst() : l.comfy ?? (await this.refreshed(l))),
      get clips() { return self.clips; },
      get running() { return l.running; },
      get paused() { return self.paused || l.paused; },
      get lastLoads() { return l.lastLoads; },
      get lastModel() { return l.lastModel; },
      get offlineSince() { return self.offline.since; },
      loaded: (loads, model) => this.loaded(l, loads, model),
      usual: () => this.usual(),
      expected: (recipe, input, cold, job) => this.expected(recipe, input, cold, job),
      runTool: (row, work) => this.runTool(l, row, work),
    };
    if (id !== TOOLS) l.ready = this.readLane(l);
    this.lanes.set(id, l);
    return l;
  }

  private machineLanes(): Lane[] {
    return [...this.lanes.values()].filter((l) => l.id !== TOOLS && l.machine);
  }

  private anyRunning(): Running | null {
    for (const lane of this.lanes.values()) if (lane.running) return lane.running;
    return null;
  }

  /** The lane a running job is on. */
  private laneRunning(jobId: string): Lane | undefined {
    return [...this.lanes.values()].find((l) => l.running?.id === jobId);
  }

  /** The machines of the settings, each with its lane (its client set to the one of now): the first first. */
  private async refresh(): Promise<Lane[]> {
    const all = await this.machines();
    this.firstId = all[0]?.machine.id ?? FIRST_MACHINE;
    const lanes = all.map(({ machine, comfy }) => {
      const lane = this.lane(machine.id);
      lane.machine = machine;
      // a lane keeps the client its running job started with: a new address is taken up between jobs
      if (!lane.running || !lane.comfy) lane.comfy = comfy;
      return lane;
    });
    // a machine taken out of the settings: its lane goes once it is idle
    for (const [id, lane] of this.lanes) {
      if (id === TOOLS || all.some((m) => m.machine.id === id) || lane.running || lane.starting) continue;
      if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
      this.lanes.delete(id);
    }
    await Promise.all(lanes.map((l) => l.ready));
    return lanes;
  }

  private async refreshed(lane: Lane): Promise<Comfy> {
    await this.refresh();
    return lane.comfy ?? this.comfyOfFirst();
  }

  private async comfyOfFirst(): Promise<Comfy> {
    return (await this.machines())[0]!.comfy;
  }

  // ---------------------------------------------------------------- start / stop

  /** The state kept across restarts (paused, what each ComfyUI was last asked to load), read once: before any request can reach the queue. */
  private loading: Promise<void> | null = null;
  load(): Promise<void> {
    this.loading ??= this.readState();
    return this.loading;
  }

  /** After a restart: jobs that were mid-run without a prompt id start over; the others are waited on again. */
  async start(): Promise<void> {
    await this.load();
    // a tool job (an export, a cut, a finish) is run again from its start: what it already made is noted on it (queueTools.ts)
    await this.db
      .updateTable("jobs")
      .set({ status: "queued", updated_at: now() })
      .where("status", "=", "running")
      .where((eb) => eb.or([eb("resume", "is", null), eb("recipe_id", "in", [EXPORT_JOB, CUT_JOB])]))
      .execute();
    void this.pump();
  }

  private async readState(): Promise<void> {
    const flag = await this.db.selectFrom("settings").select("value").where("key", "=", PAUSED_KEY).executeTakeFirst();
    this.paused = flag?.value === "true";
    this.lane(TOOLS);
    await this.refresh();
  }

  /** A machine's own state from before: paused or not, and what it was last asked to load. */
  private async readLane(lane: Lane): Promise<void> {
    const value = async (key: string) => (await this.db.selectFrom("settings").select("value").where("key", "=", key).executeTakeFirst())?.value;
    lane.paused = (await value(`${PAUSED_KEY}.${lane.id}`)) === "true";
    const loaded = await value(keyOf(LOADS_KEY, lane.id));
    const named = await value(keyOf(MODEL_KEY, lane.id));
    lane.lastModel = loaded ? named || null : null;
    if (loaded !== undefined) lane.lastLoads = loaded || null;
    else if (lane.id === FIRST_MACHINE) {
      // nothing noted yet (a database from before the note existed): what the last render loaded
      const last = await this.db.selectFrom("generations").select("resolved").orderBy("created_at", "desc").limit(1).executeTakeFirst();
      const files = readJson<{ loads?: string[] }>(last?.resolved, {}).loads;
      lane.lastLoads = files ? files.map(modelFileName).sort().join("|") : null;
    }
  }

  /** Stop taking jobs (tests, shutdown). The running jobs are left to their ComfyUI and picked up again on the next start. */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    for (const lane of this.lanes.values()) {
      if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
      lane.running?.abort.abort(SHUTDOWN);
    }
  }

  /** Resolves when nothing is running and nothing can start (tests). */
  async idle(): Promise<void> {
    while (this.dispatching || this.inflight > 0) await new Promise((r) => setTimeout(r, 5));
  }

  // ---------------------------------------------------------------- enqueue / cancel / pause

  async enqueue(recipeId: string, rawInput: unknown, opts: { label?: string; dependsOn?: string; clip?: { id: string; fit: boolean; mirror?: readonly string[] }; draft?: string | null; folder?: string | null; warm?: boolean; look?: unknown; finishedFrom?: string | null; asked?: Record<string, unknown>; machine?: string | null } = {}): Promise<string> {
    const recipe = this.registry.recipe(recipeId);
    if (!recipe) throw httpError(`there is no model or operation called ${recipeId}`);
    // loading the models is asked for while the form is still being filled in: a text not written yet is no reason to refuse
    const input = parseInput(recipe, opts.warm ? submitting.withTexts(recipe, rawInput) : rawInput) as Record<string, unknown>; // throws a ZodError the API turns into a 400
    // choices written in a text ({red|black|white}) are settled now, one per job: what is kept is what was picked
    for (const spec of recipe.inputs as InputSpec[]) {
      if (spec.type === "prompt" && typeof input[spec.id] === "string") input[spec.id] = expandWildcards(input[spec.id] as string);
    }
    // the person's own form beside it, when a cast was worked in: the fields the cast changed, as they were (JSON leaves out the ones that were not there)
    const asked = opts.asked && Object.keys(opts.asked).length ? JSON.stringify({ ...input, ...opts.asked }) : null;
    const id = newId();
    const at = now();
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: recipe.id, label: opts.label?.trim() || recipe.title, inputs: JSON.stringify(input), asked,
        status: "queued", warm: opts.warm ? 1 : 0, look: opts.look ? JSON.stringify(opts.look) : null, priority: recipe.output === "image" ? 0 : 10, depends_on: opts.dependsOn ?? null,
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: opts.clip?.id ?? null, clip_fit: opts.clip?.fit ? 1 : 0, clip_mirror: opts.clip?.mirror?.length ? JSON.stringify(opts.clip.mirror) : null,
        draft_id: opts.draft ?? null, folder_id: opts.folder ?? null, finished_from: opts.finishedFrom ?? null, pin_machine: opts.machine ?? null,
        created_at: at, started_at: null, finished_at: null, updated_at: at,
      })
      .execute();
    this.events.emit("queue");
    void this.pump();
    return id;
  }

  /**
   * Put a timeline together as one video. It needs no model and no ComfyUI, only ffmpeg; it waits in the
   * same line so that it comes after the renders that were asked for before it, and shows with them.
   */
  async enqueueExport(opts: ExportOptions, label: string): Promise<string> {
    const id = newId();
    const at = now();
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: EXPORT_JOB, label, inputs: JSON.stringify(opts), status: "queued", warm: 0, look: null, priority: 20, depends_on: null,
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: opts.timeline, draft_id: null, folder_id: null,
        created_at: at, started_at: null, finished_at: null, updated_at: at,
      })
      .execute();
    this.events.emit("queue");
    // an export is always of a timeline: its editor shows it waiting
    this.events.emit("timeline");
    void this.pump();
    return id;
  }

  /** A range of a video kept as new videos (see Timelines.cutRange): ffmpeg only, no model, no ComfyUI. */
  async enqueueCut(opts: CutOptions, label: string, extra: { dependsOn?: string } = {}): Promise<string> {
    const id = newId();
    const at = now();
    // a cut made for a clip works on that clip's timeline
    const timeline = opts.clip ? (await this.db.selectFrom("clips").select("timeline_id").where("id", "=", opts.clip).executeTakeFirst())?.timeline_id ?? null : null;
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: CUT_JOB, label, inputs: JSON.stringify(opts), status: "queued", warm: 0, look: null, priority: 20, depends_on: extra.dependsOn ?? null,
        // a cut made for a clip (a finish, a slow motion) is that clip's job: the editor shows the clip busy with it, and a
        // second Finish skips the clip while it waits or runs
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: opts.clip ?? null, clip_fit: 0, timeline_id: timeline, draft_id: null, folder_id: null,
        created_at: at, started_at: null, finished_at: null, updated_at: at,
      })
      .execute();
    this.events.emit("queue");
    if (opts.clip) this.events.emit("timeline");
    void this.pump();
    return id;
  }

  /** A prompt a job sent to a ComfyUI, stopped there: on the machine the job ran on, or the first one for a job from before there were several. */
  private interruptOn(machine: string | null | undefined, promptId: string): void {
    void this.machines()
      .then((all) => (all.find((m) => m.machine.id === machine) ?? all[0])?.comfy.client.interrupt(promptId))
      .catch(() => {});
  }

  async cancel(id: string): Promise<boolean> {
    // a job queued again with the prompt ComfyUI may still have (lost from sight, or a finish stopped by a restart): that prompt
    // is stopped in ComfyUI too, or it would go on rendering what nobody wants any more
    const waiting = await this.db.selectFrom("jobs").select(["resume", "machine_id"]).where("id", "=", id).where("status", "=", "queued").executeTakeFirst();
    const sent = readJson<Partial<Resume>>(waiting?.resume, {}).promptId;
    // a waiting job: claim it in one statement, so a pass that picks it at the same moment loses
    const queued = await this.db
      .updateTable("jobs")
      .set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() })
      .where("id", "=", id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(queued.numUpdatedRows) > 0) {
      if (sent) this.interruptOn(waiting?.machine_id, sent);
      // what continues from it can never run now, as when it is stopped while it runs
      await this.failDependents(id);
      this.events.emit("queue");
      if (await bulk.ofTimeline(this.db, [id])) this.events.emit("timeline");
      return true;
    }
    const lane = this.laneRunning(id);
    if (lane?.running) {
      lane.running.abort.abort();
      if (lane.running.promptId && lane.comfy) await lane.comfy.client.interrupt(lane.running.promptId).catch(() => {});
      return true;
    }
    // a job a ComfyUI had when this process last stopped, not picked up again yet (its machine is away): stopped here, and there when it answers
    const resumed = await this.db.selectFrom("jobs").select(["resume", "machine_id"]).where("id", "=", id).where("status", "=", "running").executeTakeFirst();
    if (!resumed) return false;
    const stopped = await this.db
      .updateTable("jobs")
      .set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() })
      .where("id", "=", id)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (Number(stopped.numUpdatedRows) === 0) return false;
    // picked up in the meantime: stopped there too
    this.laneRunning(id)?.running?.abort.abort();
    const promptId = readJson<Partial<Resume>>(resumed.resume, {}).promptId;
    if (promptId) this.interruptOn(resumed.machine_id, promptId);
    await this.failDependents(id);
    this.events.emit("queue");
    if (await bulk.ofTimeline(this.db, [id])) this.events.emit("timeline");
    return true;
  }

  /**
   * Put the waiting jobs in this order. Jobs that were arranged by hand come before the ones added
   * afterwards; a clip still waits for the clip it continues, wherever it was put.
   */
  async reorder(ids: string[]): Promise<void> {
    const waiting = await this.db.selectFrom("jobs").select("id").where("status", "=", "queued").orderBy("priority").orderBy("created_at").execute();
    const known = new Set(waiting.map((w) => w.id));
    const order = [...ids.filter((id) => known.has(id)), ...waiting.map((w) => w.id).filter((id) => !ids.includes(id))];
    // the whole order lands at once: a pass reading the line in the middle of it would see a half-made one
    await this.db.transaction().execute(async (tx) => {
      for (const [i, id] of order.entries()) await tx.updateTable("jobs").set({ priority: -100_000 + i, updated_at: now() }).where("id", "=", id).where("status", "=", "queued").execute();
    });
    this.events.emit("queue");
  }

  /** A waiting job pinned to a machine (dragged onto its lane, "Run on"), or back to whichever the queue picks (null). */
  async pin(id: string, machine: string | null): Promise<boolean> {
    if (machine !== null && !(await this.machines()).some((m) => m.machine.id === machine)) throw httpError("there is no ComfyUI with that id");
    const done = await this.db.updateTable("jobs").set({ pin_machine: machine, updated_at: now() }).where("id", "=", id).where("status", "=", "queued").executeTakeFirst();
    if (Number(done.numUpdatedRows) === 0) return false;
    this.events.emit("queue");
    void this.pump();
    return true;
  }

  /**
   * Unload the models now: the GPU's memory is wanted for something else. On one machine (`machine`), or on every one that
   * is not rendering; refused where a render is under way (its model is in use). The next render loads what it needs again.
   */
  async freeMemory(machine?: string): Promise<void> {
    const lanes = await this.refresh();
    const asked = machine ? lanes.filter((l) => l.id === machine) : lanes;
    if (machine && !asked.length) throw httpError("there is no ComfyUI with that id");
    const free = asked.filter((l) => !l.running?.gpu);
    if (!free.length) throw httpError("A render is under way and its model is loaded. Wait for it, or cancel it first.");
    for (const lane of free) await this.unload(lane);
    // every open screen says which model is loaded: they are told it no longer is
    this.events.emit("queue");
  }

  private async unload(lane: Lane): Promise<void> {
    await lane.comfy!.client.free();
    await this.loaded(lane, null);
    lane.holds = false;
    if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
    lane.unloadTimer = null;
  }

  /** One setting of the queue's own, written or replaced. */
  private async setting(key: string, value: string): Promise<void> {
    await this.db
      .insertInto("settings")
      .values({ key, value, updated_at: now() })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now() }))
      .execute();
  }

  /** Note what a ComfyUI was last asked to load, here and in the database. */
  private async loaded(lane: Lane, loads: string | null, model: string | null = null): Promise<void> {
    if (lane.lastLoads === loads && lane.lastModel === model) return;
    lane.lastLoads = loads;
    lane.lastModel = model;
    // only a note: a database that cannot take it costs one needless unload after the next restart.
    // Freed by hand is noted as empty, which is not the same as nothing noted.
    await this.setting(keyOf(MODEL_KEY, lane.id), model ?? "").catch(() => {});
    await this.setting(keyOf(LOADS_KEY, lane.id), loads ?? "").catch(() => {});
  }

  /** After a render or a job on the GPU: when it is set in Settings, the machine's models are unloaded once it has not rendered for that long. */
  private async armIdle(lane: Lane): Promise<void> {
    if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
    lane.unloadTimer = null;
    if (this.stopped || !lane.holds) return;
    const minutes = (await readSettings(this.db).catch(() => null))?.unloadAfterMinutes ?? 0;
    if (!(minutes > 0)) return;
    lane.unloadTimer = setTimeout(() => {
      lane.unloadTimer = null;
      // a render that started in the meantime keeps its model
      if (lane.running?.gpu || this.stopped) return;
      void this.freeMemory(lane.id).then(() => this.events.emit("queue"), () => {});
    }, minutes * 60_000);
    // a timer that is only waiting to free memory never keeps the process alive
    lane.unloadTimer.unref();
  }

  /** The same job again (after a failure, or because it was stopped), with some inputs changed if asked. */
  async again(id: string, change: Record<string, unknown> = {}): Promise<string> {
    const row = await this.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw httpError("this job was not found");
    if (row.recipe_id === EXPORT_JOB) return this.enqueueExport(JSON.parse(row.inputs) as ExportOptions, row.label);
    if (row.recipe_id === CUT_JOB) return this.enqueueCut(JSON.parse(row.inputs) as CutOptions, row.label);
    // a workflow whose settings were changed since no longer has some of what the job was sent with
    const has = new Set(this.registry.recipe(row.recipe_id)?.inputs.map((i) => i.id));
    const was = Object.fromEntries(Object.entries(JSON.parse(row.inputs) as Record<string, unknown>).filter(([k]) => !has.size || has.has(k)));
    return this.enqueue(row.recipe_id, { ...was, ...change }, {
      label: row.label,
      // with the flips it was sent with: done again, it renders what it was asked to, whatever the clip says now
      clip: row.clip_id ? { id: row.clip_id, fit: Boolean(row.clip_fit), mirror: readJson<string[]>(row.clip_mirror, []) } : undefined,
      draft: row.draft_id, folder: row.folder_id, warm: Boolean(row.warm), look: readJson(row.look, undefined),
      // a finish done again is still the finished version of the same take
      finishedFrom: row.finished_from,
      // what the person asked stays theirs, with what was changed now
      asked: row.asked ? { ...readJson<Record<string, unknown>>(row.asked, {}), ...change } : undefined,
      // pinned by hand, it goes back where it was pinned
      machine: row.pin_machine ?? null,
    });
  }

  /** Take a finished job off the list. What it made stays in the library. */
  async dismiss(id: string): Promise<boolean> {
    return (await this.dismissAll([id])) > 0;
  }

  /** Take several finished jobs off the list in one go (one event for all); how many went (queueBulk.ts). */
  dismissAll(ids: readonly string[]) { return bulk.dismissAll(this.core, ids); }
  /** Several finished jobs again, in the order given, each as `again` does it (queueBulk.ts). */
  againAll(ids: readonly string[], opts: { dismiss?: boolean } = {}) { return bulk.againAll(this.core, (id) => this.again(id), ids, opts); }
  /** Every waiting job cancelled in one statement, or those of `ids` that still wait (queueBulk.ts). */
  cancelWaiting(ids?: readonly string[]) { return bulk.cancelWaiting(this.core, (id) => this.failDependents(id), ids); }

  private known: (Usual & { at: number }) | null = null;
  /** What the forecast falls back on, worked out at most twice a minute. */
  private async usual() {
    if (!this.known || Date.now() - this.known.at > 30_000) this.known = { at: Date.now(), rates: await rates(this.db) };
    return this.known;
  }

  /** The waiting jobs' forecasts, by form: a job waits unchanged, so it is worked out once, and again after half a minute (renders end, the record grows). */
  private expectedAt: { at: number; by: Map<string, Promise<number | null>> } = { at: 0, by: new Map() };
  /** About how long a render will take: the forecast of its form, with what loading its model adds when it is not the one loaded before it. */
  private expected(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean, job: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null = null): Promise<number | null> {
    if (Date.now() - this.expectedAt.at > 30_000) this.expectedAt = { at: Date.now(), by: new Map() };
    const key = `${recipe.id}
${cold}
${job?.finished_from}
${job?.clip_id}
${job?.clip_fit}
${JSON.stringify(input)}`;
    let got = this.expectedAt.by.get(key);
    if (!got) {
      got = submitting.forecastOf(this.core, recipe.id, input, { cold, finishedFrom: job?.finished_from, clip: job?.clip_id ? { id: job.clip_id, fit: Boolean(job.clip_fit) } : null }).then((f) => f?.forecast.ms ?? null, () => null);
      this.expectedAt.by.set(key, got);
    }
    return got;
  }

  /** Whether the queue is paused by hand (Pause all): a queued render does not start. */
  get isPaused(): boolean {
    return this.allPaused();
  }

  /**
   * Let only these jobs start (an update waits for them before it restarts Afflatus); null lets every job start again.
   * Not kept across a restart: the new version starts with the jobs held here.
   */
  holdNew(only: ReadonlySet<string> | null): void {
    this.only = only;
    this.events.emit("queue");
    if (!only) void this.pump();
  }

  /** Pause or go on: all of them (no machine), or one machine on its own. A machine that is paused finishes what it runs and takes nothing new. */
  async setPaused(paused: boolean, machine?: string): Promise<void> {
    const all = await this.machines();
    if (machine) {
      if (!all.some((m) => m.machine.id === machine)) throw httpError("there is no ComfyUI with that id");
      await this.pauseLane(machine, paused);
    } else if (all.length > 1) {
      // with several ComfyUIs, Pause all and Resume all are every machine's own pause, so that each one says it (its chip,
      // its lane, its card) and a machine can be resumed alone afterwards; the switch of one ComfyUI stays off
      for (const { machine: m } of all) await this.pauseLane(m.id, paused);
      if (this.paused) {
        this.paused = false;
        await this.setting(PAUSED_KEY, "false");
      }
    } else {
      this.paused = paused;
      await this.setting(PAUSED_KEY, String(paused));
      // with one ComfyUI, Resume is its switch: a pause of its own (the GPU hunt's, hunt.ts) goes with it, or nothing would start
      if (!paused) for (const { machine: m } of all) await this.pauseLane(m.id, false);
    }
    this.events.emit("queue");
    if (!paused) void this.pump();
  }

  /** Whether a machine takes nothing new: paused on its own, or by Pause all. False for a machine that is not there. */
  async pausedOn(machine: string): Promise<boolean> {
    if (!(await this.machines()).some((m) => m.machine.id === machine)) return false;
    const lane = this.lane(machine);
    await lane.ready;
    return this.paused || lane.paused;
  }

  /**
   * What a waiting render should take on a pod that has its model to load (the forecast at the common pace of the machines),
   * for the GPU hunt's ranking (hunt.ts); null when it cannot be told.
   */
  forecastMs(row: JobRow): Promise<number | null> {
    const recipe = this.registry.recipe(row.recipe_id);
    if (!recipe || row.warm) return Promise.resolve(null);
    return this.expected(recipe, readJson<Record<string, unknown>>(row.inputs, {}), true, row);
  }

  /** One machine paused or going, here and in the database. */
  private async pauseLane(machine: string, paused: boolean): Promise<void> {
    const lane = this.lane(machine);
    await lane.ready;
    lane.paused = paused;
    await this.setting(`${PAUSED_KEY}.${machine}`, String(paused));
  }

  /** Whether every machine is paused, by hand or by Pause all: nothing new starts anywhere. */
  private allPaused(): boolean {
    const lanes = this.machineLanes();
    return this.paused || (lanes.length > 0 && lanes.every((l) => l.paused));
  }

  /** Every other machine paused, this one going: everything waiting goes to it ("Use only Studio PC"). */
  async useOnly(machine: string): Promise<void> {
    const all = await this.machines();
    if (!all.some((m) => m.machine.id === machine)) throw httpError("there is no ComfyUI with that id");
    for (const { machine: m } of all) await this.pauseLane(m.id, m.id !== machine);
    // one machine going is not a paused queue
    if (this.paused) {
      this.paused = false;
      await this.setting(PAUSED_KEY, "false");
    }
    this.events.emit("queue");
    void this.pump();
  }

  // ---------------------------------------------------------------- what the queue screen shows (queueView.ts)

  /** The lanes as the screens read them: each machine with its state, and the lane of the jobs that need no ComfyUI. */
  private async views(): Promise<view.LaneView[]> {
    const lanes = await this.refresh();
    const tools = this.lane(TOOLS);
    return [
      ...lanes.map((l) => ({ machine: l.machine, core: l.core, paused: l.paused, reachable: l.reachable, locked: l.comfy?.locked ?? false, rented: l.machine ? this.rentedOf(l.machine) : null })),
      { machine: null, core: tools.core, paused: false, reachable: null, locked: false, rented: null },
    ];
  }

  /** The line as it stands, each machine's running job and progress, and the last finished jobs. */
  async status() {
    const views = await this.views();
    const paused = this.allPaused();
    const lanes = await this.refresh();
    const rows = await this.db.selectFrom("jobs").selectAll().where("status", "=", "queued").orderBy("priority").orderBy("created_at").execute();
    const able = await this.ableOf(rows.filter(needsComfy));
    const status = await view.status(this.core, views, paused, paused ? new Map() : await this.forecastPlan(lanes, rows, able), await this.paces(), able);
    // the GPU hunt under way, for the status bar (hunt.ts); null when there is none
    return { ...status, hunt: this.huntOf?.(rows.filter(needsComfy).length) ?? null };
  }

  /** The GPU hunt's summary (set by services.ts), given how many renders wait. */
  huntOf: ((held: number) => HuntSummary | null) | null = null;
  /** The running jobs' figures alone, from memory: what a progress event carries, many times a second. */
  async progress() { return view.progress(await this.views()); }
  /** A running job's latest live preview. */
  preview(jobId: string) {
    const lane = this.laneRunning(jobId);
    return lane ? view.preview(lane.core, jobId) : Promise.resolve(null);
  }
  /** One picture a running job showed on the way (its Preview nodes), by its place in the strip. */
  stage(jobId: string, n: number) {
    const lane = this.laneRunning(jobId);
    return lane ? view.stage(lane.core, jobId, n) : Promise.resolve(null);
  }
  /** The finished jobs, newest first, with what each made: filtered and paged. */
  history(opts: Parameters<typeof view.history>[1] = {}) { return view.history(this.core, opts); }

  // ---------------------------------------------------------------- the worker

  /**
   * One pass over the line, which only starts work: a job a ComfyUI already has is followed again on that machine, the
   * lane of the jobs that need no ComfyUI takes its next one, and each free machine the one the scheduler gives it. Each
   * job that ends makes a new pass.
   */
  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.dispatching) {
      this.dirty = true;
      return;
    }
    this.dispatching = true;
    try {
      for (;;) {
        if (this.stopped) break;
        this.dirty = false;
        const lanes = await this.refresh();
        const tools = this.lane(TOOLS);
        const active = await this.db.selectFrom("jobs").selectAll().where("status", "in", ["queued", "running"]).orderBy("priority").orderBy("created_at").execute();
        const waitingOn = new Set(active.map((r) => r.id));
        const taken = new Set<string>();
        for (const l of this.lanes.values()) {
          if (l.running) taken.add(l.running.id);
          if (l.starting) taken.add(l.starting);
        }
        const free = (l: Lane) => !l.running && !l.starting;
        /** Whether a machine's ComfyUI answers, asked once per pass and only when there is a job for it. */
        const asked = new Map<string, boolean>();
        const answers = async (l: Lane) => {
          // a machine that cannot take work now (a rented pod not running) is not asked: it is not away, it is off
          if (this.unavailable(l.id)) return false;
          if (!asked.has(l.id)) {
            l.reachable = await l.comfy!.client.status().then(() => true, () => false);
            asked.set(l.id, l.reachable);
          }
          return asked.get(l.id)!;
        };
        let started = false;

        // a job a ComfyUI already has goes first, paused or not: it is rendering anyway, on the machine it was sent to
        for (const r of active) {
          if (r.status !== "running" || taken.has(r.id) || !needsComfy(r)) continue;
          const lane = lanes.find((l) => l.id === (r.machine_id ?? this.firstId)) ?? lanes[0]!;
          if (!free(lane) || !(await answers(lane))) continue;
          this.startOn(lane, r);
          taken.add(r.id);
          started = true;
        }

        // the line as the machines see it: what waits for nothing, and may start (an update holds back what was asked after it)
        const startable = active.filter((r) => r.status === "queued" && !taken.has(r.id) && !(r.depends_on && waitingOn.has(r.depends_on)) && !(this.only && !this.only.has(r.id)));
        const gpuRows = startable.filter(needsComfy);
        const open = lanes.filter((l) => !l.paused && l.machine);
        let where = new Map<string, { lane: string; startsInMs: number }>();
        if (!this.paused && gpuRows.length) {
          // each free machine is asked whether it answers (a busy one does); the plan is made with those that may take work
          for (const l of open) if (free(l)) await answers(l);
          const able = await this.ableOf(gpuRows);
          where = plan(await this.schedulable(open), await this.planned(gpuRows, able));
          this.sendFiles(gpuRows, able, where);
          for (const lane of open) {
            if (!free(lane) || lane.reachable === false) continue;
            // on a pod getting files, the first job planned there whose own files are all there
            // a pod whose node packs wait for its ComfyUI to restart (or that restarts now) takes nothing until it is back: the
            // job that needs them is first in its line, and a job sent meanwhile would be lost in the restart
            if (this.podFetch?.holding(lane.id)) continue;
            const next = gpuRows.find((r) => !taken.has(r.id) && where.get(r.id)?.lane === lane.id && this.filesThere(r, lane, able));
            if (!next) continue;
            this.startOn(lane, next);
            taken.add(next.id);
            started = true;
          }
        }
        // the machines that answered this pass, or that run a job now, say whether any ComfyUI is there
        const anyAnswered = lanes.some((l) => asked.get(l.id) === true || l.running);
        const noneAnswered = !anyAnswered && [...asked.values()].some((ok) => !ok);

        // what needs no ComfyUI (an export, a cut by ffmpeg) goes on in its turn: after the renders before it, unless those
        // cannot start (paused, every machine away or paused, or none takes them); an update holds back what was asked after it
        if (free(tools)) {
          for (const r of active) {
            if (taken.has(r.id) || (r.depends_on && waitingOn.has(r.depends_on))) continue;
            if (this.only && r.status === "queued" && !this.only.has(r.id)) continue;
            if (!needsComfy(r)) {
              if (r.status !== "queued") continue;
              this.startOn(tools, r);
              taken.add(r.id);
              started = true;
              break;
            }
            // a render before it that runs, or that a machine is planned to take, keeps it waiting
            if (r.status === "running" || where.has(r.id)) break;
          }
        }

        if (anyAnswered) this.offline.answered();
        else if (noneAnswered) await this.offline.whileOffline(active);
        if (started) continue;
        // a job queued while this pass was reading the line: the line is read again
        if (this.dirty && !this.stopped && !(noneAnswered && !anyAnswered)) continue;
        break;
      }
    } catch (err) {
      console.error("[queue] stopped unexpectedly:", err);
      this.retryLater();
    } finally {
      this.dispatching = false;
    }
  }

  /** The machines that may take work now, as the scheduler reads them: free in how long, what they hold, their learned pace. */
  private async schedulable(open: Lane[]): Promise<Schedulable[]> {
    const paces = await this.paces();
    return Promise.all(open
      .filter((l) => l.reachable !== false && !this.unavailable(l.id))
      .map(async (l) => ({
        id: l.id, takes: l.machine!.takes,
        busyForMs: l.running || l.starting ? remainingOf(l.running) ?? (await this.untilEnd(l, paces.get(l.id) ?? 1)) : 0,
        holds: new Set(l.lastLoads ? l.lastLoads.split("|").map(modelName) : []),
        pace: paces.get(l.id) ?? 1,
      })));
  }

  /**
   * How long a machine's job has left when it does not say yet: one being started or sent (its expected time comes back
   * with the prompt) is taken at its own forecast, as the waiting list has it, less what it ran; null when nothing like it
   * was rendered (then the machine is not waited for).
   */
  private async untilEnd(lane: Lane, pace: number): Promise<number | null> {
    const id = lane.running?.id ?? lane.starting;
    const row = id ? await this.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirst() : undefined;
    const recipe = row && row.recipe_id !== CUT_JOB && row.recipe_id !== EXPORT_JOB ? this.registry.recipe(row.recipe_id) : undefined;
    if (!row || !recipe) return null;
    const input = readJson<Record<string, unknown>>(row.inputs, {});
    const model = modelOf(recipe.inputs, input);
    const held = new Set(lane.lastLoads ? lane.lastLoads.split("|").map(modelName) : []);
    const ms = await this.expected(recipe, input, Boolean(model && !held.has(model)), row);
    if (ms === null) return null;
    const ran = lane.running?.startedAt ? Date.now() - lane.running.startedAt : 0;
    return Math.max(0, ms * pace - ran);
  }

  /**
   * With several machines, the machines that can run each waiting render: its recipe ready there, its family on there, the
   * files it asks for listed there (machineScans.ts lackOn), and what keeps it off each of the others. A machine known to be
   * away, or whose scan cannot be read, is not held against a job. Nothing with one machine: it takes everything, as it always did.
   */
  private async ableOf(rows: JobRow[]): Promise<Map<string, Able>> {
    const out = new Map<string, Able>();
    const lanes = this.machineLanes().filter((l) => l.machine && l.comfy);
    // one machine takes everything, unless it is a rented pod whose balance a job would outlast
    if ((lanes.length < 2 && !lanes.some((l) => l.machine!.rented)) || !rows.length) return out;
    const settings = await readSettings(this.db).catch(() => null);
    if (!settings) return out;
    const machines = new Map(settings.machines.map((m) => [m.id, m]));
    // a machine known to be away, or a rented pod not running, is not asked (a dead pod's address would hold the pass)
    const scans = await Promise.all(lanes.map(async (l) => ({ lane: l, scan: l.reachable === false || this.unavailable(l.id) ? null : await l.comfy!.scan().catch(() => null) })));
    const familyOf = (id: string) => this.registry.recipe(id)?.family;
    for (const r of rows) {
      const recipe = r.recipe_id === CUT_JOB || r.recipe_id === EXPORT_JOB ? undefined : this.registry.recipe(r.recipe_id);
      if (!recipe) continue;
      const input = readJson<Record<string, unknown>>(r.inputs, {});
      const can = new Set<string>();
      const lacks: Record<string, Lack> = {};
      const fetch: Able["fetch"] = {};
      // every machine of a job worked out at once (its balance, its files' time on a pod)
      await Promise.all(scans.map(async ({ lane, scan }) => {
        // a rented pod whose ComfyUI cannot be read now (booting, restarting for node packs, away) starts with nothing: what
        // it has is not known, so it is not given the job (a ComfyUI of the user's own is not held against a job for that)
        if (lane.machine!.rented && !scan?.comfy.online) {
          lacks[lane.id] = { off: false, files: [], sendable: false };
          return;
        }
        // a lone rented pod is asked too: what it lacks may be sent to it
        const lack = (lanes.length > 1 || lane.machine!.rented) && scan?.comfy.online ? lackOn(recipe, input, scan, settings, machines.get(lane.id) ?? lane.machine!, familyOf) : null;
        const balance = await this.balanceLack(r, lane);
        // a pod that lacks only files it can be sent: it can run the job once they came
        if (lack && !balance && lack.sendable && lane.machine!.rented && this.podFetch && !this.podFetch.failed(lane.id, lack.files, lack.packs)) {
          can.add(lane.id);
          fetch[lane.id] = { files: lack.files, ...(lack.packs ? { packs: lack.packs } : {}), ms: await this.podFetch.untilThere(lane.id, lack.files, lack.packs) };
          return;
        }
        const failed = lack?.sendable && lane.machine!.rented && this.podFetch ? this.podFetch.failed(lane.id, lack.files, lack.packs) : null;
        if (lack || balance) lacks[lane.id] = { ...(lack ?? { off: false, files: [], sendable: false }), ...(balance ? { balance } : {}), ...(failed ? { failed } : {}) };
        else can.add(lane.id);
      }));
      out.set(r.id, { can, lacks, fetch });
    }
    return out;
  }

  /** The waiting jobs as the scheduler reads them: what each makes, its pin, the machines that can run it, its model and its forecast with and without loading it. */
  private planned(rows: JobRow[], able: ReadonlyMap<string, Able> = new Map()): Promise<Planned[]> {
    return Promise.all(rows.map(async (r): Promise<Planned> => {
      const fetch = able.get(r.id)?.fetch ?? {};
      const fetchMs = Object.keys(fetch).length ? new Map(Object.entries(fetch).map(([lane, f]) => [lane, f.ms])) : undefined;
      const base = { id: r.id, makes: this.makes(r), pin: r.pin_machine ?? null, can: able.get(r.id)?.can, ...(fetchMs ? { fetchMs } : {}) };
      const recipe = r.recipe_id === CUT_JOB ? undefined : this.registry.recipe(r.recipe_id);
      if (!recipe) return { ...base, model: null, renderMs: null, loadMs: null };
      const input = readJson<Record<string, unknown>>(r.inputs, {});
      const [warm, cold] = await Promise.all([this.expected(recipe, input, false, r), this.expected(recipe, input, true, r)]);
      // loading ahead renders nothing: its cost is the load alone
      return { ...base, model: modelOf(recipe.inputs, input), renderMs: r.warm ? 0 : warm, loadMs: warm !== null && cold !== null ? Math.max(0, cold - warm) : null };
    }));
  }

  private paceCache: { at: number; value: Promise<Map<string, number>> } | null = null;
  /** Each machine's learned pace (forecast.ts machinePaces), read again once a minute. */
  private paces(): Promise<Map<string, number>> {
    if (!this.paceCache || Date.now() - this.paceCache.at > 60_000) this.paceCache = { at: Date.now(), value: machinePaces(this.db).catch(() => new Map<string, number>()) };
    return this.paceCache.value;
  }

  /** Where each waiting job will probably run and when it starts, as the screens show it: the plan of now, no machine asked again. */
  private async forecastPlan(lanes: Lane[], rows: JobRow[], able: ReadonlyMap<string, Able>): Promise<Map<string, { lane: string; startsInMs: number }>> {
    return plan(await this.schedulable(lanes.filter((l) => !l.paused && l.machine)), await this.planned(rows.filter(needsComfy), able));
  }

  /** What a job makes, as a machine's "takes" reads it: a picture, or a video (a clip, a sound, a finish, a slow motion). */
  private makes(r: JobRow): Waiting["makes"] {
    if (r.recipe_id === CUT_JOB || r.recipe_id === EXPORT_JOB) return "video";
    return this.registry.recipe(r.recipe_id)?.output === "image" ? "image" : "video";
  }

  /** A job started on a lane: claimed there by `run` or `runTool`, and a new pass once it ends. */
  private startOn(lane: Lane, row: JobRow): void {
    lane.starting = row.id;
    this.inflight++;
    const work = row.recipe_id === EXPORT_JOB ? tools.runExport(lane.core, row) : row.recipe_id === CUT_JOB ? tools.runCut(lane.core, row) : this.run(lane, row);
    void work
      .catch((err) => console.error("[queue] a job's lane stopped unexpectedly:", err))
      .finally(() => {
        if (lane.starting === row.id) lane.starting = null;
        this.inflight--;
        void this.pump();
      });
  }

  private retryLater(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.pump();
    }, this.opts.offlineRetryMs);
  }

  /** What the page's status poll (events.ts) found of the ComfyUIs: whether any answered (queueOffline.ts), and each machine's own answer. */
  /**
   * A machine that cannot take work now, and why: a rented pod that is not running (rented.ts sets it). It is never asked,
   * never planned for; what is pinned to it waits for it. Asked at each pass.
   */
  unavailable: (machine: string) => string | null = () => null;
  /** What is said of a rented machine on its row (rented.ts); null for a ComfyUI of its own. */
  rentedOf: (machine: Machine) => view.RentedRow | null = () => null;
  /**
   * Whether a job this long (ms, null: not known) ends on a rented pod before RunPod's balance does (rented.ts fitsBalance):
   * at zero RunPod stops every pod, the render lost. One that does not is not sent to a rented pod.
   */
  fitsBalance: (ms: number | null) => { ok: boolean; leftMs: number | null } = () => ({ ok: true, leftMs: null });

  /** How long a job would take on this machine, loading its model included, at the machine's learned pace (ms); null: not known. */
  private async lengthOn(r: JobRow, machine: string): Promise<number | null> {
    const recipe = r.recipe_id === CUT_JOB || r.recipe_id === EXPORT_JOB ? undefined : this.registry.recipe(r.recipe_id);
    if (!recipe) return null;
    const ms = await this.expected(recipe, readJson<Record<string, unknown>>(r.inputs, {}), true, r);
    return ms === null ? null : ms * ((await this.paces()).get(machine) ?? 1);
  }

  /**
   * The files the plan needs on rented pods, asked for: a job planned onto a pod lacking only files has them sent there
   * first ("need"); one planned elsewhere has its files sent to the pods that lack them, for later ("ahead"). Nothing is
   * fetched that no waiting job asks for.
   */
  private sendFiles(rows: JobRow[], able: ReadonlyMap<string, Able>, where: ReadonlyMap<string, { lane: string }>): void {
    if (!this.podFetch) return;
    for (const r of rows) {
      const fetch = able.get(r.id)?.fetch ?? {};
      const on = where.get(r.id)?.lane;
      for (const [lane, f] of Object.entries(fetch)) this.podFetch.want(lane, f.files, lane === on ? "need" : "ahead", lane === on ? r.id : undefined, f.packs);
    }
  }

  /** Whether a job planned onto this machine has its files there: always, unless it is a pod still getting them. */
  private filesThere(r: JobRow, lane: Lane, able: ReadonlyMap<string, Able>): boolean {
    if (!able.get(r.id)?.fetch[lane.id]) return true;
    return this.podFetch?.jobState(lane.id, r.id) === "ready";
  }

  /** What keeps a job off a rented pod for its balance: null when it ends there before the balance does. */
  private async balanceLack(r: JobRow, lane: Lane): Promise<Lack["balance"] | null> {
    if (!lane.machine?.rented) return null;
    const need = await this.lengthOn(r, lane.id);
    const fit = this.fitsBalance(need);
    return fit.ok || need === null || fit.leftMs === null ? null : { leftMs: fit.leftMs, needMs: need };
  }

  /** Rented pods' files: set by services.ts. */
  podFetch: PodFetch | null = null;

  /** Something a waiting job may wait for changed (a file came to a pod, or failed there): the line is read again. */
  nudge(): void {
    void this.pump();
  }

  /** Whether a machine runs a job now, or is starting one. */
  runningOn(machine: string): boolean {
    const lane = this.lanes.get(machine);
    return Boolean(lane?.running || lane?.starting);
  }

  /**
   * How long the render a machine runs has been past its forecast and silent (no step, no node, no preview from ComfyUI,
   * its GPU idle):
   * the shorter of the two, so that a render known to be long is never taken for stuck before its time. 0 when it runs
   * nothing, or a render not sent yet.
   */
  quietFor(machine: string): number {
    const run = this.lanes.get(machine)?.running;
    if (!run?.promptId || !run.movedAt || !run.startedAt) return 0;
    const now = Date.now();
    const pastForecast = run.expectedMs ? now - run.startedAt - run.expectedMs : Infinity;
    return Math.max(0, Math.min(now - run.movedAt, pastForecast));
  }

  /**
   * The renders under way and how long each has moved by nothing (no step, no node, no preview from ComfyUI, its GPU idle),
   * on every machine: what a render stuck is told by (notify.ts), well before a rented pod's is failed (rented.ts).
   */
  stillFor(): Array<{ job: string; machine: string; ms: number }> {
    const now = Date.now();
    return this.machineLanes().flatMap((l) => (l.running?.promptId && l.running.movedAt && l.running.gpu ? [{ job: l.running.id, machine: l.id, ms: now - l.running.movedAt }] : []));
  }

  /** A machine's ComfyUI went while it rendered: told once, until it answers again. `label`: the render's, when known. */
  private sayGone(lane: Lane, label: string | null): void {
    if (!this.tell || this.goneSaid.has(lane.id)) return;
    this.goneSaid.add(lane.id);
    const name = lane.machine ? machineSaid(lane.machine) : "ComfyUI";
    this.tell("comfyGone", { title: `${name} is offline`, body: `It stopped answering while it rendered${label ? ` ${label}` : ""}. The render is queued again while attempts remain.`, key: lane.id });
  }

  /** Fail the render a machine runs as stuck, with what to say, and drop it in its ComfyUI. Whether there was one. */
  async endStuck(machine: string, why: string): Promise<boolean> {
    const lane = this.lanes.get(machine);
    const run = lane?.running;
    if (!run?.promptId || run.abort.signal.aborted) return false;
    run.abort.abort(new Stuck(why));
    await lane!.comfy?.client.interrupt(run.promptId).catch(() => {});
    return true;
  }

  /**
   * Whether a machine is at work or has work: a job running or starting there, or a waiting render the plan gives it (one
   * pinned to it that can run there, or one that ends sooner there than anywhere else, its files' coming counted). Paused,
   * it has none. For a rented machine's idle time: a pod that could run a job the plan sends elsewhere (this computer is
   * sooner), or a job pinned to it that can never run there (a file it cannot get), has none, and is not billed for it.
   */
  async wants(machine: string): Promise<boolean> {
    const lane = this.lanes.get(machine);
    if (lane?.running || lane?.starting) return true;
    if (this.paused || lane?.paused) return false;
    // the jobs that may start now, as a pass plans them: one that waits for another job (a clip after the one it continues), or
    // held back by an update, is no work yet: it would keep a pod billed for a start that cannot come
    const active = await this.db.selectFrom("jobs").selectAll().where("status", "in", ["queued", "running"]).orderBy("priority").orderBy("created_at").execute();
    const waitingOn = new Set(active.map((r) => r.id));
    const rows = active.filter((r) => r.status === "queued" && needsComfy(r) && !(r.depends_on && waitingOn.has(r.depends_on)) && !(this.only && !this.only.has(r.id)));
    if (!rows.length) return false;
    const open = (await this.refresh()).filter((l) => !l.paused && l.machine);
    const where = plan(await this.schedulable(open), await this.planned(rows, await this.ableOf(rows)));
    return rows.some((r) => where.get(r.id)?.lane === machine);
  }

  noteReachable(ok: boolean, each: ReadonlyMap<string, boolean> = new Map()): void {
    // each machine's own answer: a paused or idle machine is asked nothing by the queue, and was shown online after its
    // ComfyUI had stopped (and away after it was back, until a job went to it)
    let changed = false;
    for (const lane of this.machineLanes()) {
      const answered = each.get(lane.id);
      if (answered === undefined || lane.reachable === answered) continue;
      lane.reachable = answered;
      changed = true;
      if (answered) this.goneSaid.delete(lane.id);
      else if (lane.running?.gpu) this.sayGone(lane, null);
    }
    this.offline.noteReachable(ok);
    if (changed) {
      this.events.emit("queue");
      // one back: what waited for it may go now
      void this.pump();
    }
  }

  /** A job ends. `from`: only when it is still in that state (a job that was cancelled meanwhile stays cancelled). */
  private async finish(id: string, status: "done" | "failed" | "cancelled", extra: { error?: string; generationId?: string; trace?: string | null } = {}, from?: JobRow["status"]) {
    // a generation the job wrote before it ended badly stays named on it: what it made is in the library all the same
    let q = this.db
      .updateTable("jobs")
      .set({ status, error: extra.error ?? null, error_trace: extra.trace ?? null, ...(extra.generationId ? { generation_id: extra.generationId } : {}), finished_at: now(), updated_at: now() })
      .where("id", "=", id);
    if (from) q = q.where("status", "=", from);
    const ended = Number((await q.executeTakeFirst()).numUpdatedRows) > 0;
    if (status !== "done") await this.failDependents(id);
    this.events.emit("queue");
    // what is told of a job's end (notify.ts): once, by the call that ended it
    if (ended) this.events.emit("ended", id, status);
    // only a clip's render, a cut or an export changes a timeline: a picture's end does not read them again
    const of = await this.db.selectFrom("jobs").select(["clip_id", "timeline_id"]).where("id", "=", id).executeTakeFirst();
    if (of?.clip_id || of?.timeline_id) this.events.emit("timeline");
  }

  /** The jobs that wait on this one can never run now: each fails (and what waits on those), whichever way this one ended. */
  private async failDependents(id: string): Promise<void> {
    const dependents = await this.db.selectFrom("jobs").select("id").where("depends_on", "=", id).where("status", "=", "queued").execute();
    for (const d of dependents) await this.finish(d.id, "failed", { error: "the clip it continues was not rendered" }, "queued");
  }

  /** Something that went less well than asked in a job that goes on: said on the job (and in the log), not only in the log. */
  private async warn(id: string, text: string): Promise<void> {
    console.warn(`[queue] job ${id}: ${text}`);
    const had = (await this.db.selectFrom("jobs").select("warning").where("id", "=", id).executeTakeFirst())?.warning;
    if (had?.includes(text)) return;
    await this.db.updateTable("jobs").set({ warning: had ? `${had} ${text}` : text, updated_at: now() }).where("id", "=", id).execute();
  }

  /**
   * A job that needs no model: a cut or an export, done by ffmpeg on the computer Afflatus runs on (a finish or a RIFE
   * slow-motion takes a machine's GPU for a while all the same, on that machine's lane). Claimed in one statement, so that a
   * cancel landing at the same moment wins; on a shutdown it is queued again for the next start, stopped by hand it is
   * cancelled, anything else it threw is its failure.
   */
  private async runTool(lane: Lane, row: JobRow, work: (run: Running) => Promise<void>): Promise<void> {
    const machine = lane.id === TOOLS ? null : lane.id;
    const claimed = await this.db
      .updateTable("jobs")
      .set({ status: "running", attempts: row.attempts + 1, started_at: now(), updated_at: now(), machine_id: machine })
      .where("id", "=", row.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return;
    const run: Running = { id: row.id, machine, abort: new AbortController(), gpu: false, tool: row.recipe_id === EXPORT_JOB ? "exporting" : "cutting" };
    lane.running = run;
    lane.starting = null;
    this.events.emit("queue");
    try {
      await work(run);
      await this.finish(row.id, "done");
    } catch (err) {
      if (this.stopped) await this.db.updateTable("jobs").set({ status: "queued", updated_at: now() }).where("id", "=", row.id).execute();
      else if (run.abort.signal.aborted) await this.finish(row.id, "cancelled", { error: "stopped by you" });
      else await this.failure(row, run.promptId, err as Error);
    } finally {
      lane.running = null;
      // a finish or a RIFE pass loaded models into ComfyUI: the idle unload counts from its end, as after a render
      if (run.gpu) {
        lane.holds = true;
        void this.armIdle(lane);
      }
    }
  }

  private async run(lane: Lane, row: JobRow): Promise<void> {
    const comfy = lane.comfy!;
    const core = lane.core;
    const recipe = this.registry.recipe(row.recipe_id);
    if (!recipe) return this.finish(row.id, "failed", { error: `the recipe ${row.recipe_id} no longer exists` });
    let resume = readJson<Resume | null>(row.resume, null);
    // saved just before its prompt was sent, by a process that did not hear back (it stopped, ComfyUI did not answer): ComfyUI is
    // asked whether it took that prompt, which is then followed; one it never had is sent again. Kept for a requeue until then
    let held = resume?.unsent ? resume : null;
    if (held) {
      const { unsent: _, ...sent } = held;
      resume = (await submitting.taken(comfy, held.promptId).catch(() => false)) ? sent : null;
      if (resume) await this.db.updateTable("jobs").set({ resume: JSON.stringify(resume), updated_at: now() }).where("id", "=", row.id).execute();
    }
    // a render this process finds already under way is not measured from its first moment
    const whole = !resume;
    let measured: Measured | null = null;
    let made: string | undefined;
    const attempts = row.attempts + (resume ? 0 : 1);
    // claim it in one statement: a cancel that landed while ComfyUI was being pinged wins
    const claimed = await this.db
      .updateTable("jobs")
      .set({ status: "running", attempts, started_at: row.started_at ?? now(), updated_at: now(), machine_id: lane.id })
      .where("id", "=", row.id)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return;

    const abort = new AbortController();
    /** The prompt followed from before it was sent (see the hold below): no longer followed once the job ends, however it ends. */
    let early: string | null = null;
    const running: Running = { id: row.id, machine: lane.id, abort, promptId: resume?.promptId, gpu: true, expectedMs: resume?.timing?.expectedMs ?? null, startedAt: resume?.startedAt ?? Date.now() };
    lane.running = running;
    lane.starting = null;
    // a job starts there only once its ComfyUI answers: a going away after this one is told again
    this.goneSaid.delete(lane.id);
    if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
    lane.unloadTimer = null;
    lane.holds = true;
    this.events.emit("queue");
    try {
      // a job found with its generation already named had filed its result before this process last stopped: it is closed, not rendered again
      if (row.generation_id && !row.warm) return await this.closeFiled(row, row.generation_id, resume);
      const input = JSON.parse(row.inputs) as Record<string, unknown>;
      if (!resume) {
        // a Stop while its files go up ends it there, before ComfyUI frees its memory or is sent anything (checked again below
        // for one pressed while the prompt was on its way)
        resume = await submitting.submit(core, comfy, recipe, input, row, async (r) => {
          held = r;
          await this.db.updateTable("jobs").set({ resume: JSON.stringify(r), updated_at: now() }).where("id", "=", row.id).execute();
          // followed from before it is sent, under the id it is sent with: what ComfyUI says at once (the passes it still had
          // cached, execution_cached) arrives before submit returns, and was lost when the prompt was tracked only after it
          comfy.monitor.track({ promptId: r.promptId, totalSteps: r.totalSteps, phases: r.phases, passes: r.passes, clientId: r.clientId, expect: r.timing?.expect });
          early = r.promptId;
        }, abort.signal);
        // a ComfyUI from before prompt ids could be chosen gave one of its own: that one is followed instead
        if (early && early !== resume.promptId) comfy.monitor.untrack(early);
        await this.db.updateTable("jobs").set({ resume: JSON.stringify(resume), updated_at: now() }).where("id", "=", row.id).execute();
        if (resume.warnings?.length) await this.warn(row.id, resume.warnings.join(" "));
      }
      running.promptId = resume.promptId;
      running.titles = resume.titles;
      // a fresh render learns how long it should take only once it is sent: the spilling warning needs it from the first run on
      running.expectedMs ??= resume.timing?.expectedMs ?? null;
      running.startedAt = resume.startedAt;
      running.movedAt = Date.now();
      running.seed = resume.seed;
      if (abort.signal.aborted) {
        // stopped by hand: ComfyUI drops it too; shutting down leaves it there for the next start (SHUTDOWN)
        if (abort.signal.reason !== SHUTDOWN) await comfy.client.interrupt(resume.promptId).catch(() => {});
        throw new ComfyCancelled();
      }
      comfy.monitor.ensure();
      // after a restart this process has a new client id: the monitor then listens under the one that queued it
      // and its step count goes on from the one saved: which pass runs cannot tell it when one node samples chunk after chunk
      comfy.monitor.track({ promptId: resume.promptId, totalSteps: resume.totalSteps, phases: resume.phases, passes: resume.passes, clientId: resume.clientId, expect: resume.timing?.expect, stepsDone: resume.stepsDone });
      const saving = this.stepsSaver(row.id, resume, comfy);
      // a busy GPU is a render at work too: a node that says nothing on the way (a long decode, an interpolation) is not
      // taken for stuck while it computes; a render that hangs leaves its GPU idle. Its memory says nothing: it stays full
      comfy.monitor.onSystem = (load) => {
        if (load.gpus.some((g) => (g.load ?? 0) >= GPU_AT_WORK)) running.movedAt = Date.now();
      };
      comfy.monitor.onChange = () => {
        running.movedAt = Date.now();
        this.events.emit("progress");
        saving.check();
      };
      // steps ComfyUI reported before this was listening (the prompt is followed from before it is sent, and the writes
      // since then let its first progress in) are saved now, not at the next step
      saving.check();
      let outputs;
      try {
        outputs = await waitForOutputs(comfy.client, resume.promptId, { ...this.opts.wait, signal: abort.signal });
      } finally {
        measured = comfy.monitor.measured(resume.promptId);
        comfy.monitor.untrack(resume.promptId);
        // a save under way lands before the job is closed or queued again, never over what that writes
        await saving.settled();
      }
      // ComfyUI is done with it: its model is no longer in use, and freeing the memory is no longer refused (the lane's job
      // stays until the job is closed, for a cancel and the queue screen)
      running.gpu = false;
      const tookMs = Date.now() - resume.startedAt;
      if (row.warm) {
        // the models are loaded, which is all that was asked
        await this.finish(row.id, "done");
        return;
      }
      const generationId = await storing.store(core, comfy, recipe, resume.input ?? input, resume, outputs, row);
      made = generationId;
      await this.place(row, generationId, resume);
      // on record before the job says done: a screen told it is done reads its time with it (the forecast, the stats)
      await this.note(lane, row, recipe, resume, measured, "done", whole, tookMs, generationId);
      await this.finish(row.id, "done", { generationId });
      this.events.emit("library", await addedBy(this.db, generationId));
    } catch (err) {
      await this.failed(err as Error, lane, row, recipe, { resume, held, measured, made, whole, attempts, aborted: abort.signal.aborted });
    } finally {
      if (early) comfy.monitor.untrack(early);
      lane.running = null;
      void this.armIdle(lane);
    }
  }

  /**
   * Keeps the running render's step count on its job (Resume.stepsDone) for a process started again mid-render: at most
   * every few seconds (QueueOptions.stepsSaveMs), only when it went up, one write at a time: never a write per step.
   */
  private stepsSaver(jobId: string, resume: Resume, comfy: Comfy) {
    const every = this.opts.stepsSaveMs ?? STEPS_SAVE_MS;
    let kept = { steps: resume.stepsDone ?? 0, at: 0 };
    let writing: Promise<unknown> = Promise.resolve();
    return {
      check: () => {
        const steps = comfy.monitor.progress(resume.promptId).step;
        if (steps <= kept.steps || Date.now() - kept.at < every) return;
        kept = { steps, at: Date.now() };
        const saved = JSON.stringify({ ...resume, stepsDone: steps });
        writing = writing
          .then(() => this.db.updateTable("jobs").set({ resume: saved, updated_at: now() }).where("id", "=", jobId).where("status", "=", "running").execute())
          .catch(() => {});
      },
      settled: () => writing,
    };
  }

  /**
   * Its take on the clip, before the job closes (the two arrive on screen together). A clip that cannot take
   * it (removed meanwhile, a fault here) is no reason to call the render failed: it is said on the job. A job
   * picked up again after a crash finds its take placed and places none.
   */
  private async place(row: JobRow, generationId: string, resume: Resume | null): Promise<void> {
    if (!row.clip_id || !this.clips) return;
    await this.clips.finished(row.clip_id, generationId, resume?.overlap, resume?.links ?? {}, row.finished_from).catch((err: Error) => this.warn(row.id, `Its take was not placed on its clip: ${err.message}`));
  }

  /** A job whose result was filed before this process stopped: its take placed when it was not yet, and the job closed. */
  private async closeFiled(row: JobRow, generationId: string, resume: Resume | null): Promise<void> {
    await this.place(row, generationId, resume);
    await this.finish(row.id, "done", { generationId });
    this.events.emit("library", await addedBy(this.db, generationId));
  }

  /** How a render ended that did not finish: stopped by hand, lost by ComfyUI (queued again while attempts remain), or failed; never while shutting down. */
  private async failed(err: Error, lane: Lane, row: JobRow, recipe: Recipe<any>, at: { resume: Resume | null; held?: Resume | null; measured: Measured | null; made?: string; whole: boolean; attempts: number; aborted: boolean }): Promise<void> {
    const { resume, measured, made, whole } = at;
    // what never reached ComfyUI took no GPU time: only a render that was under way is put on record
    const onRecord = resume && !made && !row.warm;
    if (this.stopped) {
      // shutting down: leave the row as it is, the next start picks it up
    } else if (at.aborted && lane.running?.abort.signal.reason instanceof Stuck) {
      // stuck on a rented GPU: a failure, said as such, not a stop by the user
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
      await this.failure(row, resume?.promptId ?? at.held?.promptId, new Error((lane.running.abort.signal.reason as Stuck).message));
    } else if (err instanceof ComfyCancelled || at.aborted) {
      // on record before the job says how it ended, as a render that is done
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "cancelled", whole, Date.now() - resume.startedAt);
      await this.finish(row.id, "cancelled", { error: "stopped by you" });
    } else if ((err instanceof ComfyLost || err instanceof ComfyUnreachable) && Math.max(at.attempts, row.attempts + 1) < this.opts.maxAttempts) {
      console.warn(`[queue] job ${row.id} lost (${err.message}), queued again`);
      if (resume) this.sayGone(lane, row.label);
      // ComfyUI may have the prompt all the same: one sent without an answer (it did not answer in time), and one it finished
      // or still runs while this process lost sight of it (90 s of silence, its file not fetched). Its id is kept, so that the
      // next attempt asks ComfyUI for it (taken) and follows it, instead of rendering again a video that would come out different
      const kept = resume ?? at.held;
      const unsent = kept && !made ? JSON.stringify({ ...kept, unsent: true }) : null;
      // each loss counts as an attempt, a prompt followed again too: one that keeps getting lost is given up in the end
      await this.db.updateTable("jobs").set({ status: "queued", resume: unsent, attempts: Math.max(at.attempts, row.attempts + 1), warning: null, updated_at: now() }).where("id", "=", row.id).where("status", "=", "running").execute();
      this.events.emit("queue");
    } else {
      if (resume && (err instanceof ComfyLost || err instanceof ComfyUnreachable)) this.sayGone(lane, row.label);
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
      await this.failure(row, resume?.promptId ?? at.held?.promptId, err);
    }
  }

  /**
   * A job failed: closed with its message and, when ComfyUI sent one, the end of its traceback (ComfyFailed), and said in
   * the log with what finds it again (the job, its prompt, its recipe). An error that is none of ComfyUI's is a fault here:
   * its stack goes to the log too, which is where it is read.
   */
  private async failure(row: JobRow, promptId: string | undefined, err: Error): Promise<void> {
    const comfys = err instanceof ComfyFailed || err instanceof ComfyError || err instanceof ComfyUnreachable || err instanceof ComfyLost || err instanceof ComfyCancelled;
    console.error(`[queue] job ${row.id} failed (prompt ${promptId ?? "not sent"}, ${row.recipe_id}): ${err.message}`);
    if (!comfys && err.stack) console.error(err.stack);
    await this.finish(row.id, "failed", { error: err.message.slice(0, 600), trace: err instanceof ComfyFailed ? err.failure?.traceback || null : null });
  }

  /** Put a render on the record of render times (renders.ts), under the machine it ran on. Never in the way of the render itself: a failure here is only said. */
  private async note(lane: Lane, row: JobRow, recipe: Recipe<any>, resume: Resume, measured: Measured | null, status: "done" | "failed" | "cancelled", whole: boolean, totalMs: number, generationId?: string): Promise<void> {
    try {
      await record(this.db, row, recipe, resume, measured, status, whole, totalMs, generationId, { machine: lane.id, gpu: lane.comfy?.monitor.system?.gpus[0]?.name ?? null });
      this.known = null;
    } catch (err) {
      console.warn(`[queue] the time of job ${row.id} was not put on record: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- a form against a ComfyUI (queueSubmit.ts)

  /** The graph a form (or a past render) gives, built without uploading anything; null when the form is not complete enough to build. */
  builtOf(recipeId: string, rawInput: unknown, opts: Parameters<typeof submitting.builtOf>[3] = {}): Promise<BuiltGraph | null> { return submitting.builtOf(this.core, recipeId, rawInput, opts); }
  /** Whether the base models a form would use are the ones the first ComfyUI was last asked to load; null when it cannot be told. */
  isLoaded(recipeId: string, rawInput: unknown): Promise<boolean | null> { return submitting.isLoaded(this.core, recipeId, rawInput); }
  /** The machine whose ComfyUI holds the base models a form would use (the first such); null when none does, or it cannot be told. */
  async loadedOn(recipeId: string, rawInput: unknown): Promise<string | null> {
    for (const lane of await this.refresh()) if (await submitting.isLoaded(lane.core, recipeId, rawInput)) return lane.id;
    return null;
  }
  /** What this model's past renders say a form will take; null without history or for a form not complete enough to build. */
  forecast(recipeId: string, rawInput: unknown, opts: { finishedFrom?: string | null; clip?: { id: string; fit: boolean } | null } = {}) { return submitting.forecastOf(this.core, recipeId, rawInput, opts); }
}
