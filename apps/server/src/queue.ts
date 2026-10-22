import { EventEmitter } from "node:events";
import { ComfyAway, ComfyCancelled, ComfyError, ComfyFailed, ComfyLost, ComfyUnreachable, systemLoadFromStatus, waitForOutputs, type Measured } from "@afflatus/comfy";
import { expandWildcards, modelFileName, modelOf, parseInput, removedSaid, type BuiltGraph, type InputSpec, type Recipe } from "@afflatus/core";
import { Comfy, NO_COMFY_URL, type MachineComfy } from "./comfy";
import { newId, now, OWNER, type Db } from "./db";
import { addedBy } from "./events";
import { httpError } from "./errors";
import type { HuntSummary } from "./hunt";
import { paceOf } from "./forecast";
import { gathering, observeAdded, observePart } from "./serverMetrics";
import type { Registry } from "./registry";
import { record } from "./renders";
import { machineSaid, type Say } from "./notifyWords";
import type { PodFileView } from "./podFiles";
import { plan, planTotal } from "./schedule";
import { FIRST_MACHINE, readSettings, type Machine } from "./settings";
import { reportsDeath } from "./runpod";
import type { Storage } from "./storage";
import type { CutOptions, ExportOptions, Timelines } from "./timelines";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";
import { CAP_REACHED, DEFAULT_QUEUE_OPTIONS, Died, GPU_AT_WORK, readJson, SHUTDOWN, Stuck, type JobRow, type QueueCore, type Lane, type QueueOptions, type Resume, type Running } from "./queueModel";
import * as bulk from "./queueBulk";
import { needsComfy, Offline } from "./queueOffline";
import * as submitting from "./queueSubmit";
import * as storing from "./queueStore";
import * as tools from "./queueTools";
import * as view from "./queueView";
import { Forecasts } from "./queueForecast";
import { Planner, type Able, type PodFetch } from "./queuePlan";
import { loadedOn, type Loaded } from "./jobFiles";
import { Outside, outsideBusy } from "./queueOutside";
import { OwnPacks } from "./queuePacks";
import { cannotWhy, packsSaid } from "./jobPacks";
import { formPacks, type FormPackNote } from "./formPacks";

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
/** Pause all with several machines, kept until a Resume: a machine that joins meanwhile joins paused (readLane). */
const PAUSED_ALL_KEY = "queue.pausedAll";
/** The name of the model among them that a person knows it by, to say which one is loaded. The first machine's keys are the ones from before there were several. */
const MODEL_KEY = "queue.model";
/** The base models the last job had a ComfyUI load, kept across restarts of this app (ComfyUI keeps running through them). */
const LOADS_KEY = "queue.loads";
const keyOf = (key: string, machine: string) => (machine === FIRST_MACHINE ? key : `${key}.${machine}`);
/** At most how often a running render's step count is saved on its job, when the options do not say. */
const STEPS_SAVE_MS = 5_000;
/** How often a render's machine is read for its RAM (its peak, render_stats.ram_peak): a small read of ComfyUI's own. */
const RAM_EVERY_MS = 10_000;
/** How recent a read of the GPU's load must be for a silent render's GPU to be known idle: system feeds report every few seconds. */
const LOAD_FRESH_MS = 2 * 60_000;
/**
 * How long past its forecast a render whose GPU load is not read may stay silent before its silence counts as stuck: at most
 * this, and at most its forecast again. Forecasts have run 1.3 to 25 times too long, and a pod is billed all the while.
 */
const FORECAST_SLACK_MS = 10 * 60_000;
/** The lane of the jobs that need no ComfyUI. */
const TOOLS = "tools";
/** Whether a render was lost because its machine stopped answering (silent past the wait, or not reached at all), not because its ComfyUI answered without the prompt. */
const awayErr = (err: Error) => err instanceof ComfyAway || err instanceof ComfyUnreachable;

/**
 * The GPU a machine's render is recorded under (render_stats.gpu): the one its ComfyUI says it renders on, its first device
 * ("cuda:0 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync" read as its name), else the system feed's when it reports one card.
 * The feed lists every card of the computer in its own order: its first is not the one rendering on a computer with two.
 * Null when neither says.
 */
