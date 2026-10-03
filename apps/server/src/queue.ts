import { EventEmitter } from "node:events";
import { ComfyCancelled, ComfyLost, ComfyUnreachable, waitForOutputs, type Measured, type OutputFile, type WaitOptions } from "@afflatus/comfy";
import { baseModels, mainModel, modelName, modelOf, timeKey, type Known, checkGraph, choicesOf, expandWildcards, modelFileName, parseInput, pickChoice, RANDOM_SEED, relocateFiles, warmGraph, WARM_SINK, type BuiltGraph, type ClipValue, type InputSpec, type MediaFacts, type Phase, type Recipe, type ReferenceValue } from "@afflatus/core";
import { cutFrames, referenceClip, frameAt, slowSoundOnto, soundPart } from "./cut";
import type { Registry } from "./registry";
import { readSettings } from "./settings";
import type { Comfy } from "./comfy";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { extOf, mimeOfFile, pngSize } from "./media";
import type { Storage } from "./storage";
import { makeThumb, maskBox, readPicture, thumbKey } from "./thumbs";
import { estimateMs, rates, type Rate } from "./estimates";
import { guessFor, known, usualParts } from "./renders";
import { GraphBuilder } from "@afflatus/core";
import { CUT_JOB, EXPORT_JOB, type CutOptions, type ExportOptions, type TakeLinks, type Timelines } from "./timelines";
import { readVideo } from "./video";


/** The RIFE model this ComfyUI offers for frame interpolation, when it has one. */
export function rifeModelIn(catalog: Record<string, unknown>): string | null {
  const node = catalog["FrameInterpolationModelLoader"] as { input?: { required?: Record<string, unknown[]> } } | undefined;
  const spec = node?.input?.required?.model_name;
  // older nodes list the choices in the type position; newer ones say "COMBO" and list them under options
  const second = spec?.[1] as { options?: unknown[] } | undefined;
  const options = Array.isArray(spec?.[0]) ? spec![0] : spec?.[0] === "COMBO" && Array.isArray(second?.options) ? second!.options : null;
  if (!Array.isArray(options)) return null;
  const files = options.filter((o): o is string => typeof o === "string");
  return files.find((f) => /rife/i.test(f)) ?? files[0] ?? null;
}
/**
 * The queue. One ComfyUI, so one job at a time, in order. Jobs live in the database: a restart loses
 * nothing. Queued jobs stay queued, and a job ComfyUI already has is waited on again by its prompt id.
 */

type JobRow = Tables["jobs"];

/** What is stored once ComfyUI accepted the graph: enough to wait for it again after a restart. */
interface Resume {
  promptId: string;
  seed: number;
  outputs: BuiltGraph["outputs"];
  totalSteps: number;
  phases: Record<string, Phase>;
  passes?: BuiltGraph["passes"];
  /** The client id ComfyUI knows this prompt by: its progress is only sent to that client. */
  clientId?: string;
  loads: string[];
  startedAt: number;
  /** The inputs as they were sent, when some were filled in at the last moment (a timeline clip's neighbours). */
  input?: Record<string, unknown>;
  overlap?: BuiltGraph["overlap"];
  /** A timeline clip: the takes it was joined onto, and what else it was made from. */
  links?: TakeLinks;
  sources?: Array<{ asset: string; role: string }>;
  /** For the record of render times: what it is filed under, whether its model had to load, and what was expected of it. */
  timing?: { model: string; modelFile: string; timeKey: string; cold: boolean; expectedMs: number | null; expect: { laterMs?: number; finishMs?: number } };
}

/** A form's values with something in every text that must be written: to load its models, what the text says does not matter. */
function withTexts(recipe: Recipe<any>, raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const input = { ...(raw as Record<string, unknown>) };
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type === "prompt" && !spec.optional && !String(input[spec.id] ?? "").trim()) input[spec.id] = "a";
  }
  return input;
}

/** A file choice left on its default, when this ComfyUI does not have that file: the best one it has. */
function settled(recipe: Recipe<any>, input: Record<string, unknown>, catalog: Awaited<ReturnType<Comfy["catalog"]>>): Record<string, unknown> {
  const chosen: Record<string, unknown> = { ...input };
  for (const spec of recipe.inputs as InputSpec[]) {
    if (spec.type !== "choice" || Array.isArray(spec.options)) continue;
    const def = catalog[spec.options.node];
    const offered = choicesOf(def?.input.required?.[spec.options.input] ?? def?.input.optional?.[spec.options.input]) ?? [];
    const all = [...(spec.extra ?? []), ...offered];
    if (all.length && !all.includes(String(chosen[spec.id])) && chosen[spec.id] === spec.default) chosen[spec.id] = pickChoice(spec, all);
  }
  return chosen;
}

export interface QueueOptions {
  /** How long to wait before looking for ComfyUI again while it is away. */
  offlineRetryMs: number;
  /** Queued jobs are given up after ComfyUI has been away this long (not by their own age). */
  offlineExpiryMs: number;
  maxAttempts: number;
  wait: Pick<WaitOptions, "timeoutMs" | "pollMs" | "offlineMs" | "queueCheckEvery">;
}
export const DEFAULT_QUEUE_OPTIONS: QueueOptions = {
  offlineRetryMs: 15_000,
  offlineExpiryMs: 2 * 60 * 60_000,
  maxAttempts: 3,
  // a cold model load plus a slow render; ComfyUI itself has no limit
  wait: { timeoutMs: 90 * 60_000 },
};

