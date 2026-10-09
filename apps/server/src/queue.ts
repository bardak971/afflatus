import { EventEmitter } from "node:events";
import { ComfyCancelled, ComfyLost, ComfyUnreachable, waitForOutputs, type Measured } from "@afflatus/comfy";
import { expandWildcards, modelFileName, parseInput, type BuiltGraph, type InputSpec, type Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { newId, now, OWNER, type Db } from "./db";
import { httpError } from "./errors";
import { estimateMs, rates } from "./estimates";
import type { Registry } from "./registry";
import { guessFor, known, record } from "./renders";
import { readSettings } from "./settings";
import type { Storage } from "./storage";
import { CUT_JOB, EXPORT_JOB, type CutOptions, type ExportOptions, type Timelines } from "./timelines";
import { DEFAULT_QUEUE_OPTIONS, readJson, type JobRow, type QueueCore, type QueueOptions, type Resume, type Running, type Usual } from "./queueModel";
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

/** @deprecated An error a person reads, as a 400: httpError (errors.ts) is the one to throw. Kept while timelines-api.ts still names it. */
export class UserError extends Error {
  statusCode = 400;
}

const PAUSED_KEY = "queue.paused";
/** The name of the model among them that a person knows it by, to say which one is loaded. */
const MODEL_KEY = "queue.model";
/** The base models the last job had ComfyUI load, kept across restarts of this app (ComfyUI keeps running through them). */
const LOADS_KEY = "queue.loads";
/** At most how often a running render's step count is saved on its job, when the options do not say. */
const STEPS_SAVE_MS = 5_000;

/** Whether a job needs ComfyUI: a render, a finish and a RIFE slow-motion do; an export and a cut by ffmpeg do not. */
const needsComfy = (r: JobRow) => r.recipe_id !== EXPORT_JOB && (r.recipe_id !== CUT_JOB || tools.usesGpu(r));

export class Queue {
  /** "queue": jobs changed. "library": an asset was added. "progress": the running job moved. */
  readonly events = new EventEmitter();
  private busy = false;
  private paused = false;
  private running: Running | null = null;
  /** ComfyUI holds a model this app had it load. Unknown after a restart: taken as not. */
  private holds = false;
  private unloadTimer: NodeJS.Timeout | null = null;
  private offlineSince: number | null = null;
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
      get offlineSince() { return self.offlineSince; },
      loaded: (loads, model) => this.loaded(loads, model),
      usual: () => this.usual(),
      expected: (usual, recipe, input, cold) => this.expected(usual, recipe, input, cold),
      runTool: (row, work) => this.runTool(row, work),
    };
  }

  // ---------------------------------------------------------------- start / stop

  /** After a restart: jobs that were mid-run without a prompt id start over; the others are waited on again. */
  async start(): Promise<void> {
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
    // a tool job (an export, a cut, a finish) is run again from its start: what it already made is noted on it (queueTools.ts)
    await this.db
      .updateTable("jobs")
      .set({ status: "queued", updated_at: now() })
      .where("status", "=", "running")
      .where((eb) => eb.or([eb("resume", "is", null), eb("recipe_id", "in", [EXPORT_JOB, CUT_JOB])]))
      .execute();
    void this.pump();
  }

  /** Stop taking jobs (tests, shutdown). The running job is left to ComfyUI and picked up again on the next start. */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.running?.abort.abort();
  }

  /** Resolves when nothing is running and nothing can start (tests). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
  }

  // ---------------------------------------------------------------- enqueue / cancel / pause

  async enqueue(recipeId: string, rawInput: unknown, opts: { label?: string; dependsOn?: string; clip?: { id: string; fit: boolean }; draft?: string | null; folder?: string | null; warm?: boolean; look?: unknown; finishedFrom?: string | null; asked?: Record<string, unknown> } = {}): Promise<string> {
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
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: opts.clip?.id ?? null, clip_fit: opts.clip?.fit ? 1 : 0,
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
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: timeline, draft_id: null, folder_id: null,
        created_at: at, started_at: null, finished_at: null, updated_at: at,
      })
      .execute();
    this.events.emit("queue");
    void this.pump();
    return id;
  }

  async cancel(id: string): Promise<boolean> {
    // a waiting job: claim it in one statement, so a pump that picks it at the same moment loses
    const queued = await this.db
      .updateTable("jobs")
      .set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() })
      .where("id", "=", id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(queued.numUpdatedRows) > 0) {
      // what continues from it can never run now, as when it is stopped while it runs
      await this.failDependents(id);
      this.events.emit("queue");
      this.events.emit("timeline");
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
    this.events.emit("timeline");
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
      clip: row.clip_id ? { id: row.clip_id, fit: Boolean(row.clip_fit) } : undefined,
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

  /** Take several finished jobs off the list in one go (one event for all); how many went. Jobs not finished stay. */
  async dismissAll(ids: readonly string[]): Promise<number> {
    if (!ids.length) return 0;
    const finished = this.db.selectFrom("jobs").where("id", "in", [...ids]).where("status", "in", ["done", "failed", "cancelled"]);
    // a clip's job, a cut or an export is seen on its timeline too
    const timeline = await finished.select("id").where((eb) => eb.or([eb("clip_id", "is not", null), eb("timeline_id", "is not", null)])).executeTakeFirst();
    const r = await this.db.deleteFrom("jobs").where("id", "in", [...ids]).where("status", "in", ["done", "failed", "cancelled"]).executeTakeFirst();
    this.events.emit("queue");
    if (timeline) this.events.emit("timeline");
    return Number(r.numDeletedRows);
  }

  /**
   * Several finished jobs again, in the order given (a "Retry all failed"): one request, each queued as `again` does it.
   * With `dismiss`, the ones queued again leave the history in the same go. A job not finished is left alone; one that
   * cannot be queued again (its workflow was deleted) is counted, not thrown.
   */
  async againAll(ids: readonly string[], opts: { dismiss?: boolean } = {}): Promise<{ ids: string[]; failed: number }> {
    if (!ids.length) return { ids: [], failed: 0 };
    const finished = new Set((await this.db.selectFrom("jobs").select("id").where("id", "in", [...ids]).where("status", "in", ["done", "failed", "cancelled"]).execute()).map((r) => r.id));
    const queued: string[] = [];
    const retried: string[] = [];
    let failed = 0;
    for (const id of ids) {
      if (!finished.has(id)) continue;
      try {
        queued.push(await this.again(id));
        retried.push(id);
      } catch {
        failed++;
      }
    }
    if (opts.dismiss && retried.length) await this.dismissAll(retried);
    return { ids: queued, failed };
  }

  /**
   * Every waiting job cancelled in one statement (or, with `ids`, those of them that still wait: what the page showed
   * when it was asked); how many were. What continues from one of them fails, as with a single cancel. The running job goes on.
   */
  async cancelWaiting(ids?: readonly string[]): Promise<number> {
    let picked = this.db.selectFrom("jobs").select("id").where("status", "=", "queued");
    if (ids) picked = picked.where("id", "in", ids.length ? [...ids] : [""]);
    const waiting = (await picked.execute()).map((r) => r.id);
    if (!waiting.length) return 0;
    const r = await this.db
      .updateTable("jobs")
      .set({ status: "cancelled", error: "stopped by you", finished_at: now(), updated_at: now() })
      .where("id", "in", waiting)
      .where("status", "=", "queued")
      .executeTakeFirst();
    // one left out of `ids` may continue one cancelled now: it can never run
    for (const id of waiting) await this.failDependents(id);
    this.events.emit("queue");
    this.events.emit("timeline");
    return Number(r.numUpdatedRows);
  }

  private known: (Usual & { at: number }) | null = null;
  /** How long things usually take, worked out at most twice a minute. */
  private async usual() {
    if (!this.known || Date.now() - this.known.at > 30_000) this.known = { at: Date.now(), rates: await rates(this.db), record: await known(this.db) };
    return this.known;
  }

  /**
   * About how long a render will take: from the record of renders like it (and then with what loading
   * its model adds, when it is not the one loaded), else from the totals of before there was a record.
   */
  private expected(usual: Usual, recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean): number | null {
    const g = guessFor(usual.record, recipe, input);
    return g ? g.ms + (cold ? g.loadMs : 0) : estimateMs(usual.rates, recipe, input);
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
  history(opts: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; offset?: number; limit?: number } = {}) { return view.history(this.core, opts); }

  // ---------------------------------------------------------------- the worker

  private async pump(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.stopped) break;
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
        if (reachable === false) await this.whileOffline(active);
        else if (reachable && this.offlineSince !== null) {
          this.offlineSince = null;
          this.events.emit("queue");
        }
        if (!next) break;
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

  /** ComfyUI is away: the jobs that need it wait, and are given up once it has been away too long (a job it had before a restart too). */
  private async whileOffline(active: JobRow[]): Promise<void> {
    if (this.offlineSince === null) {
      this.offlineSince = Date.now();
      this.events.emit("queue");
    }
    if (Date.now() - this.offlineSince > this.opts.offlineExpiryMs) {
      for (const r of active) {
        if (!needsComfy(r) || this.running?.id === r.id) continue;
        await this.finish(r.id, "failed", { error: "ComfyUI stayed offline. Try again when it is back." }, r.status);
      }
    }
    this.retryLater();
  }

  /** A job ends. `from`: only when it is still in that state (a job that was cancelled meanwhile stays cancelled). */
  private async finish(id: string, status: "done" | "failed" | "cancelled", extra: { error?: string; generationId?: string } = {}, from?: JobRow["status"]) {
    // a generation the job wrote before it ended badly stays named on it: what it made is in the library all the same
    let q = this.db
      .updateTable("jobs")
      .set({ status, error: extra.error ?? null, ...(extra.generationId ? { generation_id: extra.generationId } : {}), finished_at: now(), updated_at: now() })
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
      else await this.finish(row.id, "failed", { error: (err as Error).message.slice(0, 600) });
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
        resume = await submitting.submit(this.core, comfy, recipe, input, row, async (r) => {
          held = r;
          await this.db.updateTable("jobs").set({ resume: JSON.stringify(r), updated_at: now() }).where("id", "=", row.id).execute();
        });
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
        await comfy.client.interrupt(resume.promptId).catch(() => {});
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
      let outputs;
      try {
        outputs = await waitForOutputs(comfy.client, resume.promptId, { ...this.opts.wait, signal: abort.signal });
      } finally {
        measured = comfy.monitor.measured(resume.promptId);
        comfy.monitor.untrack(resume.promptId);
        // a save under way lands before the job is closed or queued again, never over what that writes
        await saving.settled();
      }
      const tookMs = Date.now() - resume.startedAt;
      if (row.warm) {
        // the models are loaded, which is all that was asked
        await this.finish(row.id, "done");
        return;
      }
      const generationId = await storing.store(this.core, comfy, recipe, resume.input ?? input, resume, outputs, row);
      made = generationId;
      await this.place(row, generationId, resume);
      await this.finish(row.id, "done", { generationId });
      await this.note(row, recipe, resume, measured, "done", whole, tookMs, generationId);
      this.events.emit("library");
    } catch (err) {
      await this.failed(err as Error, row, recipe, { resume, held, measured, made, whole, attempts, aborted: abort.signal.aborted });
    } finally {
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
    this.events.emit("library");
  }

  /** How a render ended that did not finish: stopped by hand, lost by ComfyUI (queued again while attempts remain), or failed; never while shutting down. */
  private async failed(err: Error, row: JobRow, recipe: Recipe<any>, at: { resume: Resume | null; held?: Resume | null; measured: Measured | null; made?: string; whole: boolean; attempts: number; aborted: boolean }): Promise<void> {
    const { resume, measured, made, whole } = at;
    // what never reached ComfyUI took no GPU time: only a render that was under way is put on record
    const onRecord = resume && !made && !row.warm;
    if (this.stopped) {
      // shutting down: leave the row as it is, the next start picks it up
    } else if (err instanceof ComfyCancelled || at.aborted) {
      await this.finish(row.id, "cancelled", { error: "stopped by you" });
      if (onRecord) await this.note(row, recipe, resume, measured, "cancelled", whole, Date.now() - resume.startedAt);
    } else if ((err instanceof ComfyLost || err instanceof ComfyUnreachable) && at.attempts < this.opts.maxAttempts) {
      console.warn(`[queue] job ${row.id} lost (${err.message}), queued again`);
      // a prompt sent without an answer (ComfyUI did not answer in time) may have been taken all the same: its id is kept to ask for it
      const unsent = !resume && at.held ? JSON.stringify(at.held) : null;
      await this.db.updateTable("jobs").set({ status: "queued", resume: unsent, warning: null, updated_at: now() }).where("id", "=", row.id).where("status", "=", "running").execute();
      this.events.emit("queue");
    } else {
      await this.finish(row.id, "failed", { error: err.message.slice(0, 600) });
      if (onRecord) await this.note(row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
    }
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
  builtOf(recipeId: string, rawInput: unknown, opts: { seed?: number; names?: Record<string, string> } = {}): Promise<BuiltGraph | null> { return submitting.builtOf(this.core, recipeId, rawInput, opts); }
  /** Whether the base models a form would use are the ones ComfyUI was last asked to load; null when it cannot be told. */
  isLoaded(recipeId: string, rawInput: unknown): Promise<boolean | null> { return submitting.isLoaded(this.core, recipeId, rawInput); }
  /** What this model's past renders say a form will take; null without history or for a form not complete enough to build. */
  forecast(recipeId: string, rawInput: unknown) { return submitting.forecastOf(this.core, recipeId, rawInput); }
}