export function gpuOf(device: string | null, gpus: ReadonlyArray<{ name: string }>): string | null {
  const name = (device ?? "").replace(/^\w+:\d+\s+/, "").replace(/\s+:\s+\S+$/, "").trim();
  if (name && name.toLowerCase() !== "cpu") return gpus.find((g) => g.name.toLowerCase() === name.toLowerCase())?.name ?? name;
  return gpus.length === 1 ? gpus[0]!.name : null;
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
  /** The forecasts, kept while the record of render times does not change (queueForecast.ts). */
  private readonly forecasts: Forecasts;
  /** The plan the scheduler is given at each pass (queuePlan.ts). */
  private readonly planner: Planner;
  /** Work from outside Afflatus on each machine's ComfyUI (queueOutside.ts). */
  private readonly outside: Outside;
  /** The node packs renders ask for on the machines of the user's own: installed there, and ComfyUI restarted (queuePacks.ts). */
  readonly ownPacks: OwnPacks;
  private retry: NodeJS.Timeout | null = null;
  /** The machines of the user's own a job waits on for files, read again when filesRetry fires (filesWait). */
  private filesRetry: NodeJS.Timeout | null = null;
  private readonly filesWaitOn = new Set<string>();
  private stopped = false;
  /** While an update waits for the queue (updates.ts): only these jobs may start, the rest wait for the new version. Null: any. */
  private only: ReadonlySet<string> | null = null;
  /** The timelines, for jobs that render a clip of one (set once both exist). */
  clips: Timelines | null = null;
  /** Where what the user is told of goes (notify.ts; set by services.ts): a ComfyUI gone mid-render. Null: nothing is said. */
  tell: Say | null = null;
  /**
   * Told every read of a machine's work from outside Afflatus, changed or not (set by services.ts): a rented pod's time at
   * that work is kept for the Costs tab (podOutside.ts), its last sight with it. Null: not kept.
   */
  onOutside: ((machine: string, outside: { running: number; pending: number } | null) => void) | null = null;
  /** The machines a ComfyUI gone mid-render was said of, until they answer again: said once, however it is found out. */
  private goneSaid = new Set<string>();
  /**
   * Told when a rented pod's ComfyUI is found started again without the render it ran (an older pod image, whose ComfyUI was
   * the container itself: its death restarted it, and said nothing): rentedFollow terminates the pod as a crash, with why.
   */
  podCrashed: ((machine: string, why: string) => void) | null = null;
  /** Asked once before a render lost on a deployed pod goes again: whether its ComfyUI died there (rentedFollow diedLate). */
  diedLate: ((machine: string) => Promise<{ said: string; report: Record<string, unknown> | null } | null>) | null = null;
  /** The render a machine's ComfyUI died under (machineDied), by machine: that render's end is that death, whatever its wait saw. */
  private readonly died = new Map<string, Died>();

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
      fail: async (r, error) => {
        if (!(await this.finish(r.id, "failed", { error }, r.status))) return;
        // given up while every machine was away: the one that had its prompt may render it on unseen once it is back
        const sent = readJson<{ promptId?: unknown }>(r.resume, {}).promptId;
        if (typeof sent === "string") this.interruptOn(r.machine_id, sent, true);
      },
      pausedFor: (r) => {
        const machine = r.pin_machine ?? this.heldOn(r);
        return Boolean(machine && this.lanes.get(machine)?.paused);
      },
    });
    // a machine got a file, or its families were switched: a job that waited for one may go there now
    this.events.on("setup", () => void this.pump());
    this.forecasts = new Forecasts({
      db,
      machines: () => this.machineLanes().map((l) => l.id),
      forecastOf: (recipeId, input, o) => submitting.forecastOf(this.core, recipeId, input, o),
    });
    // read through the queue at each call: services.ts sets the balance checks and the pods' files after the queue is made,
    // and a test may stand in for `expected`
    const self = this;
    this.planner = new Planner({
      db, registry,
      machineLanes: () => this.machineLanes(),
      lane: (id) => this.lanes.get(id),
      unavailable: (machine) => this.unavailable(machine),
      get podFetch() { return self.podFetch; },
      heldOn: (r) => this.heldOn(r),
      allPaused: () => this.allPaused(),
      retryLater: () => this.retryLater(),
      filesWait: (machine) => this.filesWait(machine),
      paces: () => this.forecasts.paces(),
      expected: (recipe, input, cold, job, machine) => this.expected(recipe, input, cold, job, machine),
      expectedAll: (recipe, input, cold, job) => this.forecasts.expectedAll(recipe, input, cold, job),
      fitsBalance: (ms) => this.fitsBalance(ms),
      balanceNeed: (machine, recipeId, renderMs, fetchMs) => this.balanceNeed(machine, recipeId, renderMs, fetchMs),
      // a machine of the user's own builds the options whose packs cannot come there without them, as its render will
      loaded: async (r, lane, scan) => loadedOn(this.core, r, { id: lane.id, comfy: lane.comfy!, scan }, lane.machine?.rented ? {} : { facts: await this.ownPacks.facts(lane), said: packsSaid(r) }),
      packsCannot: async (lane, packs) => {
        const facts = await this.ownPacks.facts(lane);
        const p = packs.find((x) => cannotWhy(facts, x));
        return p ? `the node pack ${p}: ${cannotWhy(facts, p)}` : null;
      },
    });
    this.ownPacks = new OwnPacks({
      lane: (id) => this.lanes.get(id),
      manager: (comfy) => this.managerOf(comfy),
      downloading: (comfy) => this.downloadingIn(comfy),
      changed: () => {
        this.events.emit("queue");
        void this.pump();
      },
    });
    this.outside = new Outside({
      db, events: this.events,
      machineLanes: () => this.machineLanes(),
      stale: (machine) => this.stale.get(machine),
      stopped: () => this.stopped,
      onOutside: (machine, outside) => this.onOutside?.(machine, outside),
      pump: () => void this.pump(),
    });
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
      id, machine: null, comfy: null, running: null, starting: null, holds: false, unloadTimer: null, lastLoads: null, lastModel: null, paused: false, reachable: null, device: null,
      outside: null, outsideAt: 0, outsideRead: null, outsideAgain: false,
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
      usual: () => this.forecasts.usual(),
      statRows: (modelFile) => this.forecasts.statRows(modelFile),
      paces: () => this.forecasts.paces(),
      expected: (recipe, input, cold, job, machine) => this.expected(recipe, input, cold, job, machine),
      loadsModel: async (recipe, input, job) => modelOf(recipe.inputs, input) ?? (await this.forecasts.expectedAll(recipe, input, false, job ?? null)).model,
      runTool: (row, work) => this.runTool(l, row, work),
      packFacts: () => this.ownPacks.facts(l),
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
      // its ComfyUI's queue changed (a prompt queued from its own page, one done): whose its prompts are is read again
      if (lane.comfy?.monitor) lane.comfy.monitor.onQueue = () => void this.outside.readOutside(lane);
      return lane;
    });
    // a machine taken out of the settings: its lane goes once it is idle
    for (const [id, lane] of this.lanes) {
      if (id === TOOLS || all.some((m) => m.machine.id === id) || lane.running || lane.starting) continue;
      if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
      this.lanes.delete(id);
    }
    await this.unpinGone(all.map((m) => m.machine.id));
    await Promise.all(lanes.map((l) => l.ready));
    return lanes;
  }

  /** The machines the pins were last checked against (unpinGone), one id a line. */
  private pinnedAgainst: string | null = null;

  /**
   * A machine taken out (a pod terminated, a machine removed in the settings, while this process ran or not): the jobs
   * pinned to it go to any machine, instead of waiting for one that will not come back (and holding an update's wait).
   * Checked once each time the machines change, not at every pass.
   */
  private async unpinGone(ids: string[]): Promise<void> {
    const key = ids.join("\n");
    if (!ids.length || key === this.pinnedAgainst) return;
    this.pinnedAgainst = key;
    const freed = await this.db.updateTable("jobs").set({ pin_machine: null, updated_at: now() })
      .where("status", "=", "queued").where("pin_machine", "is not", null).where("pin_machine", "not in", ids).executeTakeFirst();
    if (Number(freed.numUpdatedRows) > 0) this.events.emit("queue");
  }

  private async refreshed(lane: Lane): Promise<Comfy> {
    await this.refresh();
    return lane.comfy ?? this.comfyOfFirst();
  }

  /** With no machine at all, one at an address nothing listens on: what asks it is told ComfyUI does not answer (services.ts). */
  private nowhere: Comfy | null = null;
  private async comfyOfFirst(): Promise<Comfy> {
    return (await this.machines())[0]?.comfy ?? (this.nowhere ??= new Comfy(NO_COMFY_URL, this.registry));
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
    // a finish or a RIFE pass that had sent its prompt (cut short by a crash, or queued again by the last shutdown) waits for
    // the machine that has it (Resume.lostAt, heldOn), which may still render it, and follows it there (queueTools followed):
    // sent to another machine meanwhile, it ran twice, the first one billed on a pod for a result nobody collected
    const sent = await this.db.selectFrom("jobs").select(["id", "resume", "status"]).where("status", "in", ["running", "queued"]).where("recipe_id", "=", CUT_JOB)
      .where("resume", "is not", null).where("machine_id", "is not", null).execute();
    for (const r of sent) {
      const kept = readJson<{ promptId?: unknown; lostAt?: unknown } | null>(r.resume, null);
      if (typeof kept?.promptId !== "string" || kept.lostAt !== undefined) continue;
      await this.db.updateTable("jobs").set({ resume: JSON.stringify({ ...kept, lostAt: Date.now() }) }).where("id", "=", r.id).where("status", "=", r.status).execute();
    }
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
    const own = await value(`${PAUSED_KEY}.${lane.id}`);
    lane.paused = own === "true";
    // a machine never seen before (a pod deployed or started, a machine added) after the user's Pause all of several
    // machines joins paused: that pause is each machine's own, and a newcomer would otherwise take the waiting jobs
    if (own === undefined && (await value(PAUSED_ALL_KEY)) === "true") {
      lane.paused = true;
      await this.setting(`${PAUSED_KEY}.${lane.id}`, "true");
    }
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
    if (this.filesRetry) clearTimeout(this.filesRetry);
    this.ownPacks.stop();
    for (const lane of this.lanes.values()) {
      if (lane.unloadTimer) clearTimeout(lane.unloadTimer);
      lane.running?.abort.abort(SHUTDOWN);
    }
  }

  /** Resolves when nothing is running and nothing can start (tests). */
  async idle(): Promise<void> {
    while (this.dispatching || this.inflight > 0) await new Promise((r) => setTimeout(r, 5));
    // what a finished video is measured after its job closed lands too
    await Promise.all(storing.measuresUnderWay());
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
    // a pin to a machine no longer in the settings (a job done again after its pod was terminated) would wait for ever: no
    // machine takes it, and unpinGone frees pins only when the machines change
    const pin = opts.machine && (await this.machines()).some((m) => m.machine.id === opts.machine) ? opts.machine : null;
    const id = newId();
    const at = now();
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: recipe.id, label: opts.label?.trim() || recipe.title, inputs: JSON.stringify(input), asked,
        status: "queued", warm: opts.warm ? 1 : 0, look: opts.look ? JSON.stringify(opts.look) : null, priority: recipe.output === "image" ? 0 : 10, depends_on: opts.dependsOn ?? null,
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: opts.clip?.id ?? null, clip_fit: opts.clip?.fit ? 1 : 0, clip_mirror: opts.clip?.mirror?.length ? JSON.stringify(opts.clip.mirror) : null,
        draft_id: opts.draft ?? null, folder_id: opts.folder ?? null, finished_from: opts.finishedFrom ?? null, pin_machine: pin,
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

  /**
   * A prompt a job sent to a ComfyUI, stopped there: on the machine the job ran on, or the first one for a job from before
   * there were several. `away`: that machine just stopped answering (a render given up while it was away), whatever its
   * lane last read: it is taken as away until it answers again, which drops the prompt there (back, dropStale).
   */
  private interruptOn(machine: string | null | undefined, promptId: string, away = false): void {
    // a machine not known to answer now may render it on unseen once it is back: the prompt is dropped there then too
    const lane = this.lanes.get(machine ?? this.firstId);
    if (lane?.machine && away) lane.reachable = false;
    if (lane?.machine && lane.reachable !== true) this.stale.set(lane.id, new Set([...(this.stale.get(lane.id) ?? []), promptId]));
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
   * What a form says under its options whose node packs the machine lacks (formPacks.ts): on `machine`, else the first;
   * with the other machines that have them, and that machine's rule (Ask, Always; a pod always installs). Null when its
   * ComfyUI cannot be read.
   */
  async formPacks(recipeId: string, input: Record<string, unknown>, machine?: string): Promise<{ machine: string; rule: "ask" | "always" | "pod"; notes: FormPackNote[] } | null> {
    const recipe = this.registry.recipe(recipeId);
    const lanes = await this.refresh();
    const lane = machine ? lanes.find((l) => l.id === machine) : lanes[0];
    if (!recipe || !lane?.comfy || !lane.machine) return null;
    const catalog = await lane.comfy.catalog().catch(() => null);
    if (!catalog) return null;
    const others = (await Promise.all(lanes.filter((l) => l !== lane && l.comfy && l.reachable !== false && !this.unavailable(l.id)).map(async (l) => {
      const theirs = await l.comfy!.catalog().catch(() => null);
      return theirs ? [{ label: l.machine?.name || l.id, catalog: theirs }] : [];
    }))).flat();
    const notes = await formPacks(lane.core, recipe, input, { catalog, facts: await this.ownPacks.facts(lane) }, others);
    return { machine: lane.id, rule: lane.machine.rented ? "pod" : lane.machine.packs, notes };
  }

  /**
   * What a waiting job's Queue row said of the node packs it waits for (jobPacks.ts): install them (Install and restart), or
   * run without them (Run without, only for what it can do without: an option's pack). False when it no longer waits.
   */
  async sayPacks(id: string, what: "install" | "without", packs: string[]): Promise<boolean> {
    const row = await this.db.selectFrom("jobs").select(["packs", "status"]).where("id", "=", id).executeTakeFirst();
    if (row?.status !== "queued") return false;
    const said = packsSaid(row);
    const other = what === "install" ? "without" : "install";
    const next = { ...said, [what]: [...new Set([...(said[what] ?? []), ...packs])], [other]: (said[other] ?? []).filter((p) => !packs.includes(p)) };
    await this.db.updateTable("jobs").set({ packs: JSON.stringify(next), updated_at: now() }).where("id", "=", id).where("status", "=", "queued").execute();
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
    // nor where ComfyUI runs work from outside Afflatus: its models are in use, by someone else
    const free = asked.filter((l) => !l.running?.gpu && !outsideBusy(l));
    if (!free.length) {
      throw httpError(asked.some((l) => !l.running?.gpu) ? "ComfyUI is busy with work queued outside Afflatus, and its models are in use. Wait for it to end." : "A render is under way and its model is loaded. Wait for it, or cancel it first.");
    }
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
  cancelWaiting(ids?: readonly string[]) { return bulk.cancelWaiting(this.core, (id) => this.failDependents(id), (machine, promptId) => this.interruptOn(machine, promptId), ids); }

  /**
   * About how long a render will take: the forecast of its form, with what loading its model adds when it is not the one
   * loaded before it. On `machine` when it is said: its own renders of the model, else the others' at its pace (forecast.ts
   * onMachine); a form placed from its recipe's usual times alone (no graph built) at the machine's pace.
   */
  private async expected(recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean, job: Pick<JobRow, "finished_from" | "clip_id" | "clip_fit"> | null = null, machine: string | null = null): Promise<number | null> {
    const e = await this.forecasts.expectedAll(recipe, input, cold, job);
    if (machine === null || e.ms === null) return e.ms;
    return e.on.get(machine) ?? e.ms * (paceOf(await this.forecasts.paces(), machine, recipe.family) ?? 1);
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

  /**
   * Of these jobs, the queued ones a machine open now could take (an update waits for those, updates.ts left): not one
   * pinned to a machine paused, gone or that takes no work (a pod stopped), nor a render no open machine takes the kind of.
   * A job that needs no ComfyUI always can.
   */
  async takeable(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db.selectFrom("jobs").selectAll().where("id", "in", [...ids]).where("status", "=", "queued").execute();
    const open = this.allPaused() ? [] : (await this.refresh()).filter((l) => !l.paused && !this.unavailable(l.id));
    return new Set(rows.filter((r) => {
      if (!needsComfy(r)) return true;
      const makes = this.planner.makes(r);
      const held = this.heldOn(r);
      const pin = r.pin_machine ?? held;
      // a render waiting for the machine it was lost on is takeable only while that machine answers: an update does not
      // wait the offline limit for a machine that is away
      return open.some((l) => (!pin || pin === l.id) && !(held && l.reachable !== true) && (l.machine!.takes === "all" || l.machine!.takes === makes));
    }).map((r) => r.id));
  }

  /** Pause or go on: all of them (no machine), or one machine on its own. A machine that is paused finishes what it runs and takes nothing new. */
  async setPaused(paused: boolean, machine?: string): Promise<void> {
    const all = await this.machines();
    if (machine) {
      if (!all.some((m) => m.machine.id === machine)) throw httpError("there is no ComfyUI with that id");
      await this.pauseLane(machine, paused);
      // one machine going again: Pause all no longer holds, and a machine joining later is not paused for it
      if (!paused) await this.setting(PAUSED_ALL_KEY, "false");
    } else if (all.length > 1) {
      // with several ComfyUIs, Pause all and Resume all are every machine's own pause, so that each one says it (its chip,
      // its lane, its card) and a machine can be resumed alone afterwards; the switch of one ComfyUI stays off
      for (const { machine: m } of all) await this.pauseLane(m.id, paused);
      await this.setting(PAUSED_ALL_KEY, String(paused));
      if (this.paused) {
        this.paused = false;
        await this.setting(PAUSED_KEY, "false");
      }
    } else {
      this.paused = paused;
      await this.setting(PAUSED_KEY, String(paused));
      // one machine: this switch holds a machine that joins (it is the whole queue's), and a Resume ends any earlier Pause all
      if (!paused) await this.setting(PAUSED_ALL_KEY, "false");
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
   * and what of it is that load (`loadMs`), for the GPU hunt's ranking (hunt.ts): a load is the pod's disk, not its card,
   * and is not read at the GPU's pace. Null when it cannot be told.
   */
  async forecastMs(row: JobRow): Promise<{ ms: number; loadMs: number } | null> {
    const recipe = this.registry.recipe(row.recipe_id);
    if (!recipe || row.warm) return null;
    const got = await submitting.forecastOf(this.core, recipe.id, readJson<Record<string, unknown>>(row.inputs, {}), { cold: true, finishedFrom: row.finished_from, clip: row.clip_id ? { id: row.clip_id, fit: Boolean(row.clip_fit) } : null });
    return got ? { ms: got.forecast.ms, loadMs: got.forecast.loadMs } : null;
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
    await this.setting(PAUSED_ALL_KEY, "false");
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
      ...lanes.map((l, i) => ({ machine: l.machine, core: l.core, paused: l.paused, reachable: l.reachable, outside: l.outside, locked: l.comfy?.locked ?? false, rented: l.machine ? this.rentedOf(l.machine) : null, files: l.machine && !l.machine.rented ? this.downloadsOf(l.machine, i === 0) : [] })),
      { machine: null, core: tools.core, paused: false, reachable: null, locked: false, rented: null },
    ];
  }

  /** The line as it stands, each machine's running job and progress, and the last finished jobs. */
  async status() {
    const views = await this.views();
    const paused = this.allPaused();
    const lanes = await this.refresh();
    const rows = await this.db.selectFrom("jobs").selectAll().where("status", "=", "queued").orderBy("priority").orderBy("created_at").execute();
    const able = await this.planner.ableOf(rows.filter(needsComfy));
    const planned = paused ? new Map<string, { lane: string; startsInMs: number; endsInMs: number }>() : await this.planner.forecastPlan(lanes, rows, able);
    const status = await view.status(this.core, views, paused, planned, await this.forecasts.paces(), able, (job) => this.ownPacks.waitOf(job));
    // when the waiting renders are all done, as the plan shares them between the machines (ms from now): the last end, not
    // their sum (40 jobs on 4 machines were said 5 min, and done in 75 s); null with none planned, or one whose end cannot be told
    const ends = [...planned.values()].map((p) => p.endsInMs);
    const waitingEndsInMs = ends.length && ends.every(Number.isFinite) ? Math.max(...ends) : null;
    // the GPU hunt under way, for the status bar (hunt.ts); null when there is none
    return { ...status, waitingEndsInMs, hunt: this.huntOf?.(rows.filter(needsComfy).length) ?? null };
  }

  /**
   * The line counted as /metrics says it: how many jobs wait, whether one runs, and the machines whose running job is a
   * render (not an export) or whose ComfyUI runs work from outside Afflatus: two small statements and the lanes in memory, where status() builds every row, forecast and
   * machine check. Each scrape asked status() before, which kept the checks and forecasts going with no page open.
   */
  async counts(): Promise<{ waiting: number; running: boolean; busy: Set<string> }> {
    const waiting = await this.db.selectFrom("jobs").select((eb) => eb.fn.countAll<number>().as("n")).where("status", "=", "queued").executeTakeFirstOrThrow();
    const ran = await this.db.selectFrom("jobs").select(["id", "recipe_id"]).where("status", "=", "running").execute();
    const busy = new Set<string>();
    for (const l of this.machineLanes()) {
      const r = l.running ? ran.find((x) => x.id === l.running!.id) : undefined;
      if (r && r.recipe_id !== EXPORT_JOB) busy.add(l.id);
      // its GPU at work for someone else (ComfyUI's own page, another tool) is busy all the same
      if (outsideBusy(l)) busy.add(l.id);
    }
    return { waiting: Number(waiting.n), running: ran.length > 0, busy };
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
        const answers = async (l: Lane, sent = false) => {
          // a machine that cannot take work now (a rented pod not running) is not asked: it is not away, it is off
          // A pod at a spending cap takes nothing new, but a render already sent there is followed: the pod stops after it
          const off = this.unavailable(l.id);
          if (off && !(sent && off === CAP_REACHED)) return false;
          if (!asked.has(l.id)) {
            l.reachable = await l.comfy!.client.status().then((st) => ((l.device = st.device), true), () => false);
            asked.set(l.id, l.reachable);
            if (l.reachable) this.dropStale(l);
          }
          return asked.get(l.id)!;
        };
        let started = false;

        // a job a ComfyUI already has goes first, paused or not: it is rendering anyway, on the machine it was sent to
        for (const r of active) {
          if (r.status !== "running" || taken.has(r.id) || !needsComfy(r)) continue;
          const lane = lanes.find((l) => l.id === (r.machine_id ?? this.firstId)) ?? lanes[0];
          // its machine taken out, and none left: it waits for one, as a queued job does
          if (!lane || !free(lane)) continue;
          if (!(await answers(lane, Boolean(r.resume)))) {
            // its machine away since this process started: past the wait a render gets (offlineMs), it is lost as one
            // followed all along would be, and queued again, instead of holding its next clip, the exports after it and an update
            if (await this.awayUnder(r)) this.dirty = true;
            continue;
          }
          this.awaySince.delete(r.id);
          this.startOn(lane, r);
          taken.add(r.id);
          started = true;
        }

        // the line as the machines see it: what waits for nothing, and may start (an update holds back what was asked after it)
        const startable = active.filter((r) => r.status === "queued" && !taken.has(r.id) && !(r.depends_on && waitingOn.has(r.depends_on)) && !(this.only && !this.only.has(r.id)));
        const gpuRows = startable.filter(needsComfy);
        const open = lanes.filter((l) => !l.paused && l.machine);
        let where = new Map<string, { lane: string; startsInMs: number }>();
        let sent = new Map<string, Set<string>>();
        if (!this.paused && gpuRows.length) {
          // each free machine is asked whether it answers (a busy one does); the plan is made with those that may take work
          // and one that answers, whether its ComfyUI has work of someone else's (its own page, another tool): it takes nothing then
          for (const l of open) if (free(l) && (await answers(l))) await this.outside.freshOutside(l);
          const able = await this.planner.ableOf(gpuRows);
          where = plan(await this.planner.schedulable(open), await this.planner.planned(gpuRows, able));
          sent = this.planner.sendFiles(gpuRows, able, where);
          for (const lane of open) {
            if (!free(lane) || lane.reachable === false || outsideBusy(lane)) continue;
            // on a pod getting files, the first job planned there whose own files are all there
            // a pod whose node packs wait for its ComfyUI to restart (or that restarts now) takes nothing until it is back: the
            // job that needs them is first in its line, and a job sent meanwhile would be lost in the restart
            if (this.podFetch?.holding(lane.id) || this.ownPacks.holding(lane.id)) continue;
            // the first planned there whose files are there and that lacks no node pack it asks for there (a machine of the
            // user's own: one waiting for its packs, or for the user to say Install, lets the next one go meanwhile)
            let next: JobRow | undefined;
            for (const r of gpuRows) {
              if (taken.has(r.id) || where.get(r.id)?.lane !== lane.id || !this.planner.filesThere(r, lane, able)) continue;
              if (await this.ownPacks.mayStart(lane, r)) {
                next = r;
                break;
              }
            }
            // the awaits above gave the packs' timer its turn: a pack come in meanwhile holds the machine for its restart
            // (checked again here, in the same step as the start, which the restart waits for: podPacks.ts restartWhenIn)
            if (!next || this.ownPacks.holding(lane.id)) continue;
            this.startOn(lane, next);
            taken.add(next.id);
            started = true;
          }
          // a render waiting for the machine it was lost on: that machine is asked again soon, and the wait ends in its time
          if (gpuRows.some((r) => !taken.has(r.id) && this.heldOn(r))) this.retryLater();
        } else if (gpuRows.length) {
          // Pause all: nothing starts, but a pod (one deployed meanwhile) is sent the waiting jobs' files ahead, so that it
          // is ready on Resume. Its idle time is held while they move (podFiles.ts moving), and runs again once they are in
          sent = this.planner.sendFiles(gpuRows, await this.planner.ableOf(gpuRows), where);
        }
        // what rented pods were sent for jobs that may no longer run there goes, at every pass (nothing waiting too)
        this.planner.dropUnsought(active, sent);
        // the packs asked for jobs that are gone are dropped (unless being installed), and their rows forgotten
        this.ownPacks.keepOnly(active.filter((r) => r.status === "queued"));
        // the machines that answered this pass, or that run a job now, say whether any ComfyUI is there. A paused machine is
        // asked nothing for the plan: before every ComfyUI is called away (whileOffline gives the jobs up after a while),
        // one paused that answers says it is there, its jobs waiting for its Resume, not for a ComfyUI to come back
        let anyAnswered = lanes.some((l) => asked.get(l.id) === true || l.running);
        if (!anyAnswered && [...asked.values()].some((ok) => !ok)) {
          for (const l of lanes) if (l.paused && l.machine && !asked.has(l.id) && (await answers(l))) anyAnswered = true;
          // the machines that may take work are asked again in a while all the same, as while every one is away
          if (anyAnswered) this.retryLater();
        }
        const noneAnswered = !anyAnswered && [...asked.values()].some((ok) => !ok);

        // what needs no ComfyUI (an export, a cut by ffmpeg) goes on in its turn: after the renders before it, unless those
        // cannot start (paused, every machine away or paused, or none takes them); an update holds back what was asked after it
        if (free(tools)) {
          for (const r of active) {
            if (r.depends_on && waitingOn.has(r.depends_on)) continue;
            if (this.only && r.status === "queued" && !this.only.has(r.id)) continue;
            if (!needsComfy(r)) {
              if (taken.has(r.id) || r.status !== "queued") continue;
              this.startOn(tools, r);
              taken.add(r.id);
              started = true;
              break;
            }
            // a render before it that runs, that a machine has taken (every running render is) or that a machine is
            // planned to take, keeps it waiting; so does one waiting for the machine it was lost on (heldOn), which may
            // still render it there: an export after it would be made without that clip
            if (taken.has(r.id) || r.status === "running" || where.has(r.id) || this.heldOn(r)) break;
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

  /**
   * A job waits on a machine of the user's own for files to be downloaded there: a file put in by hand or by ComfyUI-Manager's
   * page tells the queue nothing, so that machine's model folders and node list are read again in a while (filesRetryMs, a
   * minute) and the queue planned again, for as long as such a job waits (each pass that plans it so asks again). The node
   * list too: the job's check before it is sent reads the file's name in its loader's choices, and a file seen in the folder
   * but not there failed the job.
   */
  private filesWait(machine: string): void {
    this.filesWaitOn.add(machine);
    if (this.filesRetry || this.stopped) return;
    this.filesRetry = setTimeout(() => {
      this.filesRetry = null;
      for (const id of this.filesWaitOn) {
        const comfy = this.lanes.get(id)?.comfy;
        comfy?.forgetScan();
        comfy?.forgetCatalog();
      }
      this.filesWaitOn.clear();
      void this.pump();
    }, this.opts.filesRetryMs ?? 60_000);
  }

  private retryLater(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.pump();
    }, this.opts.offlineRetryMs);
  }

  /**
   * A machine that cannot take work now, and why: a rented pod that is not running (rented.ts sets it). It is never asked,
   * never planned for; what is pinned to it waits for it. Asked at each pass.
   */
  unavailable: (machine: string) => string | null = () => null;
  /** What is said of a rented machine on its row (rented.ts); null for a ComfyUI of its own. */
  rentedOf: (machine: Machine) => view.RentedRow | null = () => null;
  /** A ComfyUI of its own's model files downloading now (`first`: the downloads asked for no machine go to it): set by services.ts. */
  downloadsOf: (machine: Machine, first: boolean) => PodFileView[] = () => [];
  /**
   * Whether a job this long (ms, null: not known) ends on a rented pod before RunPod's balance does (rented.ts fitsBalance):
   * at zero RunPod stops every pod, the render lost. One that does not is not sent to a rented pod.
   */
  fitsBalance: (ms: number | null) => { ok: boolean; leftMs: number | null } = () => ({ ok: true, leftMs: null });
  /**
   * What a job needs of the balance on a rented pod (rented.ts balanceNeed), its forecast there and its files' time to come
   * given: half again over a forecast that rests on too little of the pod's own.
   */
  balanceNeed: (machine: string, recipeId: string, renderMs: number, fetchMs: number) => Promise<number> = async (_m, _r, renderMs, fetchMs) => renderMs + fetchMs;

  /** Rented pods' files: set by services.ts. */
  podFetch: PodFetch | null = null;

  /** Whether a ComfyUI has ComfyUI-Manager, which installs the node packs renders ask for (downloads.ts manager; set by services.ts); null: not known. */
  managerOf: (comfy: Comfy) => Promise<boolean | null> = async () => null;
  /** Whether Afflatus downloads a file through this ComfyUI now (its process): its restart for node packs waits for it (services.ts sets it). */
  downloadingIn: (comfy: Comfy) => boolean = () => false;

  /** Files are coming to a machine now (a rented pod's, their bytes moving): its idle time is held meanwhile (rented.ts). */
  fetching(machine: string): boolean {
    return this.podFetch?.moving(machine) ?? false;
  }

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
   * Whether a machine's ComfyUI has work from outside Afflatus, its queue read now: for a rented pod's idle time (rented.ts),
   * which runs with no page open. A machine whose queue cannot be read has none.
   */
  async busyOutside(machine: string): Promise<boolean> {
    // a pod added since the last pass has no lane yet: the machines are read for it
    const lane = this.lanes.get(machine) ?? (await this.refresh()).find((l) => l.id === machine);
    if (!lane?.machine) return false;
    await this.outside.readOutside(lane);
    return outsideBusy(lane);
  }

  /** Whether a machine is at work, Afflatus's or someone else's in its ComfyUI, as last read: not restarted, nor its disk hashed, under it. */
  busyOn(machine: string): boolean {
    return this.runningOn(machine) || outsideBusy(this.lanes.get(machine));
  }

  /** Every machine's work from outside Afflatus, looked at by an open page's poll (events.ts; queueOutside.ts lookOutside). */
  lookOutside(): Promise<void> {
    return this.outside.lookOutside();
  }

  /**
   * Whether Afflatus's render on a machine has not started in its ComfyUI, waiting there behind work from outside Afflatus:
   * at a spending cap it is not waited for (rented.ts), or the pod would bill on for someone else's work up to the cap's
   * grace. Without a socket to say where it is, it is taken as not started, the cheaper reading.
   */
  waitingBehindOutside(machine: string): boolean {
    const lane = this.lanes.get(machine);
    const run = lane?.running;
    if (!run?.promptId || !lane?.outside?.running) return false;
    const monitor = lane.comfy?.monitor;
    return !monitor || monitor.progress(run.promptId).phase === "waiting";
  }

  /**
   * How long the render a machine runs has been silent (no step, no node, no preview from ComfyUI) in a way that counts
   * towards stuck, and whether its GPU is known idle all that time. With the GPU's load read lately, the whole silence counts
   * whatever the forecast says: a node at work keeps its GPU busy, which moves the render (GPU_AT_WORK), so a silence with an
   * idle GPU is a hang. Without it, a long node may be at work unseen: the silence counts once the render is past its
   * forecast, which is waited for at most twice and at most FORECAST_SLACK_MS over, as forecasts run long. 0 when it runs
   * nothing, a render not sent yet, or one still within its forecast. `now`: the caller's clock (a test's stand-in).
   */
  quietFor(machine: string, now = Date.now()): { ms: number; gpuIdle: boolean } {
    const lane = this.lanes.get(machine);
    const run = lane?.running;
    // ComfyUI running work from outside Afflatus: the render waits behind it there, and says nothing for that reason
    if (!run?.promptId || !run.movedAt || !run.startedAt || lane?.outside?.running) return { ms: 0, gpuIdle: false };
    const silent = Math.max(0, now - run.movedAt);
    if (run.loadAt && now - run.loadAt <= LOAD_FRESH_MS) return { ms: silent, gpuIdle: true };
    // a render like nothing rendered before has no forecast: it is waited for the slack alone, not counted silent from its start
    const forecast = run.expectedMs ?? null;
    const waited = now - run.startedAt >= (forecast ? Math.min(2 * forecast, forecast + FORECAST_SLACK_MS) : FORECAST_SLACK_MS);
    return { ms: waited ? silent : 0, gpuIdle: false };
  }

  /**
   * The renders under way and how long each has moved by nothing (no step, no node, no preview from ComfyUI, its GPU idle),
   * on every machine: what a render stuck is told by (notify.ts). A rented pod's is failed by its own measure (quietFor).
   */
  stillFor(): Array<{ job: string; machine: string; ms: number }> {
    const now = Date.now();
    // one waiting in its ComfyUI behind work from outside Afflatus is not stuck (quietFor)
    return this.machineLanes().flatMap((l) => (l.running?.promptId && l.running.movedAt && l.running.gpu && !l.outside?.running ? [{ job: l.running.id, machine: l.id, ms: now - l.running.movedAt }] : []));
  }

  /** A machine's ComfyUI went while it rendered: told once, until it answers again. `label`: the render's, when known. */
  private sayGone(lane: Lane, label: string | null): void {
    if (!this.tell || this.goneSaid.has(lane.id)) return;
    this.goneSaid.add(lane.id);
    const name = lane.machine ? machineSaid(lane.machine) : "ComfyUI";
    this.tell("comfyGone", { title: `${name} is offline`, body: `It stopped answering while it rendered${label ? ` ${label}` : ""}. The render is queued again while attempts remain.`, key: lane.id });
  }

  /**
   * A machine's ComfyUI died (its pod said so: rentedFollow): the render it ran fails now, with why and the step it was at,
   * and is not queued again (Died). Kept for that render (by its job): its own wait, which sees only a ComfyUI gone, would
   * otherwise queue it again elsewhere; never for a later job on the machine. Whether a render was failed by it: none for a
   * machine with nothing running, or one already stopped by the user.
   */
  machineDied(machine: string, why: string, trace: string | null): boolean {
    const lane = this.lanes.get(machine);
    const run = lane?.running;
    if (!run || run.abort.signal.aborted) return false;
    const at = run.promptId && lane?.comfy ? lane.comfy.monitor.progress(run.promptId) : null;
    const step = at && at.step > 0 && at.steps > 0 ? ` at step ${at.step}/${at.steps}` : "";
    const where = lane?.machine ? machineSaid(lane.machine) : machine;
    const died = new Died(`${why}${step}, on ${where}. Not run again on its own: it would likely kill ComfyUI again.`, trace, run.id);
    this.died.set(machine, died);
    run.abort.abort(died);
    return true;
  }

  /**
   * Whether a job's end is its ComfyUI's death: the reason it was aborted with, the death kept for that job (machineDied
   * landing after its wait had already ended on the ComfyUI gone), or a rented pod's ComfyUI answering without it
   * (lostOnPod). Null: any other end, which goes as before.
   */
  private diedFor(lane: Lane, row: JobRow, err: Error, reason: unknown): Died | null {
    const kept = this.died.get(lane.id);
    if (reason instanceof Died) {
      if (kept === reason) this.died.delete(lane.id);
      return reason;
    }
    if (kept?.job === row.id) {
      this.died.delete(lane.id);
      return kept;
    }
    return this.lostOnPod(lane, err);
  }

  /**
   * A render lost on a rented pod whose ComfyUI answers without it: started again under it, the death of the one that ran it
   * (an older pod image said nothing of why). A Died, said on the job, and told so that the pod is terminated; null for any
   * other loss (this PC's ComfyUI started again by hand, a machine merely gone), which goes again as before. Never for one
   * that stopped answering (ComfyAway, a ComfyLost too): a proxy's outage, or a stop of the user's or a cap's, is no death
   */
  private lostOnPod(lane: Lane, err: Error): Died | null {
    if (!(err instanceof ComfyLost) || err instanceof ComfyAway || !lane.machine?.rented) return null;
    // an image that reports its ComfyUI's death never restarts it: a render gone from one that answers was taken from it
    // (its prompt cleared on ComfyUI's own page), and the pod was terminated for it, its disk lost
    if (reportsDeath(lane.machine.rented.image)) return null;
    const why = "ComfyUI started again on the pod during the render, without it: it likely crashed (this pod's image does not say why; a newer Afflatus pod image does)";
    this.podCrashed?.(lane.id, why);
    return new Died(`${why}, on ${machineSaid(lane.machine)}. Not run again on its own: it would likely kill ComfyUI again.`);
  }

  /**
   * A render lost on a deployed pod, its ComfyUI's death asked of the pod once before it goes again (rentedFollow
   * diedLate): seen late, a death was taken for a pod merely gone, and the render went to another pod, which it could kill
   * too. A Died, with the pod's line and report; null for any other loss, which goes again as before.
   */
  private async diedLateOn(lane: Lane, err: Error, aborted: boolean): Promise<Died | null> {
    if (aborted || !lane.machine?.rented?.deployed || !this.diedLate) return null;
    if (!(err instanceof ComfyLost || err instanceof ComfyUnreachable || err instanceof ComfyError)) return null;
    const said = await this.diedLate(lane.id).catch(() => null);
    if (!said) return null;
    return new Died(`${said.said}, on ${machineSaid(lane.machine)}. Not run again on its own: it would likely kill ComfyUI again.`, said.report ? `The pod's report: ${JSON.stringify(said.report)}` : null);
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
    const where = plan(await this.planner.schedulable(open), await this.planner.planned(rows, await this.planner.ableOf(rows)));
    return rows.some((r) => where.get(r.id)?.lane === machine);
  }

  /** What the page's status poll (events.ts) found of the ComfyUIs: whether any answered (queueOffline.ts), and each machine's own answer. */
  noteReachable(ok: boolean, each: ReadonlyMap<string, boolean> = new Map()): void {
    // each machine's own answer: a paused or idle machine is asked nothing by the queue, and was shown online after its
    // ComfyUI had stopped (and away after it was back, until a job went to it)
    let changed = false;
    for (const lane of this.machineLanes()) {
      const answered = each.get(lane.id);
      if (answered === undefined || lane.reachable === answered) continue;
      changed = true;
      if (answered) this.back(lane);
      else {
        lane.reachable = false;
        if (lane.running?.gpu) this.sayGone(lane, null);
      }
    }
    this.offline.noteReachable(ok);
    if (changed) {
      this.events.emit("queue");
      // one back: what waited for it may go now
      void this.pump();
    }
  }

  /**
   * A machine's ComfyUI started answering (a rented pod at the end of its boot, or back after a restart), as the rented
   * poll found it: it runs whether a page is open or not, where the page's status poll (noteReachable) does not. What was
   * planned while it did not answer is planned again now: a job pinned to a booting pod had its files asked for by no pass,
   * and the pod idled toward its stop with the job waiting. Said once per change, by the caller.
   */
  answering(machine: string): void {
    this.died.delete(machine);
    const lane = this.lanes.get(machine);
    if (!lane) return;
    this.back(lane);
    this.events.emit("queue");
    void this.pump();
  }

  /**
   * A machine known to answer again: taken as reachable at once (the rented poll asks whether it has work right after, before
   * any pass), and its scan read afresh by the next pass, not one kept from before it went.
   */
  private back(lane: Lane): void {
    lane.reachable = true;
    this.dropStale(lane);
    this.goneSaid.delete(lane.id);
    lane.comfy?.forgetScan();
  }

  /** A job ends. `from`: only when it is still in that state (a job that was cancelled meanwhile stays cancelled). Whether this call ended it. */
  private async finish(id: string, status: "done" | "failed" | "cancelled", extra: { error?: string; generationId?: string; trace?: string | null } = {}, from?: JobRow["status"]): Promise<boolean> {
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
    return ended;
  }

  /**
   * The jobs that wait on this one can never run now: each fails (and what waits on those), whichever way this one ended.
   * Said as what it waited for: a finish queued behind a Face refine is no continuation of a clip.
   */
  private async failDependents(id: string): Promise<void> {
    const dependents = await this.db.selectFrom("jobs").select(["id", "recipe_id", "inputs"]).where("depends_on", "=", id).where("status", "=", "queued").execute();
    for (const d of dependents) {
      const error = d.recipe_id === CUT_JOB && tools.cutOptionsOf(d)?.fromJob === id ? tools.FACE_REFINE_NOT_ENDED : "the clip it continues was not rendered";
      await this.finish(d.id, "failed", { error }, "queued");
    }
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
    // a finish or a RIFE pass whose prompt went to another machine before (held there until heldOn ran out, that machine
    // away or stopped): it is sent again here, so the first one is dropped there, now or once that machine answers
    const before = readJson<{ promptId?: unknown }>(row.resume, {}).promptId;
    if (machine && row.machine_id && row.machine_id !== machine && typeof before === "string") this.interruptOn(row.machine_id, before);
    let died: Died | null;
    try {
      await work(run);
      await this.finish(row.id, "done");
    } catch (err) {
      if (this.stopped) await this.db.updateTable("jobs").set({ status: "queued", updated_at: now() }).where("id", "=", row.id).execute();
      // stuck on a rented GPU (a finish or a RIFE pass that hangs): a failure, said as such, not a stop by the user
      else if (run.abort.signal.reason instanceof Stuck) await this.failure(row, run.promptId, new Error(run.abort.signal.reason.message));
      // its ComfyUI died under it: failed with why, never queued again (Died)
      else if ((died = this.diedFor(lane, row, err as Error, run.abort.signal.reason))) await this.failure(row, run.promptId, new Error(died.message), died.trace);
      else if (run.abort.signal.aborted) await this.finish(row.id, "cancelled", { error: "stopped by you" });
      else if (!(await this.toolLost(lane, row, err as Error))) await this.failure(row, run.promptId, err as Error);
    } finally {
      lane.running = null;
      // a finish or a RIFE pass loaded models into ComfyUI: the idle unload counts from its end, as after a render
      if (run.gpu) {
        lane.holds = true;
        void this.armIdle(lane);
      }
    }
  }

  /**
   * A finish or a RIFE pass whose machine did not answer (a proxy's 502 on its prompt, silent past the wait) or lost its
   * prompt: queued again with its prompt id while attempts remain, as a render is (requeueLost), so that the next attempt
   * asks that ComfyUI for it and follows it rather than running it twice; held for that machine when it was away. Given
   * up, the prompt is dropped there, now or once it answers. Whether it was queued again.
   */
  private async toolLost(lane: Lane, row: JobRow, err: Error): Promise<boolean> {
    if (lane.id === TOOLS || !(err instanceof ComfyLost || err instanceof ComfyUnreachable)) return false;
    const saved = await this.db.selectFrom("jobs").select("resume").where("id", "=", row.id).executeTakeFirst();
    const promptId = readJson<{ promptId?: unknown }>(saved?.resume, {}).promptId;
    if (typeof promptId !== "string") return false;
    if (row.attempts + 1 < this.opts.maxAttempts) {
      console.warn(`[queue] job ${row.id} lost (${err.message}), queued again`);
      const resume = JSON.stringify({ promptId, ...(awayErr(err) ? { lostAt: Date.now() } : {}) });
      const queued = await this.db.updateTable("jobs").set({ status: "queued", resume, warning: null, updated_at: now() }).where("id", "=", row.id).where("status", "=", "running").executeTakeFirst();
      if (Number(queued.numUpdatedRows) > 0) {
        this.events.emit("queue");
        return true;
      }
    }
    this.interruptOn(lane.id, promptId, awayErr(err));
    return false;
  }

  private async run(lane: Lane, row: JobRow): Promise<void> {
    const comfy = lane.comfy!;
    const core = lane.core;
    const recipe = this.registry.recipe(row.recipe_id);
    if (!recipe) {
      await this.finish(row.id, "failed", { error: removedSaid(row.recipe_id) ?? `the recipe ${row.recipe_id} no longer exists` });
      return;
    }
    let resume = readJson<Resume | null>(row.resume, null);
    // saved just before its prompt was sent, by a process that did not hear back (it stopped, ComfyUI did not answer): ComfyUI is
    // asked whether it took that prompt, which is then followed; one it never had is sent again. Kept for a requeue until then
    let held = resume?.unsent ? resume : null;
    if (held) {
      const { unsent: _, lostAt: _lost, ...sent } = held;
      resume = (await submitting.taken(comfy, held.promptId).catch(() => false)) ? sent : null;
      // sent again here while the machine it was lost on may still render it: that one drops it once it answers
      if (!resume && row.machine_id && row.machine_id !== lane.id) this.stale.set(row.machine_id, new Set([...(this.stale.get(row.machine_id) ?? []), held.promptId]));
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
        const before = { at: performance.now(), parts: {} };
        resume = await gathering(before.parts, () => submitting.submit(core, comfy, recipe, input, row, async (r) => {
          held = r;
          await this.db.updateTable("jobs").set({ resume: JSON.stringify(r), updated_at: now() }).where("id", "=", row.id).execute();
          // followed from before it is sent, under the id it is sent with: what ComfyUI says at once (the passes it still had
          // cached, execution_cached) arrives before submit returns, and was lost when the prompt was tracked only after it
          comfy.monitor.track({ promptId: r.promptId, totalSteps: r.totalSteps, phases: r.phases, passes: r.passes, clientId: r.clientId, expect: r.timing?.expect });
          early = r.promptId;
        }, abort.signal));
        // what Afflatus added before ComfyUI had it, for /metrics (a preload is not a render)
        if (!row.warm) observeAdded(lane.id, "before", performance.now() - before.at, before.parts);
        // a ComfyUI from before prompt ids could be chosen gave one of its own: that one is followed instead
        if (early && early !== resume.promptId) comfy.monitor.untrack(early);
        await this.db.updateTable("jobs").set({ resume: JSON.stringify(resume), updated_at: now() }).where("id", "=", row.id).execute();
        if (resume.warnings?.length) await this.warn(row.id, resume.warnings.join(" "));
        // the window after this one (a motion transfer of a long source) has its driving part cut while this one renders
        if (!row.warm) void submitting.cutAhead(core, row).catch(() => {});
      }
      running.promptId = resume.promptId;
      running.titles = resume.titles;
      // a fresh render learns how long it should take only once it is sent: the spilling warning needs it from the first run on
      running.expectedMs ??= resume.timing?.expectedMs ?? null;
      running.startedAt = resume.startedAt;
      running.movedAt = Date.now();
      running.seed = resume.seed;
      if (resume.timing) running.cold = resume.timing.cold;
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
      // its GPU's power read on the way (a machine of this PC's: for its electricity), at most every two seconds on what
      // ComfyUI says of it anyway (a system feed's broadcast, its progress): no loop of its own
      comfy.monitor.onSystem = (load) => {
        void comfy.readPower();
        if (load.gpus.some((g) => g.load !== undefined)) running.loadAt = Date.now();
        if (load.gpus.some((g) => (g.load ?? 0) >= GPU_AT_WORK)) running.movedAt = Date.now();
      };
      comfy.monitor.onChange = () => {
        void comfy.readPower();
        running.movedAt = Date.now();
        this.events.emit("progress");
        saving.check();
      };
      // steps ComfyUI reported before this was listening (the prompt is followed from before it is sent, and the writes
      // since then let its first progress in) are saved now, not at the next step
      saving.check();
      // the RAM, which no progress says: ComfyUI's own count (/system_stats, a container's limit on a pod) read every few
      // seconds for the render's peak (render_stats.ram_peak), where a render that dies of memory is learned from
      // the RAM alone: the GPU's memory peak stays the system feed's, as before, not mixed with ComfyUI's own count
      const ram = setInterval(() => void comfy.client.status().then((st) => comfy.monitor.peaks({ ...systemLoadFromStatus(st), gpus: [] }), () => {}), RAM_EVERY_MS);
      ram.unref?.();
      let outputs;
      try {
        outputs = await waitForOutputs(comfy.client, resume.promptId, { ...this.opts.wait, signal: abort.signal, ended: comfy.monitor.ended(resume.promptId) });
      } finally {
        clearInterval(ram);
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
      const filing = { at: performance.now(), parts: {} };
      const filed = await gathering(filing.parts, () => storing.store(core, comfy, recipe, resume!.input ?? input, resume!, outputs, row));
      observeAdded(lane.id, "filing", performance.now() - filing.at, filing.parts);
      const notes = storing.notesOf(resume!, outputs);
      if (notes.length) await this.warn(row.id, notes.join(" "));
      const generationId = filed.id;
      made = generationId;
      // measured while the machine takes its next job: /metrics' "measuring", and the editor told once its take has its figures
      if (filed.measuring) {
        void filed.measuring.then((ms) => {
          observePart(lane.id, "measuring", ms);
          if (row.clip_id) this.events.emit("timeline");
        });
      }
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
    // a Face refine with a finish queued behind it, made from its video: that finish is the clip's finished take, this one
    // only among its takes (it played for the length of the upscale, then gave way: two finished takes for one Finish)
    const behind = row.finished_from ? await this.db.selectFrom("jobs").select(["recipe_id", "inputs"]).where("depends_on", "=", row.id).where("status", "in", ["queued", "running"]).execute() : [];
    const between = behind.some((j) => j.recipe_id === CUT_JOB && tools.cutOptionsOf(j)?.fromJob === row.id);
    await this.clips.finished(row.clip_id, generationId, resume?.overlap, resume?.links ?? {}, row.finished_from, between).catch((err: Error) => this.warn(row.id, `Its take was not placed on its clip: ${err.message}`));
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
    // its ComfyUI died under it (its pod said so, or it answers again without it): whatever the wait saw of that, a failure
    // said with why, never queued again, as a machine merely gone is
    const died = this.stopped ? null : (this.diedFor(lane, row, err, at.aborted ? lane.running?.abort.signal.reason : null) ?? (await this.diedLateOn(lane, err, at.aborted)));
    if (this.stopped) {
      // shutting down: leave the row as it is, the next start picks it up
    } else if (died) {
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
      await this.failure(row, resume?.promptId ?? at.held?.promptId, new Error(died.message), died.trace);
    } else if (at.aborted && lane.running?.abort.signal.reason instanceof Stuck) {
      // stuck on a rented GPU: a failure, said as such, not a stop by the user
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
      await this.failure(row, resume?.promptId ?? at.held?.promptId, new Error((lane.running.abort.signal.reason as Stuck).message));
    } else if (err instanceof ComfyCancelled || at.aborted) {
      // on record before the job says how it ended, as a render that is done
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "cancelled", whole, Date.now() - resume.startedAt);
      await this.finish(row.id, "cancelled", { error: "stopped by you" });
    } else if ((err instanceof ComfyLost || err instanceof ComfyUnreachable || (err instanceof ComfyError && (await this.wentDown(lane)))) && Math.max(at.attempts, row.attempts + 1) < this.opts.maxAttempts) {
      console.warn(`[queue] job ${row.id} lost (${err.message}), queued again`);
      // said offline only when it stopped answering: a ComfyUI that answered but no longer has the prompt (it restarted, or
      // a job followed after a restart on a machine that never had it) is not offline, and the render goes again anyway
      if (resume && awayErr(err)) this.sayGone(lane, row.label);
      // ComfyUI may have the prompt all the same: one sent without an answer (it did not answer in time), and one it finished
      // or still runs while this process lost sight of it (90 s of silence, its file not fetched). Its id is kept, so that the
      // next attempt asks ComfyUI for it (taken) and follows it, instead of rendering again a video that would come out different
      const kept = resume ?? at.held;
      await this.requeueLost(row, kept && !made ? kept : null, Math.max(at.attempts, row.attempts + 1), err instanceof ComfyAway || err instanceof ComfyUnreachable);
    } else {
      if (resume && awayErr(err)) this.sayGone(lane, row.label);
      if (onRecord) await this.note(lane, row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
      const sent = resume?.promptId ?? at.held?.promptId;
      await this.failure(row, sent, err);
      // given up while its machine did not answer: that ComfyUI may still have the prompt and render it once it is back,
      // its GPU busy for nothing and billed on a pod. It is dropped there now if it answers, else once it does
      if (sent && (err instanceof ComfyLost || err instanceof ComfyUnreachable)) this.interruptOn(lane.id, sent, awayErr(err));
    }
  }

  /**
   * A render lost with its machine, queued again with its prompt id kept (`kept`; null once filed or never sent). `away`:
   * its machine stopped answering, and may render it on unseen: the job waits for that machine (Resume.lostAt, heldOn).
   * Each loss counts as an attempt, a prompt followed again too: one that keeps getting lost is given up in the end.
   */
  private async requeueLost(row: JobRow, kept: Resume | null, attempts: number, away: boolean): Promise<void> {
    const unsent = kept ? JSON.stringify({ ...kept, unsent: true, ...(away ? { lostAt: Date.now() } : {}) } satisfies Resume) : null;
    await this.db.updateTable("jobs").set({ status: "queued", resume: unsent, attempts, warning: null, updated_at: now() }).where("id", "=", row.id).where("status", "=", "running").execute();
    this.events.emit("queue");
  }

  /** Since when the machine of a job found running at the start has not answered, by job: from the first pass that asked. */
  private readonly awaySince = new Map<string, number>();

  /**
   * A job found running at the start, on a machine that does not answer: lost once that has lasted the wait a render gets
   * (offlineMs), queued again (waiting for that machine, heldOn) or failed when its attempts are spent. Whether it moved.
   */
  private async awayUnder(r: JobRow): Promise<boolean> {
    const since = this.awaySince.get(r.id) ?? Date.now();
    this.awaySince.set(r.id, since);
    if (Date.now() - since <= (this.opts.wait.offlineMs ?? 90_000)) {
      this.retryLater();
      return false;
    }
    this.awaySince.delete(r.id);
    const attempts = r.attempts + 1;
    const kept = readJson<Resume | null>(r.resume, null);
    if (attempts < this.opts.maxAttempts) await this.requeueLost(r, kept, attempts, true);
    // given up: the prompt its machine had is dropped there once it answers, not rendered on unseen
    else if (await this.finish(r.id, "failed", { error: "ComfyUI went offline during the render" }, "running") && kept?.promptId) this.interruptOn(r.machine_id, kept.promptId, true);
    return true;
  }

  /**
   * The machine a render lost there waits for (Resume.lostAt): the one that may still be rendering it, while it is in the
   * settings, not down (a pod stopped) and not away past the offline limit. Null: it goes wherever the plan sends it.
   */
  private heldOn(r: JobRow): string | null {
    if (r.pin_machine || !r.machine_id || r.status !== "queued") return null;
    const lostAt = readJson<Resume | null>(r.resume, null)?.lostAt;
    if (lostAt === undefined || Date.now() - lostAt >= this.opts.offlineExpiryMs) return null;
    const off = this.unavailable(r.machine_id);
    return this.lanes.get(r.machine_id)?.machine && !(off && off !== CAP_REACHED) ? r.machine_id : null;
  }

  /**
   * A prompt a machine may still render for a job that went elsewhere since (heldOn ran out): dropped from that machine's
   * ComfyUI once it answers again, instead of rendering on unseen (billed on a pod).
   */
  private readonly stale = new Map<string, Set<string>>();
  private dropStale(lane: Lane): void {
    const ids = this.stale.get(lane.id);
    if (!ids?.size || !lane.comfy) return;
    this.stale.delete(lane.id);
    for (const id of ids) void lane.comfy.client.interrupt(id).catch(() => {});
  }

  /**
   * Whether a machine went down under its render: taken out of the settings (a pod terminated, on RunPod's side or by a
   * stop), or a pod no longer running. What its address answered last (a proxy's 404 for a pod no longer there) is then no
   * failure of the render's: it was lost with its machine, and goes again elsewhere. A pod at a cap is still up.
   */
  private async wentDown(lane: Lane): Promise<boolean> {
    const off = this.unavailable(lane.id);
    if (off && off !== CAP_REACHED) return true;
    return !(await this.machines()).some((m) => m.machine.id === lane.id);
  }

  /**
   * A job failed: closed with its message and, when ComfyUI sent one, the end of its traceback (ComfyFailed), and said in
   * the log with what finds it again (the job, its prompt, its recipe). An error that is none of ComfyUI's is a fault here:
   * its stack goes to the log too, which is where it is read.
   */
  private async failure(row: JobRow, promptId: string | undefined, err: Error, trace: string | null = null): Promise<void> {
    const comfys = err instanceof ComfyFailed || err instanceof ComfyError || err instanceof ComfyUnreachable || err instanceof ComfyLost || err instanceof ComfyCancelled;
    console.error(`[queue] job ${row.id} failed (prompt ${promptId ?? "not sent"}, ${row.recipe_id}): ${err.message}`);
    if (!comfys && err.stack) console.error(err.stack);
    await this.finish(row.id, "failed", { error: err.message.slice(0, 600), trace: trace ?? (err instanceof ComfyFailed ? err.failure?.traceback || null : null) });
  }

  /** Put a render on the record of render times (renders.ts), under the machine it ran on. Never in the way of the render itself: a failure here is only said. */
  private async note(lane: Lane, row: JobRow, recipe: Recipe<any>, resume: Resume, measured: Measured | null, status: "done" | "failed" | "cancelled", whole: boolean, totalMs: number, generationId?: string): Promise<void> {
    try {
      // what its GPU drew over its own stretch, from the power read on the way (none on a rented pod, nor without the reading)
      const energy = lane.comfy?.home ? lane.comfy.power.energy(resume.startedAt, resume.startedAt + totalMs) : null;
      await record(this.db, row, recipe, resume, measured, status, whole, totalMs, generationId, { machine: lane.id, gpu: gpuOf(lane.device, lane.comfy?.monitor.system?.gpus ?? []), energy });
      // the record changed: the next forecast reads it again at once, not after the second the mark is kept
      this.forecasts.recorded();
    } catch (err) {
      console.warn(`[queue] the time of job ${row.id} was not put on record: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- a form against a ComfyUI (queueSubmit.ts)

  /** The graph a form (or a past render) gives, built without uploading anything; null when the form is not complete enough to build. */
  builtOf(recipeId: string, rawInput: unknown, opts: Parameters<typeof submitting.builtOf>[3] = {}): Promise<BuiltGraph | null> { return submitting.builtOf(this.core, recipeId, rawInput, opts); }
  /** What a waiting job's graph loads on a pod that has nothing yet (the Deploy dialog, the hunt): jobFiles.ts loadedOn. */
  loadedOnNew(row: Parameters<typeof loadedOn>[1]): Promise<Loaded | null> { return loadedOn(this.core, row, null); }
  /** Whether the base models a form would use are the ones the first ComfyUI was last asked to load; null when it cannot be told. */
  isLoaded(recipeId: string, rawInput: unknown): Promise<boolean | null> { return submitting.isLoaded(this.core, recipeId, rawInput); }
  /** The machine whose ComfyUI holds the base models a form would use (the first such); null when none does, or it cannot be told. */
  async loadedOn(recipeId: string, rawInput: unknown): Promise<string | null> {
    for (const lane of await this.refresh()) if (await submitting.isLoaded(lane.core, recipeId, rawInput)) return lane.id;
    return null;
  }
  /**
   * What this model's past renders say a form will take; null without history or for a form not complete enough to build.
   * With one machine, on it (its own renders first). With several, on each (`on`), each with its model to load or not as
   * that machine holds it, and said (`forecast`) on the one that renders it soonest of those that can take it now (Auto,
   * the queue's own waits aside): open, taking what it makes, with its files (`can`, as a waiting job of it is told). Those
   * are the machines Auto shares a batch of it between (`auto`). The machine picked by hand reads its own in `on`.
   */
  async forecast(recipeId: string, rawInput: unknown, opts: { finishedFrom?: string | null; clip?: { id: string; fit: boolean } | null } = {}) {
    const lanes = this.machineLanes();
    if (lanes.length < 2) return submitting.forecastOf(this.core, recipeId, rawInput, { ...opts, machine: lanes[0]?.id ?? null });
    const loads = (machine: string) => this.lanes.get(machine)?.lastLoads ?? null;
    const got = await submitting.forecastOf(this.core, recipeId, rawInput, { ...opts, machines: lanes.map((l) => l.id), loads });
    if (!got?.on) return got;
    const makes = this.registry.recipe(recipeId)?.output === "image" ? "image" : "video";
    // the machines it can run on, as a waiting job of it would be told (its files there, or on their way to a pod)
    const form = this.standIn("form", { recipe: recipeId, input: rawInput, finishedFrom: opts.finishedFrom, clip: opts.clip });
    const can = (await this.planner.ableOf([form]).catch(() => new Map<string, Able>())).get(form.id)?.can;
    const open = lanes.filter((l) => l.reachable !== false && !l.paused && !this.unavailable(l.id) && (l.machine!.takes === "all" || l.machine!.takes === makes) && (!can || can.has(l.id)));
    const auto = open.flatMap((l) => (got.on![l.id] ? [l.id] : []));
    const soonest = auto.map((id) => got.on![id]!).sort((a, b) => a.ms - b.ms)[0];
    return { ...got, ...(soonest ? { forecast: soonest } : {}), auto, ...(can ? { can: [...can] } : {}) };
  }

  /** A form as a waiting job of it would be read (by the plan, the machines' checks), queued nowhere. */
  private standIn(id: string, f: { recipe: string; input: unknown; finishedFrom?: string | null; clip?: { id: string; fit: boolean } | null; after?: string | null }): JobRow {
    const r: Partial<JobRow> = {
      id, recipe_id: f.recipe, inputs: JSON.stringify(f.input ?? {}), status: "queued", warm: 0, pin_machine: null, depends_on: f.after ?? null,
      finished_from: f.finishedFrom ?? null, clip_id: f.clip?.id ?? null, clip_fit: f.clip?.fit ? 1 : 0, created_at: now(),
    };
    return r as JobRow;
  }

  /**
   * What these jobs would take in all, as the queue would share them between its machines (schedule.ts planTotal), the
   * queue's own waits aside: two free machines take a timeline's finishes in about half the time one does, each at its own
   * pace, each loading its model once for a run of renders with it. A render is a form (with the draft it finishes, the
   * clip it renders, the job before it it carries on from); a cut, its options (a finish on the GPU). `times`: renders of
   * the same form. Null when one of them has nothing learned yet; `samples`: the fewest past renders a render rests on.
   */
  async total(parts: ReadonlyArray<{ recipe: string; input: unknown; finishedFrom?: string | null; clip?: { id: string; fit: boolean } | null; after?: number; times?: number }>): Promise<{ ms: number | null; samples: number }> {
    if (!parts.length) return { ms: null, samples: 0 };
    const all = await this.refresh();
    const open = all.filter((l) => !l.paused && l.reachable !== false && !this.unavailable(l.id));
    const lanes = (await this.planner.schedulable(open.length ? open : all.slice(0, 1))).map((l) => ({ ...l, busyForMs: 0 }));
    // with nothing open at all (every machine away), the first one as it was
    if (!lanes.length && all[0]) lanes.push({ id: all[0].id, takes: "all", busyForMs: 0, holds: new Set(), pace: 1 });
    const rows: JobRow[] = [];
    const last: string[] = [];
    for (const [i, p] of parts.entries()) {
      for (let k = 0; k < Math.max(1, p.times ?? 1); k++) rows.push(this.standIn(`part.${i}.${k}`, { ...p, after: p.after !== undefined ? last[p.after] : null }));
      last[i] = rows[rows.length - 1]!.id;
    }
    const jobs = await this.planner.planned(rows, await this.planner.ableOf(rows.filter(needsComfy)).catch(() => new Map<string, Able>()));
    // a render nothing like was rendered yet makes the whole unknown, not a sum that leaves it out
    if (jobs.some((j) => j.renderMs === null && !j.renderOn?.size)) return { ms: null, samples: 0 };
    const renders = rows.filter((r) => r.recipe_id !== CUT_JOB);
    const samples = renders.length ? Math.min(...(await Promise.all(renders.map(async (r) => {
      const recipe = this.registry.recipe(r.recipe_id);
      return recipe ? (await this.forecasts.expectedAll(recipe, readJson<Record<string, unknown>>(r.inputs, {}), false, r)).samples : 0;
    })))) : 0;
    return { ms: planTotal(lanes, jobs), samples };
  }
}
