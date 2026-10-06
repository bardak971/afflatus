import { EventEmitter } from "node:events";
import { ComfyCancelled, ComfyLost, ComfyUnreachable, waitForOutputs, type Measured } from "@afflatus/comfy";
import { expandWildcards, modelFileName, parseInput, type BuiltGraph, type InputSpec, type Recipe } from "@afflatus/core";
import type { Comfy } from "./comfy";
import { newId, now, OWNER, type Db } from "./db";
import { estimateMs, rates } from "./estimates";
import type { Registry } from "./registry";
import { guessFor, known, record } from "./renders";
import { readSettings } from "./settings";
import type { Storage } from "./storage";
import { CUT_JOB, EXPORT_JOB, type CutOptions, type ExportOptions, type Timelines } from "./timelines";
import { DEFAULT_QUEUE_OPTIONS, type JobRow, type QueueCore, type QueueOptions, type Resume, type Running, type Usual } from "./queueModel";
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

export class UserError extends Error {
  statusCode = 400;
}

const PAUSED_KEY = "queue.paused";
/** The name of the model among them that a person knows it by, to say which one is loaded. */
const MODEL_KEY = "queue.model";
/** The base models the last job had ComfyUI load, kept across restarts of this app (ComfyUI keeps running through them). */
const LOADS_KEY = "queue.loads";

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
      const files = last ? (JSON.parse(last.resolved) as { loads?: string[] }).loads : undefined;
      this.lastLoads = files ? files.map(modelFileName).sort().join("|") : null;
    }
    await this.db.updateTable("jobs").set({ status: "queued", updated_at: now() }).where("status", "=", "running").where("resume", "is", null).execute();
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

  async enqueue(recipeId: string, rawInput: unknown, opts: { label?: string; dependsOn?: string; clip?: { id: string; fit: boolean }; draft?: string | null; folder?: string | null; warm?: boolean; look?: unknown; finishedFrom?: string | null } = {}): Promise<string> {
    const recipe = this.registry.recipe(recipeId);
    if (!recipe) throw new UserError(`there is no model or operation called ${recipeId}`);
    // loading the models is asked for while the form is still being filled in: a text not written yet is no reason to refuse
    const input = parseInput(recipe, opts.warm ? submitting.withTexts(recipe, rawInput) : rawInput) as Record<string, unknown>; // throws a ZodError the API turns into a 400
    // choices written in a text ({red|black|white}) are settled now, one per job: what is kept is what was picked
    for (const spec of recipe.inputs as InputSpec[]) {
      if (spec.type === "prompt" && typeof input[spec.id] === "string") input[spec.id] = expandWildcards(input[spec.id] as string);
    }
    const id = newId();
    const at = now();
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: recipe.id, label: opts.label?.trim() || recipe.title, inputs: JSON.stringify(input),
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
      this.events.emit("queue");
      return true;
    }
    if (this.running?.id === id) {
      this.running.abort.abort();
      if (this.running.promptId) await (await this.comfy()).client.interrupt(this.running.promptId).catch(() => {});
      return true;
    }
    return false;
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
    if (this.running?.gpu) throw new UserError("A render is under way and its model is loaded. Wait for it, or cancel it first.");
    await (await this.comfy()).client.free();
    await this.loaded(null);
    // every open screen says which model is loaded: they are told it no longer is
    this.events.emit("queue");
    this.holds = false;
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  /** Note what ComfyUI was last asked to load, here and in the database. */
  private async loaded(loads: string | null, model: string | null = null): Promise<void> {
    if (this.lastLoads === loads && this.lastModel === model) return;
    this.lastLoads = loads;
    this.lastModel = model;
    await this.db
      .insertInto("settings")
      .values({ key: MODEL_KEY, value: model ?? "", updated_at: now() })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: model ?? "", updated_at: now() }))
      .execute()
      .catch(() => {});
    // only a note: a database that cannot take it costs one needless unload after the next restart.
    // Freed by hand is noted as empty, which is not the same as nothing noted.
    const value = loads ?? "";
    await this.db
      .insertInto("settings")
      .values({ key: LOADS_KEY, value, updated_at: now() })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now() }))
      .execute()
      .catch(() => {});
  }

  /** After a render: when it is set in Settings, the models are unloaded once nothing has rendered for that long. */
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
    if (!row) throw new UserError("this job was not found");
    if (row.recipe_id === EXPORT_JOB) return this.enqueueExport(JSON.parse(row.inputs) as ExportOptions, row.label);
    if (row.recipe_id === CUT_JOB) return this.enqueueCut(JSON.parse(row.inputs) as CutOptions, row.label);
    // a workflow whose settings were changed since no longer has some of what the job was sent with
    const has = new Set(this.registry.recipe(row.recipe_id)?.inputs.map((i) => i.id));
    const was = Object.fromEntries(Object.entries(JSON.parse(row.inputs) as Record<string, unknown>).filter(([k]) => !has.size || has.has(k)));
    return this.enqueue(row.recipe_id, { ...was, ...change }, {
      label: row.label,
      clip: row.clip_id ? { id: row.clip_id, fit: Boolean(row.clip_fit) } : undefined,
      draft: row.draft_id, folder: row.folder_id, warm: Boolean(row.warm), look: row.look ? JSON.parse(row.look) : undefined,
    });
  }

  /** Take a finished job off the list. What it made stays in the library. */
  async dismiss(id: string): Promise<boolean> {
    const r = await this.db.deleteFrom("jobs").where("id", "=", id).where("status", "in", ["done", "failed", "cancelled"]).executeTakeFirst();
    this.events.emit("queue");
    this.events.emit("timeline");
    return Number(r.numDeletedRows) > 0;
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
    const value = String(paused);
    await this.db
      .insertInto("settings")
      .values({ key: PAUSED_KEY, value, updated_at: now() })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: now() }))
      .execute();
    this.events.emit("queue");
    if (!paused) void this.pump();
  }

  // ---------------------------------------------------------------- what the queue screen shows (queueView.ts)

  /** The line as it stands, the running job's progress, and the last finished jobs. */
  status() { return view.status(this.core); }
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
        // a job ComfyUI already has goes first, paused or not: it is rendering anyway
        const resumed = active.find((r) => r.status === "running");
        const waitingOn = new Set(active.map((r) => r.id));
        // a pause is for the GPU: an export does not use it, and goes on
        const next = resumed ?? active.find((r) => r.status === "queued" && !(r.depends_on && waitingOn.has(r.depends_on)) && (!this.paused || r.recipe_id === EXPORT_JOB || r.recipe_id === CUT_JOB));
        if (!next) break;
        if (next.recipe_id === EXPORT_JOB) {
          await tools.runExport(this.core, next);
          continue;
        }
        if (next.recipe_id === CUT_JOB) {
          await tools.runCut(this.core, next);
          continue;
        }
        const comfy = await this.comfy();
        try {
          await comfy.client.status();
        } catch {
          await this.whileOffline(active);
          break;
        }
        if (this.offlineSince !== null) {
          this.offlineSince = null;
          this.events.emit("queue");
        }
        await this.run(comfy, next);
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

  private async whileOffline(active: JobRow[]): Promise<void> {
    if (this.offlineSince === null) {
      this.offlineSince = Date.now();
      this.events.emit("queue");
    }
    if (Date.now() - this.offlineSince > this.opts.offlineExpiryMs) {
      for (const r of active) if (r.status === "queued") await this.finish(r.id, "failed", { error: "ComfyUI stayed offline. Try again when it is back." });
    }
    this.retryLater();
  }

  private async finish(id: string, status: "done" | "failed" | "cancelled", extra: { error?: string; generationId?: string } = {}) {
    // a generation the job wrote before it ended badly stays named on it: what it made is in the library all the same
    await this.db
      .updateTable("jobs")
      .set({ status, error: extra.error ?? null, ...(extra.generationId ? { generation_id: extra.generationId } : {}), finished_at: now(), updated_at: now() })
      .where("id", "=", id)
      .execute();
    // a job that waited on this one can never run now
    if (status !== "done") {
      const dependents = await this.db.selectFrom("jobs").select("id").where("depends_on", "=", id).where("status", "=", "queued").execute();
      for (const d of dependents) await this.finish(d.id, "failed", { error: "the clip it continues was not rendered" });
    }
    this.events.emit("queue");
    this.events.emit("timeline");
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
    const run: Running = { id: row.id, abort: new AbortController(), gpu: false };
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
    }
  }

  private async run(comfy: Comfy, row: JobRow): Promise<void> {
    const recipe = this.registry.recipe(row.recipe_id);
    if (!recipe) return this.finish(row.id, "failed", { error: `the recipe ${row.recipe_id} no longer exists` });
    let resume = row.resume ? (JSON.parse(row.resume) as Resume) : null;
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
    this.running = { id: row.id, abort, promptId: resume?.promptId, gpu: true };
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.holds = true;
    this.events.emit("queue");
    try {
      const input = JSON.parse(row.inputs) as Record<string, unknown>;
      if (!resume) {
        resume = await submitting.submit(this.core, comfy, recipe, input, row);
        await this.db.updateTable("jobs").set({ resume: JSON.stringify(resume), updated_at: now() }).where("id", "=", row.id).execute();
      }
      this.running.promptId = resume.promptId;
      this.running.titles = resume.titles;
      if (abort.signal.aborted) {
        await comfy.client.interrupt(resume.promptId).catch(() => {});
        throw new ComfyCancelled();
      }
      comfy.monitor.ensure();
      // after a restart this process has a new client id: the monitor then listens under the one that queued it
      comfy.monitor.track({ promptId: resume.promptId, totalSteps: resume.totalSteps, phases: resume.phases, passes: resume.passes, clientId: resume.clientId, expect: resume.timing?.expect });
      comfy.monitor.onChange = () => this.events.emit("progress");
      let outputs;
      try {
        outputs = await waitForOutputs(comfy.client, resume.promptId, { ...this.opts.wait, signal: abort.signal });
      } finally {
        measured = comfy.monitor.measured(resume.promptId);
        comfy.monitor.untrack(resume.promptId);
      }
      const tookMs = Date.now() - resume.startedAt;
      if (row.warm) {
        // the models are loaded, which is all that was asked
        await this.finish(row.id, "done");
        return;
      }
      // a job found with its generation already named had filed its result before this process last stopped: not twice
      const generationId = row.generation_id ?? (await storing.store(this.core, comfy, recipe, resume.input ?? input, resume, outputs, row));
      made = generationId;
      // its take on the clip, before the job closes (the two arrive on screen together). A clip that cannot take it (removed meanwhile,
      // a fault here) is no reason to call the render failed; a job picked up again after a crash finds its take placed and places none
      if (row.clip_id) await this.clips?.finished(row.clip_id, generationId, resume.overlap, resume.links ?? {}, row.finished_from).catch((err: Error) => console.warn(`[queue] the take of job ${row.id} was not placed on its clip: ${err.message}`));
      await this.finish(row.id, "done", { generationId });
      await this.note(row, recipe, resume, measured, "done", whole, tookMs, generationId);
      this.events.emit("library");
    } catch (err) {
      const message = (err as Error).message;
      if (this.stopped) {
        // shutting down: leave the row as it is, the next start picks it up
      } else if (err instanceof ComfyCancelled || abort.signal.aborted) {
        await this.finish(row.id, "cancelled", { error: "stopped by you" });
        if (resume && !made && !row.warm) await this.note(row, recipe, resume, measured, "cancelled", whole, Date.now() - resume.startedAt);
      } else if ((err instanceof ComfyLost || err instanceof ComfyUnreachable) && attempts < this.opts.maxAttempts) {
        console.warn(`[queue] job ${row.id} lost (${message}), queued again`);
        await this.db.updateTable("jobs").set({ status: "queued", resume: null, updated_at: now() }).where("id", "=", row.id).execute();
        this.events.emit("queue");
      } else {
        await this.finish(row.id, "failed", { error: message.slice(0, 600) });
        // what never reached ComfyUI took no GPU time: only a render that was under way is put on record
        if (resume && !made && !row.warm) await this.note(row, recipe, resume, measured, "failed", whole, Date.now() - resume.startedAt);
      }
    } finally {
      this.running = null;
      void this.armIdle();
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
