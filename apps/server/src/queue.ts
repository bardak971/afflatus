import { EventEmitter } from "node:events";
import { ComfyCancelled, ComfyError, ComfyFailed, ComfyLost, ComfyUnreachable, waitForOutputs, type Measured } from "@afflatus/comfy";
import { expandWildcards, modelFileName, parseInput, type BuiltGraph, type InputSpec, type Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { newId, now, OWNER, type Db } from "./db";
import { addedBy } from "./events";
import { httpError } from "./errors";
import { rates } from "./forecast";
import type { Registry } from "./registry";
import { record } from "./renders";
import { readSettings } from "./settings";
import type { Storage } from "./storage";
import type { CutOptions, ExportOptions, Timelines } from "./timelines";
import { CUT_JOB, EXPORT_JOB } from "./timelineModel";
import { DEFAULT_QUEUE_OPTIONS, readJson, SHUTDOWN, type JobRow, type QueueCore, type QueueOptions, type Resume, type Running, type Usual } from "./queueModel";
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
 * The queue. One ComfyUI, so one job at a time, in order. Jobs live in the database: a restart loses
 * nothing. Queued jobs stay queued, and a job ComfyUI already has is waited on again by its prompt id.
 */

const PAUSED_KEY = "queue.paused";
/** The name of the model among them that a person knows it by, to say which one is loaded. */
const MODEL_KEY = "queue.model";
/** The base models the last job had ComfyUI load, kept across restarts of this app (ComfyUI keeps running through them). */
const LOADS_KEY = "queue.loads";
/** At most how often a running render's step count is saved on its job, when the options do not say. */
const STEPS_SAVE_MS = 5_000;

export class Queue {
  /** "queue": jobs changed. "library": an asset was added. "progress": the running job moved. */
  readonly events = new EventEmitter();
  private busy = false;
  /** pump() was called while a pass was under way: one more pass is made before stopping, so a job queued meanwhile is not left waiting. */
  private dirty = false;
  private paused = false;
  private running: Running | null = null;
  /** ComfyUI holds a model this app had it load. Unknown after a restart: taken as not. */
  private holds = false;
  private unloadTimer: NodeJS.Timeout | null = null;
  /** ComfyUI away and back (queueOffline.ts). */
  private readonly offline: Offline;
  private retry: NodeJS.Timeout | null = null;
  /**
   * The base models the last job loaded (checkpoint or diffusion model, text encoders, VAE), file names
   * joined by "|". A job that needs a base model that is not among them frees ComfyUI's memory first;
   * another LoRA or upscaler does not. It is stored, so that a restart of this app does not have ComfyUI
   * unload a model the next job uses again; unknown (null) only before the first job ever and after
   * the memory was freed by hand.
   */
  private lastLoads: string | null = null;
  /** The name of the model that is loaded, when it is known. */
  private lastModel: string | null = null;
  private stopped = false;
  /** The timelines, for jobs that render a clip of one (set once both exist). */
  clips: Timelines | null = null;
  /** The door the submitting, storing, tools and view modules reach this state through (queueModel.ts). */
  private readonly core: QueueCore;

  constructor(
    private readonly db: Db,
    storage: Storage,
    private readonly comfy: () => Promise<Comfy>,
    private readonly registry: Registry,
    private readonly opts: QueueOptions = DEFAULT_QUEUE_OPTIONS,
  ) {
    const self = this;
    this.core = {
      db, storage, registry, opts, comfy, events: this.events,
      // the state is read as it stands at the moment it is asked for, never copied
      get clips() { return self.clips; },
      get running() { return self.running; },
      get paused() { return self.paused; },
      get lastLoads() { return self.lastLoads; },
      get lastModel() { return self.lastModel; },
      get offlineSince() { return self.offline.since; },
      loaded: (loads, model) => this.loaded(loads, model),
      usual: () => this.usual(),
      expected: (recipe, input, cold, job) => this.expected(recipe, input, cold, job),
      runTool: (row, work) => this.runTool(row, work),
    };
    this.offline = new Offline({
      events: this.events, opts,
      running: () => this.running,
      forget: () => this.loaded(null),
      pump: () => void this.pump(),
      retryLater: () => this.retryLater(),
      fail: (r, error) => this.finish(r.id, "failed", { error }, r.status),
    });
  }

  // ---------------------------------------------------------------- start / stop

  /** The state kept across restarts (paused, what ComfyUI was last asked to load), read once: before any request can reach the queue. */
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
    const loaded = await this.db.selectFrom("settings").select("value").where("key", "=", LOADS_KEY).executeTakeFirst();
    const named = await this.db.selectFrom("settings").select("value").where("key", "=", MODEL_KEY).executeTakeFirst();
    this.lastModel = loaded?.value ? named?.value || null : null;
    if (loaded) this.lastLoads = loaded.value || null;
    else {
      // nothing noted yet (a database from before the note existed): what the last render loaded
      const last = await this.db.selectFrom("generations").select("resolved").orderBy("created_at", "desc").limit(1).executeTakeFirst();
      const files = readJson<{ loads?: string[] }>(last?.resolved, {}).loads;
      this.lastLoads = files ? files.map(modelFileName).sort().join("|") : null;
    }
  }

  /** Stop taking jobs (tests, shutdown). The running job is left to ComfyUI and picked up again on the next start. */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.running?.abort.abort(SHUTDOWN);
  }

  /** Resolves when nothing is running and nothing can start (tests). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
  }

  // ---------------------------------------------------------------- enqueue / cancel / pause

  async enqueue(recipeId: string, rawInput: unknown, opts: { label?: string; dependsOn?: string; clip?: { id: string; fit: boolean; mirror?: readonly string[] }; draft?: string | null; folder?: string | null; warm?: boolean; look?: unknown; finishedFrom?: string | null; asked?: Record<string, unknown> } = {}): Promise<string> {
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
        draft_id: opts.draft ?? null, folder_id: opts.folder ?? null, finished_from: opts.finishedFrom ?? null,
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

  async cancel(id: string): Promise<boolean> {
    // a job queued again with the prompt ComfyUI may still have (lost from sight, or a finish stopped by a restart): that prompt
    // is stopped in ComfyUI too, or it would go on rendering what nobody wants any more
    const sent = readJson<Partial<Resume>>((await this.db.selectFrom("jobs").select("resume").where("id", "=", id).where("status", "=", "queued").executeTakeFirst())?.resume, {}).promptId;
    // a waiting job: claim it in one statement, so a pump that picks it at the same moment loses
    const queued = await this.db
      .updateTable("jobs")
      .set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() })
      .where("id", "=", id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(queued.numUpdatedRows) > 0) {
      if (sent) void this.comfy().then((c) => c.client.interrupt(sent)).catch(() => {});
      // what continues from it can never run now, as when it is stopped while it runs
      await this.failDependents(id);
      this.events.emit("queue");
      if (await bulk.ofTimeline(this.db, [id])) this.events.emit("timeline");
      return true;
    }
    if (this.running?.id === id) {
      this.running.abort.abort();
      if (this.running.promptId) await (await this.comfy()).client.interrupt(this.running.promptId).catch(() => {});
      return true;
    }
    // a job ComfyUI had when this process last stopped, not picked up again yet (ComfyUI is away): stopped here, and in ComfyUI when it answers
    const resumed = await this.db.selectFrom("jobs").select("resume").where("id", "=", id).where("status", "=", "running").executeTakeFirst();
    if (!resumed) return false;
    const stopped = await this.db
      .updateTable("jobs")
      .set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() })
      .where("id", "=", id)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (Number(stopped.numUpdatedRows) === 0) return false;
    // picked up in the meantime: stopped there too
    if (this.running?.id === id) this.running.abort.abort();
    const promptId = readJson<Partial<Resume>>(resumed.resume, {}).promptId;
    if (promptId) void this.comfy().then((c) => c.client.interrupt(promptId)).catch(() => {});
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
    // the whole order lands at once: a pump reading the line in the middle of it would see a half-made one
    await this.db.transaction().execute(async (tx) => {
      for (const [i, id] of order.entries()) await tx.updateTable("jobs").set({ priority: -100_000 + i, updated_at: now() }).where("id", "=", id).where("status", "=", "queued").execute();
    });
    this.events.emit("queue");
  }

  /**
   * Unload ComfyUI's models now: the GPU's memory is wanted for something else. Not while a render is
   * under way (its model is in use); the next render loads what it needs again.
   */
  async freeMemory(): Promise<void> {
    if (this.running?.gpu) throw httpError("A render is under way and its model is loaded. Wait for it, or cancel it first.");
    await (await this.comfy()).client.free();
    await this.loaded(null);
    // every open screen says which model is loaded: they are told it no longer is
    this.events.emit("queue");
    this.holds = false;
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  /** One setting of the queue's own, written or replaced. */
  private async setting(key: string, value: string): Promise<void> {
    await this.db
      .insertInto("settings")
      .values({ key, value, updated_at: now() })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now() }))
      .execute();
  }

  /** Note what ComfyUI was last asked to load, here and in the database. */
  private async loaded(loads: string | null, model: string | null = null): Promise<void> {
    if (this.lastLoads === loads && this.lastModel === model) return;
    this.lastLoads = loads;
    this.lastModel = model;
    // only a note: a database that cannot take it costs one needless unload after the next restart.
    // Freed by hand is noted as empty, which is not the same as nothing noted.
    await this.setting(MODEL_KEY, model ?? "").catch(() => {});
    await this.setting(LOADS_KEY, loads ?? "").catch(() => {});
  }

  /** After a render or a job on the GPU: when it is set in Settings, the models are unloaded once nothing has rendered for that long. */
  private async armIdle(): Promise<void> {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    if (this.stopped || !this.holds) return;
    const minutes = (await readSettings(this.db).catch(() => null))?.unloadAfterMinutes ?? 0;
    if (!(minutes > 0)) return;
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      // a render that started in the meantime keeps its model
      if (this.running?.gpu || this.stopped) return;
      void this.freeMemory().then(() => this.events.emit("queue"), () => {});
    }, minutes * 60_000);
    // a timer that is only waiting to free memory never keeps the process alive
    this.unloadTimer.unref();
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

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    await this.setting(PAUSED_KEY, String(paused));
    this.events.emit("queue");
    if (!paused) void this.pump();
  }

  // ---------------------------------------------------------------- what the queue screen shows (queueView.ts)

  /** The line as it stands, the running job's progress, and the last finished jobs. */
  status() { return view.status(this.core); }
  /** The running job's figures alone, from memory: what a progress event carries, many times a second. */
  progress() { return view.progress(this.core); }
  /** The running job's latest live preview. */
  preview(jobId: string) { return view.preview(this.core, jobId); }
  /** One picture the running job showed on the way (its Preview nodes), by its place in the strip. */
  stage(jobId: string, n: number) { return view.stage(this.core, jobId, n); }
  /** The finished jobs, newest first, with what each made: filtered and paged. */
  history(opts: Parameters<typeof view.history>[1] = {}) { return view.history(this.core, opts); }

  // ---------------------------------------------------------------- the worker

  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    try {
      for (;;) {
        if (this.stopped) break;
        this.dirty = false;
        const active = await this.db.selectFrom("jobs").selectAll().where("status", "in", ["queued", "running"]).orderBy("priority").orderBy("created_at").execute();
        const waitingOn = new Set(active.map((r) => r.id));
        // a job ComfyUI already has goes first, paused or not: it is rendering anyway
        const line = [...active.filter((r) => r.status === "running"), ...active.filter((r) => r.status === "queued" && !(r.depends_on && waitingOn.has(r.depends_on)))];
        let comfy: Comfy | null = null;
        let reachable: boolean | null = null;
        let next: JobRow | undefined;
        for (const r of line) {
          // what needs no ComfyUI (an export, a cut by ffmpeg) goes on whatever ComfyUI is doing: paused, away, or a GPU job before it waiting
          if (!needsComfy(r)) {
            next = r;
            break;
          }
          // a pause is for the GPU: a render, a finish and a RIFE slow-motion wait for its end
          if (this.paused && r.status === "queued") continue;
          if (reachable === false) continue;
          comfy ??= await this.comfy();
          reachable = await comfy.client.status().then(() => true, () => false);
          if (reachable) {
            next = r;
            break;
          }
        }
        if (reachable === false) await this.offline.whileOffline(active);
        else if (reachable) this.offline.answered();
        if (!next) {
          // a job queued while this pass was reading the line: the line is read again
          if (this.dirty && !this.stopped && reachable !== false) continue;
          break;
        }
        if (next.recipe_id === EXPORT_JOB) await tools.runExport(this.core, next);
        else if (next.recipe_id === CUT_JOB) await tools.runCut(this.core, next);
        else await this.run(comfy!, next);
      }
    } catch (err) {
      console.error("[queue] stopped unexpectedly:", err);
      this.retryLater();
    } finally {
      this.busy = false;
    }
  }

  private retryLater(): void {
    if (this.retry || this.stopped) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.pump();
    }, this.opts.offlineRetryMs);
  }

  /** What the page's status poll (events.ts) found of ComfyUI (queueOffline.ts). */
  noteReachable(ok: boolean): void {
    this.offline.noteReachable(ok);
  }

  /** A job ends. `from`: only when it is still in that state (a job that was cancelled meanwhile stays cancelled). */
  private async finish(id: string, status: "done" | "failed" | "cancelled", extra: { error?: string; generationId?: string; trace?: string | null } = {}, from?: JobRow["status"]) {
    // a generation the job wrote before it ended badly stays named on it: what it made is in the library all the same
    let q = this.db
      .updateTable("jobs")
      .set({ status, error: extra.error ?? null, error_trace: extra.trace ?? null, ...(extra.generationId ? { generation_id: extra.generationId } : {}), finished_at: now(), updated_at: now() })
      .where("id", "=", id);
    if (from) q = q.where("status", "=", from);
    await q.execute();
    if (status !== "done") await this.failDependents(id);
    this.events.emit("queue");
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
   * A job that needs no model: a cut or an export, done by ffmpeg on the computer Afflatus runs on (a
   * finish or a RIFE slow-motion takes the GPU for a while all the same). Claimed in one statement, so
   * that a cancel landing at the same moment wins; on a shutdown it is queued again for the next start,
   * stopped by hand it is cancelled, anything else it threw is its failure.
   */
  private async runTool(row: JobRow, work: (run: Running) => Promise<void>): Promise<void> {
    const claimed = await this.db
      .updateTable("jobs")
      .set({ status: "running", attempts: row.attempts + 1, started_at: now(), updated_at: now() })
      .where("id", "=", row.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return;
    const run: Running = { id: row.id, abort: new AbortController(), gpu: false, tool: row.recipe_id === EXPORT_JOB ? "exporting" : "cutting" };
    this.running = run;
    this.events.emit("queue");
    try {
      await work(run);
      await this.finish(row.id, "done");
    } catch (err) {
      if (this.stopped) await this.db.updateTable("jobs").set({ status: "queued", updated_at: now() }).where("id", "=", row.id).execute();
      else if (run.abort.signal.aborted) await this.finish(row.id, "cancelled", { error: "stopped by you" });
      else await this.failure(row, run.promptId, err as Error);
    } finally {
      this.running = null;
      // a finish or a RIFE pass loaded models into ComfyUI: the idle unload counts from its end, as after a render
      if (run.gpu) {
        this.holds = true;
        void this.armIdle();
      }
    }
  }

  private async run(comfy: Comfy, row: JobRow): Promise<void> {
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
      .set({ status: "running", attempts, started_at: row.started_at ?? now(), updated_at: now() })
      .where("id", "=", row.id)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return;

    const abort = new AbortController();
    /** The prompt followed from before it was sent (see the hold below): no longer followed once the job ends, however it ends. */
    let early: string | null = null;
    this.running = { id: row.id, abort, promptId: resume?.promptId, gpu: true, expectedMs: resume?.timing?.expectedMs ?? null, startedAt: resume?.startedAt ?? Date.now() };
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.holds = true;
    this.events.emit("queue");
    try {
      // a job found with its generation already named had filed its result before this process last stopped: it is closed, not rendered again
      if (row.generation_id && !row.warm) return await this.closeFiled(row, row.generation_id, resume);
      const input = JSON.parse(row.inputs) as Record<string, unknown>;
      if (!resume) {
        // a Stop while its files go up ends it there, before ComfyUI frees its memory or is sent anything (checked again below
        // for one pressed while the prompt was on its way)
        resume = await submitting.submit(this.core, comfy, recipe, input, row, async (r) => {
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
      this.running.promptId = resume.promptId;
      this.running.titles = resume.titles;
      // a fresh render learns how long it should take only once it is sent: the spilling warning needs it from the first run on
      this.running.expectedMs ??= resume.timing?.expectedMs ?? null;
      this.running.startedAt = resume.startedAt;
      this.running.seed = resume.seed;
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
      comfy.monitor.onChange = () => {
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
      // ComfyUI is done with it: its model is no longer in use, and freeing the memory is no longer refused (this.running
      // stays until the job is closed, for a cancel and the queue screen)
      this.running.gpu = false;
      const tookMs = Date.now() - resume.startedAt;
      if (row.warm) {
        // the models are loaded, which is all that was asked
        await this.finish(row.id, "done");
        return;
      }
      const generationId = await storing.store(this.core, comfy, recipe, resume.input ?? input, resume, outputs, row);
      made = generationId;
      await this.place(row, generationId, resume);
      // on record before the job says done: a screen told it is done reads its time with it (the forecast, the stats)
      await this.note(row, recipe, resume, measured, "done", whole, tookMs, generationId);
      await this.finish(row.id, "done", { generationId });
      this.events.emit("library", await addedBy(this.db, generationId));
    } catch (err) {
      await this.failed(err as Error, row, recipe, { resume, held, measured, made, whole, attempts, aborted: abort.signal.aborted });
    } finally {
      if (early) comfy.monitor.untrack(early);
      this.running = null;
      void this.armIdle();
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
  private async failed(err: Error, row: JobRow, recipe: Recipe<any>, at: { resume: Resume | null; held?: Resume | null; measured: Measured | null; made?: string; whole: boolean; attempts: number; aborted: boolean }): Promise<void> {
    const { resume, measured, made, whole } = at;
    // what never reached ComfyUI took no GPU time: only a render that was under way is put on record
    const onRecord = resume && !made && !row.warm;
    if (this.stopped) {
      // shutting down: leave the row as it is, the next start picks it up
    } else if (err instanceof ComfyCancelled || at.aborted) {
      // on record before the job says how it ended, as a render that is done
      if (onRecord) await this.note(row, recipe, resume, measured, "cancelled", whole, Date.now() - resume.startedAt);
      await this.finish(row.id, "cancelled", { error: "stopped by you" });
    } else if ((err instanceof ComfyLost || err instanceof ComfyUnreachable) && Math.max(at.attempts, row.attempts + 1) < this.opts.maxAttempts) {
      console.warn(`[queue] job ${row.id} lost (${err.message}), queued again`);
      // ComfyUI may have the prompt all the same: one sent without an answer (it did not answer in time), and one it finished
      // or still runs while this process lost sight of it (90 s of silence, its file not fetched). Its id is kept, so that the
      // next attempt asks ComfyUI for it (taken) and follows it, instead of rendering again a video that would come out different
      const kept = resume ?? at.held;
      const unsent = kept && !made ? JSON.stringify({ ...kept, unsent: true }) : null;
      // each loss counts as an attempt, a prompt followed again too: one that keeps getting lost is given up in the end
      await this.db.updateTable("jobs").set({ status: "queued", resume: unsent, attempts: Math.max(at.attempts, row.attempts + 1), warning: null, updated_at: now() }).where("id", "=", row.id).where("status", "=", "running").execute();
      this.events.emit("queue");
    } else {
      if (onRecord) await this.note(row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
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

  /** Put a render on the record of render times (renders.ts). Never in the way of the render itself: a failure here is only said. */
  private async note(row: JobRow, recipe: Recipe<any>, resume: Resume, measured: Measured | null, status: "done" | "failed" | "cancelled", whole: boolean, totalMs: number, generationId?: string): Promise<void> {
    try {
      await record(this.db, row, recipe, resume, measured, status, whole, totalMs, generationId);
      this.known = null;
    } catch (err) {
      console.warn(`[queue] the time of job ${row.id} was not put on record: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- a form against this ComfyUI (queueSubmit.ts)

  /** The graph a form (or a past render) gives, built without uploading anything; null when the form is not complete enough to build. */
  builtOf(recipeId: string, rawInput: unknown, opts: Parameters<typeof submitting.builtOf>[3] = {}): Promise<BuiltGraph | null> { return submitting.builtOf(this.core, recipeId, rawInput, opts); }
  /** Whether the base models a form would use are the ones ComfyUI was last asked to load; null when it cannot be told. */
  isLoaded(recipeId: string, rawInput: unknown): Promise<boolean | null> { return submitting.isLoaded(this.core, recipeId, rawInput); }
  /** What this model's past renders say a form will take; null without history or for a form not complete enough to build. */
  forecast(recipeId: string, rawInput: unknown, opts: { finishedFrom?: string | null; clip?: { id: string; fit: boolean } | null } = {}) { return submitting.forecastOf(this.core, recipeId, rawInput, opts); }
}