export class UserError extends Error {
  statusCode = 400;
}

const PAUSED_KEY = "queue.paused";
/** The name of the model among them that a person knows it by, to say which one is loaded. */
const MODEL_KEY = "queue.model";
/** The base models the last job had ComfyUI load, kept across restarts of this app (ComfyUI keeps running through them). */
const LOADS_KEY = "queue.loads";
const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

export class Queue {
  /** "queue": jobs changed. "library": an asset was added. "progress": the running job moved. */
  readonly events = new EventEmitter();
  private busy = false;
  private paused = false;
  private running: { id: string; abort: AbortController; promptId?: string; gpu: boolean } | null = null;
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

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly comfy: () => Promise<Comfy>,
    private readonly registry: Registry,
    private readonly opts: QueueOptions = DEFAULT_QUEUE_OPTIONS,
  ) {}

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

  async enqueue(recipeId: string, rawInput: unknown, opts: { label?: string; dependsOn?: string; clip?: { id: string; fit: boolean }; draft?: string | null; folder?: string | null; warm?: boolean; look?: unknown } = {}): Promise<string> {
    const recipe = this.registry.recipe(recipeId);
    if (!recipe) throw new UserError(`there is no model or operation called ${recipeId}`);
    // loading the models is asked for while the form is still being filled in: a text not written yet is no reason to refuse
    const input = parseInput(recipe, opts.warm ? withTexts(recipe, rawInput) : rawInput) as Record<string, unknown>; // throws a ZodError the API turns into a 400
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
        draft_id: opts.draft ?? null, folder_id: opts.folder ?? null,
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
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, draft_id: null, folder_id: null, created_at: at, started_at: null, finished_at: null, updated_at: at,
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
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: CUT_JOB, label, inputs: JSON.stringify(opts), status: "queued", warm: 0, look: null, priority: 20, depends_on: extra.dependsOn ?? null,
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, draft_id: null, folder_id: null, created_at: at, started_at: null, finished_at: null, updated_at: at,
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
    for (const [i, id] of order.entries()) await this.db.updateTable("jobs").set({ priority: -100_000 + i, updated_at: now() }).where("id", "=", id).where("status", "=", "queued").execute();
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

  private known: { at: number; rates: Record<string, Rate>; record: Record<string, Known> } | null = null;
  /** How long things usually take, worked out at most twice a minute. */
  private async usual() {
    if (!this.known || Date.now() - this.known.at > 30_000) this.known = { at: Date.now(), rates: await rates(this.db), record: await known(this.db) };
    return this.known;
  }

  /**
   * About how long a render will take: from the record of renders like it (and then with what loading
   * its model adds, when it is not the one loaded), else from the totals of before there was a record.
   */
  private expected(usual: { rates: Record<string, Rate>; record: Record<string, Known> }, recipe: Recipe<any>, input: Record<string, unknown>, cold: boolean): number | null {
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

  // ---------------------------------------------------------------- what the queue screen shows

  async status() {
    const rows = await this.db
      .selectFrom("jobs")
      .selectAll()
      .where("status", "in", ["queued", "running"])
      .orderBy("priority")
      .orderBy("created_at")
      .execute();
    const recent = await this.db
      .selectFrom("jobs")
      .selectAll()
      .where("status", "in", ["done", "failed", "cancelled"])
      .orderBy("finished_at", "desc")
      .limit(20)
      .execute();
    const usual = await this.usual();
    // down the line, a job whose model is not the one before it has to load it first
    let held = this.lastLoads === null ? null : new Set(this.lastLoads.split("|").map(modelName));
    const brief = (r: JobRow) => {
      const recipe = this.registry.recipe(r.recipe_id);
      if (r.status !== "queued" || !recipe || r.warm) return { ...plain(r), estimateMs: null };
      const input = JSON.parse(r.inputs) as Record<string, unknown>;
      const model = modelOf(recipe.inputs, input);
      const cold = Boolean(model && held && !held.has(model));
      if (model) held = new Set([model]);
      return { ...plain(r), estimateMs: this.expected(usual, recipe, input, cold) };
    };
    const plain = (r: JobRow) => ({
      id: r.id, recipe: r.recipe_id, label: r.label, status: r.status, error: r.error, generationId: r.generation_id, clipId: r.clip_id, draftId: r.draft_id,
      kind: r.recipe_id === EXPORT_JOB ? ("export" as const) : r.recipe_id === CUT_JOB ? ("cut" as const) : r.warm ? ("load" as const) : ("render" as const),
      // what a failed job was asked: a retry can change it (a smaller size after running out of memory)
      input: r.status === "failed" && r.recipe_id !== EXPORT_JOB && r.recipe_id !== CUT_JOB ? (JSON.parse(r.inputs) as Record<string, unknown>) : null,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    });
    const run = rows.find((r) => r.status === "running");
    let running = null;
    if (run) {
      const promptId = this.running?.id === run.id ? this.running.promptId : undefined;
      const monitor = (await this.comfy()).monitor;
      running = {
        ...brief(run),
        ...(promptId ? monitor.progress(promptId) : { progress: 0, eta: 0, phase: run.recipe_id === EXPORT_JOB ? ("exporting" as const) : run.recipe_id === CUT_JOB ? ("cutting" as const) : ("waiting" as const), step: 0, steps: 0 }),
        previewSeq: promptId ? monitor.preview(promptId).seq : 0,
        previewMime: promptId ? monitor.preview(promptId).mime ?? null : null,
      };
    }
    return {
      paused: this.paused,
      /** The model ComfyUI was last asked to load, by name. Null when none is, or when it is not known. */
      model: this.lastLoads === null ? null : this.lastModel,
      online: this.offlineSince === null,
      offlineForMs: this.offlineSince ? Date.now() - this.offlineSince : 0,
      running,
      waiting: rows.filter((r) => r.status === "queued").map(brief),
      recent: recent.map(brief),
    };
  }

  /** The running job's latest live preview. */
  async preview(jobId: string) {
    if (this.running?.id !== jobId || !this.running.promptId) return null;
    const p = (await this.comfy()).monitor.preview(this.running.promptId);
    return p.bytes ? { bytes: p.bytes, mime: p.mime ?? "image/jpeg" } : null;
  }

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
          await this.runExport(next);
          continue;
        }
        if (next.recipe_id === CUT_JOB) {
          await this.runCut(next);
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
    await this.db
      .updateTable("jobs")
      .set({ status, error: extra.error ?? null, generation_id: extra.generationId ?? null, finished_at: now(), updated_at: now() })
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

  /** A cut: ffmpeg on the computer Afflatus runs on, like an export. */
  private async runCut(row: JobRow): Promise<void> {
    const claimed = await this.db
      .updateTable("jobs")
      .set({ status: "running", attempts: row.attempts + 1, started_at: now(), updated_at: now() })
      .where("id", "=", row.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return;
    const abort = new AbortController();
    this.running = { id: row.id, abort, gpu: false };
    this.events.emit("queue");
    try {
      const opts = JSON.parse(row.inputs) as CutOptions;
      if (!this.clips) throw new Error("timelines are not available");
      const video = await this.db.selectFrom("assets").selectAll().where("id", "=", opts.asset).executeTakeFirst();
      if (!video || video.kind !== "video") throw new Error("that video is no longer in your library");
      if (opts.action === "slow") {
        const factor = opts.factor ?? 2;
        let made;
        if (opts.engine === "rife") {
          // RIFE on the GPU: the range goes up to ComfyUI, a small graph interpolates it, the video comes back
          const comfy = await this.comfy();
          const catalog = await comfy.catalog();
          const rife = rifeModelIn(catalog);
          const missing = ["LoadVideo", "GetVideoComponents", "FrameInterpolationModelLoader", "FrameInterpolate", "VHS_VideoCombine"].filter((n) => !(n in catalog));
          if (missing.length || !rife) throw new Error(`ComfyUI has no RIFE frame interpolation to run this on${missing.length ? ` (missing nodes: ${missing.join(", ")})` : " (no model in models/frame_interpolation)"}`);
          this.running.gpu = true;
          const part = await this.clips.rangeSlice(video, opts.startMs, opts.endMs);
          const file = await comfy.client.upload(part.bytes, "mp4");
          const g = new GraphBuilder();
          const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
          const images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: rife }), images: [parts, 0], multiplier: factor });
          const outNode = g.add("VHS_VideoCombine", { images, frame_rate: part.fps, loop_count: 0, filename_prefix: "Afflatus/slow", format: "video/h264-mp4", pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: 16, save_metadata: false, trim_to_audio: false });
          const promptId = await comfy.client.submit(g.graph);
          this.running.promptId = promptId;
          const output = await this.awaitPrompt(comfy, promptId, outNode, abort.signal);
          const silent = await comfy.client.view(output);
          // RIFE hands the picture back without sound: the range's own sound goes on it, slowed to match
          const bytes = await slowSoundOnto(silent, part.bytes, factor);
          made = await this.clips.keepCut(video, bytes, this.clips.slowName(video, opts.startMs, opts.endMs, factor), opts.startMs, opts.endMs);
        } else made = await this.clips.slowRange(video, opts.startMs, opts.endMs, factor, { crf: opts.crf, signal: abort.signal });
        if (opts.clip) {
          await this.clips.takeFrom(opts.clip, made);
          this.events.emit("timeline");
        }
      } else await this.clips.cutRange(video, opts.startMs, opts.endMs, opts.action, { crf: opts.crf, signal: abort.signal });
      await this.finish(row.id, "done");
    } catch (err) {
      if (this.stopped) await this.db.updateTable("jobs").set({ status: "queued", updated_at: now() }).where("id", "=", row.id).execute();
      else if (abort.signal.aborted) await this.finish(row.id, "cancelled", { error: "stopped by you" });
      else await this.finish(row.id, "failed", { error: (err as Error).message.slice(0, 600) });
    } finally {
      this.running = null;
    }
  }

  /** Wait for a prompt queued outside the usual render path (a slow-motion job), and hand back the video it made. */
  private async awaitPrompt(comfy: Comfy, promptId: string, node: string, signal: AbortSignal): Promise<OutputFile> {
    const started = Date.now();
    for (;;) {
      if (signal.aborted) {
        await comfy.client.interrupt(promptId).catch(() => {});
        throw new Error("stopped by you");
      }
      const h = await comfy.client.history(promptId).catch(() => undefined);
      if (h?.status?.completed) {
        const file = h.outputs?.[node]?.gifs?.[0] ?? Object.values(h.outputs ?? {}).flatMap((o) => o.gifs ?? [])[0];
        if (!file) throw new Error("ComfyUI finished without a video");
        return file;
      }
      if (h?.status?.status_str === "error") {
        const said = h.status.messages?.find((m) => m[0] === "execution_error")?.[1] as { exception_message?: string } | undefined;
        throw new Error(said?.exception_message ? `ComfyUI: ${String(said.exception_message).slice(0, 300)}` : "ComfyUI could not run the frame interpolation");
      }
      if (Date.now() - started > 2 * 60 * 60_000) throw new Error("the frame interpolation did not finish in two hours");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async runExport(row: JobRow): Promise<void> {
    const claimed = await this.db
      .updateTable("jobs")
      .set({ status: "running", attempts: row.attempts + 1, started_at: now(), updated_at: now() })
      .where("id", "=", row.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) === 0) return;
    const abort = new AbortController();
    this.running = { id: row.id, abort, gpu: false };
    this.events.emit("queue");
    try {
      const opts = JSON.parse(row.inputs) as ExportOptions;
      if (!this.clips) throw new Error("timelines are not available");
      await this.clips.export(opts.timeline, { scale: opts.scale, music: opts.music, smooth: opts.smooth, range: opts.range, blend: opts.blend, match: opts.match, signal: abort.signal });
      await this.finish(row.id, "done");
    } catch (err) {
      if (this.stopped) {
        // shutting down: it starts over on the next start
        await this.db.updateTable("jobs").set({ status: "queued", updated_at: now() }).where("id", "=", row.id).execute();
      } else if (abort.signal.aborted) await this.finish(row.id, "cancelled", { error: "stopped by you" });
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
        resume = await this.submit(comfy, recipe, input, row);
        await this.db.updateTable("jobs").set({ resume: JSON.stringify(resume), updated_at: now() }).where("id", "=", row.id).execute();
      }
      this.running.promptId = resume.promptId;
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
      const generationId = await this.store(comfy, recipe, resume.input ?? input, resume, outputs, row);
      made = generationId;
      if (row.clip_id) await this.clips?.finished(row.clip_id, generationId, resume.overlap, resume.links ?? {});
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

  /** Put a render on the record of render times. Never in the way of the render itself: a failure here is only said. */
  private async note(row: JobRow, recipe: Recipe<any>, resume: Resume, measured: Measured | null, status: "done" | "failed" | "cancelled", whole: boolean, totalMs: number, generationId?: string): Promise<void> {
    try {
      const made = generationId ? await this.db.selectFrom("assets").select(["id", "kind", "width", "height", "duration_ms"]).where("generation_id", "=", generationId).orderBy("created_at").executeTakeFirst() : undefined;
      const spent = measured?.phases ?? {};
      const of = (...phases: string[]) => Math.round(phases.reduce((n, p) => n + (spent[p] ?? 0), 0));
      const load = of("waiting", "loading");
      const sample = of("sampling");
      const refine = of("upscaling", "refining", "detailing");
      // what is left is the finishing: decoding, smoothing, saving (and anything a workflow of its own does that has no name here)
      const finish = measured ? Math.max(0, Math.round(totalMs) - load - sample - refine) : 0;
      await this.db
        .insertInto("render_stats")
        .values({
          id: row.id, owner_id: OWNER, recipe_id: recipe.id, family: recipe.family,
          model: resume.timing?.model ?? "", model_file: resume.timing?.modelFile ?? "", time_key: resume.timing?.timeKey ?? "",
          kind: made?.kind ?? null, width: made?.width ?? null, height: made?.height ?? null, duration_ms: made?.duration_ms ?? null,
          steps: resume.totalSteps, status, whole: whole && measured ? 1 : 0, cold: resume.timing?.cold ? 1 : 0,
          waited_ms: Math.max(0, resume.startedAt - new Date(row.created_at).getTime()),
          total_ms: Math.round(totalMs), load_ms: load, sample_ms: sample, refine_ms: refine, finish_ms: finish,
          step_ms: measured?.stepMs ?? null, expected_ms: resume.timing?.expectedMs ?? null,
          vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made?.id ?? null, created_at: now(),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      this.known = null;
    } catch (err) {
      console.warn(`[queue] the time of job ${row.id} was not put on record: ${(err as Error).message}`);
    }
  }

  /** Check the graph against this ComfyUI, free its memory if another model is coming, and queue the prompt. */
  private async submit(comfy: Comfy, recipe: Recipe<any>, raw: Record<string, unknown>, row: JobRow): Promise<Resume> {
    const catalog = await comfy.catalog();
    // a timeline clip: what it joins onto is settled now, when the clips around it have their takes
    const plan = row.clip_id && this.clips ? await this.clips.plan(row.clip_id, recipe, raw, Boolean(row.clip_fit)) : null;
    const input = plan ? (parseInput(recipe, plan.input) as Record<string, unknown>) : raw;
    const chosen = settled(recipe, input, catalog);
    const missing = recipe.nodes(input).filter((n: string) => !(n in catalog));
    if (missing.length) throw new Error(`ComfyUI is missing custom nodes this needs: ${missing.join(", ")}`);
    const slots = await this.slots(comfy, recipe);

    // pictures, videos and sounds the recipe takes are uploaded to ComfyUI's temp folder under fresh names
    const uploads: Record<string, string> = {};
    const media: Record<string, MediaFacts> = {};
    for (const spec of recipe.inputs) {
      const value = input[spec.id];
      if (spec.type === "image") {
        if (typeof value !== "string") continue;
        const asset = await this.db.selectFrom("assets").select(["file_key", "mime", "width", "height"]).where("id", "=", value).executeTakeFirst();
        if (!asset) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
        const bytes = await this.storage.get(asset.file_key);
        uploads[spec.id] = await comfy.client.upload(bytes, extOf(asset.mime));
        const size = asset.width && asset.height ? { width: asset.width, height: asset.height } : await readPicture(bytes);
        media[spec.id] = { width: size?.width ?? 0, height: size?.height ?? 0 };
        if (spec.role === "mask") {
          // only the part that was painted is redone: where it is comes from the mask itself
          const painted = await maskBox(bytes);
          if (painted && !painted.box) throw new Error("The mask is empty. Paint over the part to inpaint.");
          if (painted?.box) media[spec.id] = { width: painted.width, height: painted.height, box: painted.box };
        }
      } else if (spec.type === "clip" && value) {
        // of the clip it joins onto, the recipe gets a few frames with their sound, cut at the chosen moment
        const { asset: assetId, at } = value as ClipValue;
        const asset = await this.db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
        if (!asset || asset.kind !== "video") throw new Error(`the ${spec.role === "previous" ? "previous" : "next"} clip is no longer in your library`);
        const bytes = await this.storage.get(asset.file_key);
        const facts = asset.duration_ms && asset.width && asset.height
          ? { durationMs: asset.duration_ms, width: asset.width, height: asset.height, hasSound: Boolean(asset.has_sound) }
          : (await readVideo(bytes, extOf(asset.mime))).facts;
        if (!facts) throw new Error("Joining clips needs ffmpeg, which was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE.");
        // the form may say how many frames the join takes first; shorter counts stay as fallbacks for a short clip
        const wanted = spec.framesFrom ? Number(input[spec.framesFrom]) : NaN;
        const counts = Number.isFinite(wanted) && wanted > 0 ? [wanted, ...spec.frames.filter((c) => c < wanted)] : spec.frames;
        const cut = await cutFrames(bytes, extOf(asset.mime), facts, { counts, fps: spec.fps, side: spec.role === "previous" ? "before" : "after", at });
        uploads[spec.id] = await comfy.client.upload(cut.bytes, "mp4");
        media[spec.id] = { width: facts.width, height: facts.height, frames: cut.frames, fps: spec.fps, hasSound: facts.hasSound };
      } else if (spec.type === "references" && Array.isArray(value)) {
        // each reference picture goes up under "<input>.<n>", in the order they were given
        for (const [i, ref] of (value as ReferenceValue[]).entries()) {
          const asset = await this.db.selectFrom("assets").select(["file_key", "mime", "width", "height", "kind"]).where("id", "=", ref.asset).executeTakeFirst();
          if (spec.media === "video") {
            // a reference video: its first three seconds, small, with its sound when it has one
            if (!asset || asset.kind !== "video") throw new Error("a reference video is no longer in your library");
            const clip = await referenceClip(await this.storage.get(asset.file_key), extOf(asset.mime), { seconds: 3, fps: 24, short: 384 });
            uploads[`${spec.id}.${i}`] = await comfy.client.upload(clip.bytes, "mp4");
            media[`${spec.id}.${i}`] = { width: clip.width, height: clip.height, frames: clip.frames, fps: 24, hasSound: clip.hasSound };
            continue;
          }
          if (!asset || asset.kind !== "image") throw new Error("a reference image is no longer in your library");
          const bytes = await this.storage.get(asset.file_key);
          uploads[`${spec.id}.${i}`] = await comfy.client.upload(bytes, extOf(asset.mime));
          media[`${spec.id}.${i}`] = { width: asset.width ?? 0, height: asset.height ?? 0 };
        }
      } else if (spec.type === "audio" && typeof value === "string") {
        // a sound, or a video whose sound is used: ComfyUI's loader reads the sound track of either
        const asset = await this.db.selectFrom("assets").select(["file_key", "mime", "kind", "has_sound", "duration_ms"]).where("id", "=", value).executeTakeFirst();
        if (!asset || (asset.kind !== "audio" && !(asset.kind === "video" && asset.has_sound))) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
        const whole = await this.storage.get(asset.file_key);
        if (spec.window) {
          // only the chosen part of it is handed over: a few clean seconds carry a voice better than a long take
          // (a sound ffmpeg cannot cut, or no ffmpeg at all: the whole of it is used, as before there was a part to set)
          const part = await soundPart(whole, extOf(asset.mime), { start: Number(input[spec.window.start] ?? 0), seconds: Number(input[spec.window.seconds] ?? 8), durationMs: asset.duration_ms }).catch((err) => {
            console.warn(`[queue] the part of the ${spec.label.toLowerCase()} could not be cut, the whole sound is used: ${(err as Error).message}`);
            return null;
          });
          uploads[spec.id] = part ? await comfy.client.upload(part, "wav") : await comfy.client.upload(whole, extOf(asset.mime));
        } else uploads[spec.id] = await comfy.client.upload(whole, extOf(asset.mime));
      }
    }

    for (const spec of recipe.inputs) {
      // a part painted on one picture cannot be put on another one
      if (spec.type !== "image" || spec.role !== "mask" || !spec.of) continue;
      const mask = media[spec.id];
      const picture = media[spec.of];
      if (mask && picture?.width && (mask.width !== picture.width || mask.height !== picture.height)) throw new Error("The mask was painted on another image. Paint it again on this one.");
    }

    const seed = typeof input.seed === "number" && input.seed !== RANDOM_SEED ? input.seed : randomSeed();
    const built = recipe.build(chosen, { seed, slots, uploads, media, canvas: plan?.canvas, has: (cls) => cls in catalog });
    // a model kept in another sub-folder than the one the graph names is used from where it is
    relocateFiles(built.graph, catalog);
    const problems = checkGraph(built, catalog, { files: true, uploaded: Object.values(uploads) });
    if (problems.length) {
      const fix = recipe.id.startsWith("workflow.") ? " To fix it: Workflows, then Edit on this workflow." : "";
      throw new Error(`this cannot run on your ComfyUI: ${problems.slice(0, 3).join("; ")}.${fix}`);
    }

    // Another base model is coming: ComfyUI's memory is cleared for it. A graph with no base model of
    // its own (an upscale, a background removal) changes nothing: what is loaded stays, and stays noted.
    const base = baseModels(built);
    const cold = base.length > 0 && !this.holding(base);
    if (base.length) {
      if (cold) await comfy.client.free().catch(() => {});
      await this.loaded(base.join("|"), mainModel(built));
    }
    const timing: Resume["timing"] = {
      model: mainModel(built) ?? "", modelFile: modelOf(recipe.inputs, chosen) ?? (mainModel(built) ?? "").split(" + ")[0]!.toLowerCase(),
      timeKey: timeKey(recipe.inputs, chosen), cold, expectedMs: this.expected(await this.usual(), recipe, chosen, cold),
      expect: await usualParts(this.db, recipe, chosen).catch(() => ({})),
    };

    comfy.monitor.ensure();
    await comfy.monitor.ready();
    if (row.warm) {
      const warm = warmGraph(built);
      if (!warm) throw new Error("this loads no model: there is nothing to preload");
      if (!(WARM_SINK in catalog)) throw new Error(`ComfyUI is missing the ${WARM_SINK} node, which preloading a model needs. Update ComfyUI.`);
      const promptId = await comfy.client.submit(warm.graph, { preview: "latent2rgb" });
      return { promptId, seed, outputs: [], totalSteps: 1, phases: warm.phases, passes: warm.pass ? [warm.pass] : [], clientId: comfy.client.clientId, loads: built.loads, startedAt: Date.now() };
    }
    const promptId = await comfy.client.submit(built.graph, { preview: "latent2rgb" });
    return {
      promptId, seed, outputs: built.outputs, totalSteps: built.totalSteps, phases: built.phases, passes: built.passes,
      clientId: comfy.client.clientId, loads: built.loads, startedAt: Date.now(), timing,
      ...(plan ? { input, links: plan.links, sources: plan.sources } : {}),
      ...(built.overlap ? { overlap: built.overlap } : {}),
    };
  }

  /** The files a family's recipes need, as this ComfyUI has them. */
  private async slots(comfy: Comfy, recipe: Recipe<any>): Promise<Record<string, string>> {
    const slots: Record<string, string> = {};
    const scanned = (await comfy.scan()).families.find((f) => f.id === recipe.family);
    for (const s of scanned?.slots ?? []) {
      if (s.file) slots[s.id] = s.file;
      else if (!s.optional) throw new Error(`a model file ${this.registry.family(recipe.family)?.name ?? recipe.family} needs was not found. ${s.hint}`);
    }
    return slots;
  }

  /** Every one of these base models is among the ones the last job loaded. */
  private holding(base: string[]): boolean {
    if (this.lastLoads === null) return false;
    const held = new Set(this.lastLoads.split("|").map(modelFileName));
    return base.every((f) => held.has(f));
  }

  /**
   * The finished jobs, newest first, with what each made: for the queue's history. `q` looks in the
   * label and the inputs (the prompt is there), `model` in the inputs too (the model file's name).
   * Counts say how many of each status there are in all, so that a filter can show its number.
   */
  async history(opts: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; offset?: number; limit?: number } = {}) {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
    const offset = Math.max(0, opts.offset ?? 0);
    // a job that only loaded a model made nothing: not part of the history
    let query = this.db.selectFrom("jobs").selectAll().where("status", "in", ["done", "failed", "cancelled"]).where("warm", "=", 0);
    if (opts.status) query = query.where("status", "=", opts.status);
    if (opts.q?.trim()) {
      const like = `%${opts.q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) => eb.or([eb("label", "like", like), eb("inputs", "like", like)]));
    }
    if (opts.model?.trim()) query = query.where("inputs", "like", `%${opts.model.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`);
    const rows = await query.orderBy("finished_at", "desc").orderBy("created_at", "desc").limit(limit + 1).offset(offset).execute();
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    // what each made, and how it was settled
    const genIds = page.map((r) => r.generation_id).filter((g): g is string => Boolean(g));
    const gens = genIds.length ? await this.db.selectFrom("generations").select(["id", "resolved"]).where("id", "in", genIds).execute() : [];
    const made = genIds.length
      ? await this.db.selectFrom("assets").select(["id", "generation_id", "kind", "width", "height", "duration_ms", "kept_at", "deleted_at", "name"]).where("generation_id", "in", genIds).where("origin", "!=", "mask").orderBy("created_at").execute()
      : [];
    const counts = Object.fromEntries((await this.db.selectFrom("jobs").select(["status", (eb) => eb.fn.countAll<number>().as("n")]).where("status", "in", ["done", "failed", "cancelled"]).where("warm", "=", 0).groupBy("status").execute()).map((c) => [c.status, Number(c.n)])) as Partial<Record<"done" | "failed" | "cancelled", number>>;
    const items = page.map((r) => {
      const recipe = this.registry.recipe(r.recipe_id);
      const input = r.recipe_id === EXPORT_JOB || r.recipe_id === CUT_JOB ? {} : (JSON.parse(r.inputs) as Record<string, unknown>);
      const promptSpec = recipe?.inputs.find((i) => i.type === "prompt" && !i.optional) ?? recipe?.inputs.find((i) => i.type === "prompt" && i.id !== "negative");
      const prompt = promptSpec && typeof input[promptSpec.id] === "string" ? (input[promptSpec.id] as string).trim().slice(0, 240) : "";
      const resolved = r.generation_id ? (JSON.parse(gens.find((g) => g.id === r.generation_id)?.resolved ?? "{}") as { seed?: number }) : {};
      const tookMs = r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null;
      return {
        id: r.id, recipe: r.recipe_id, label: r.label, status: r.status, error: r.error, generationId: r.generation_id, clipId: r.clip_id, draftId: r.draft_id,
        kind: r.recipe_id === EXPORT_JOB ? ("export" as const) : r.recipe_id === CUT_JOB ? ("cut" as const) : r.warm ? ("load" as const) : ("render" as const),
        input: r.status === "failed" && r.recipe_id !== EXPORT_JOB && r.recipe_id !== CUT_JOB ? input : null,
        createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, tookMs,
        model: recipe ? modelOf(recipe.inputs, input) : null,
        prompt,
        seed: typeof resolved.seed === "number" ? resolved.seed : null,
        // jobs asked for together ("Make 4"): the same form, the same second
        batch: `${r.draft_id ?? ""}|${r.recipe_id}|${r.label}|${r.created_at.slice(0, 19)}`,
        made: made.filter((a) => a.generation_id === r.generation_id).map((a) => ({ id: a.id, kind: a.kind, width: a.width, height: a.height, durationMs: a.duration_ms, kept: a.kept_at !== null, inBin: a.deleted_at !== null, name: a.name })),
      };
    });
    return { items, more, counts: { done: counts.done ?? 0, failed: counts.failed ?? 0, cancelled: counts.cancelled ?? 0 } };
  }

  /**
   * The graph a form (or a past render: its inputs and its seed) gives, built without uploading anything:
   * the files a render would send are stood in for by `names` (the file's own name, to be read in the
   * graph), else by a placeholder. Null when the form is not complete enough to build.
   */
  async builtOf(recipeId: string, rawInput: unknown, opts: { seed?: number; names?: Record<string, string> } = {}): Promise<BuiltGraph | null> {
    const recipe = this.registry.recipe(recipeId);
    if (!recipe) return null;
    const input = parseInput(recipe, withTexts(recipe, rawInput)) as Record<string, unknown>;
    const comfy = await this.comfy();
    const catalog = await comfy.catalog();
    const uploads: Record<string, string> = {};
    const media: Record<string, MediaFacts> = {};
    const standIn = (key: string, asset: string) => {
      uploads[key] = opts.names?.[asset] ?? "stand-in";
      media[key] = { width: 1024, height: 1024 };
    };
    for (const spec of recipe.inputs as InputSpec[]) {
      const value = input[spec.id];
      if ((spec.type === "image" || spec.type === "audio" || spec.type === "clip") && typeof value === "string") standIn(spec.id, value);
      else if (spec.type === "references" && Array.isArray(value)) value.forEach((v, i) => standIn(`${spec.id}.${i}`, typeof v === "string" ? v : String((v as { asset?: string })?.asset ?? "")));
    }
    const built = recipe.build(settled(recipe, input, catalog), { seed: opts.seed ?? 1, slots: await this.slots(comfy, recipe), uploads, media, has: (cls: string) => cls in catalog });
    relocateFiles(built.graph, catalog);
    return built;
  }

  /**
   * Whether the base models a form would use are the ones ComfyUI was last asked to load. Null when it
   * cannot be told (the form is not complete enough to build its graph, ComfyUI is away). It is what
   * this app last asked for: a ComfyUI that was restarted since, or used from elsewhere, is not seen.
   */
  async isLoaded(recipeId: string, rawInput: unknown): Promise<boolean | null> {
    try {
      const built = await this.builtOf(recipeId, rawInput);
      if (!built) return null;
      const base = baseModels(built);
      return base.length ? this.holding(base) : null;
    } catch {
      return null;
    }
  }

  /** Download the results, file them in the library, and record how they were made. */
  private async store(
    comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
    outputs: Awaited<ReturnType<typeof waitForOutputs>>,
    row: Pick<JobRow, "draft_id" | "folder_id" | "look">,
  ): Promise<string> {
    const files: Array<{ file: OutputFile; kind: "image" | "video" | "audio" }> = [];
    for (const out of resume.outputs) {
      if (out.role !== "result") continue;
      const o = outputs[out.node];
      const returned = [...(o?.images ?? []), ...(o?.gifs ?? []), ...(o?.audio ?? [])];
      // a node can hand back more than its result (a video and a picture of its last frame): what is of the
      // kind that was asked for is the result. When nothing is (an animated picture standing for a video),
      // everything it returned is taken as that kind.
      const ofKind = returned.filter((file) => mimeOfFile(file.filename).startsWith(`${out.kind}/`));
      for (const file of ofKind.length ? ofKind : returned) files.push({ file, kind: out.kind });
    }
    if (!files.length) throw new Error("ComfyUI finished but returned no output");

    const generationId = newId();
    const at = now();
    await this.db
      .insertInto("generations")
      .values({
        id: generationId, owner_id: OWNER, recipe_id: recipe.id, recipe_version: recipe.version, family: recipe.family,
        inputs: JSON.stringify(input),
        // with the cast it was sent with: what is made from it later (a video of this picture) can take it over
        resolved: JSON.stringify({ seed: resume.seed, loads: resume.loads, ...(resume.overlap ? { overlap: resume.overlap } : {}), ...(row.look ? { look: JSON.parse(row.look) } : {}) }),
        gen_ms: Date.now() - resume.startedAt, draft_id: row.draft_id, created_at: at,
      })
      .execute();
    // the folder that was open when it was sent, when it is still there. Being in a folder does not keep a result:
    // it still goes to the bin after a day unless it is kept
    const folder = row.folder_id ? (await this.db.selectFrom("folders").select("id").where("id", "=", row.folder_id).executeTakeFirst())?.id ?? null : null;
    // what it was made from: its pictures, the clips it joins onto, and what a timeline handed it
    const sources = [...(resume.sources ?? [])];
    for (const spec of recipe.inputs) {
      const value = input[spec.id];
      if (spec.type === "image" && typeof value === "string") sources.push({ asset: value, role: spec.role });
      if (spec.type === "clip" && value) sources.push({ asset: (value as ClipValue).asset, role: spec.role });
      if (spec.type === "references" && Array.isArray(value)) for (const ref of value as ReferenceValue[]) sources.push({ asset: ref.asset, role: ref.role });
      if (spec.type === "audio" && typeof value === "string") sources.push({ asset: value, role: spec.role });
    }
    for (const s of sources) {
      await this.db
        .insertInto("generation_inputs")
        .values({ generation_id: generationId, asset_id: s.asset, role: s.role })
        .onConflict((oc) => oc.columns(["generation_id", "asset_id", "role"]).doNothing())
        .execute();
    }
    for (const { file, kind } of files) {
      const bytes = await comfy.client.view(file);
      const mime = mimeOfFile(file.filename);
      const id = newId();
      const key = `assets/${id.slice(0, 2)}/${id}.${extOf(mime)}`;
      await this.storage.put(key, bytes);
      // a video is read for its size, its length and a frame to show (when ffmpeg is installed)
      const video = kind === "video" ? await readVideo(bytes, extOf(mime)) : null;
      const size = kind === "image" ? pngSize(bytes) : video?.facts ?? null;
      // a clip that opens on the end of another one is shown by its own first frame, not by the other's
      const own = video?.frame && resume.overlap?.headMs ? await frameAt(bytes, extOf(mime), resume.overlap.headMs).catch(() => null) : null;
      // a small version for the library grid; without one the grid falls back to the picture itself
      const thumb = kind === "image" ? await makeThumb(bytes) : video?.frame ? await makeThumb(own ?? video.frame) : null;
      if (thumb) await this.storage.put(thumbKey(id), thumb);
      await this.db
        .insertInto("assets")
        .values({
          id, owner_id: OWNER, kind, origin: "generated", name: "", file_key: key, thumb_key: thumb ? thumbKey(id) : null, mime, bytes: bytes.length,
          width: size?.width ?? null, height: size?.height ?? null,
          duration_ms: video?.facts?.durationMs ?? null, fps: video?.facts?.fps ?? null, has_sound: video?.facts?.hasSound ? 1 : 0,
          folder_id: folder, generation_id: generationId, kept_at: null, deleted_at: null, created_at: at,
        })
        .execute();
    }
    return generationId;
  }
}
