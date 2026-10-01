import { EventEmitter } from "node:events";
import { ComfyCancelled, ComfyLost, ComfyUnreachable, waitForOutputs, type OutputFile, type WaitOptions } from "@studai/comfy";
import { checkGraph, choicesOf, parseInput, pickChoice, RANDOM_SEED, relocateFiles, type BuiltGraph, type ClipValue, type MediaFacts, type Phase, type Recipe, type ReferenceValue } from "@studai/core";
import { cutFrames, referenceClip, frameAt } from "./cut";
import type { Registry } from "./registry";
import { readSettings } from "./settings";
import type { Comfy } from "./comfy";
import { newId, now, OWNER, type Db, type Tables } from "./db";
import { extOf, mimeOfFile, pngSize } from "./media";
import type { Storage } from "./storage";
import { makeThumb, maskBox, readPicture, thumbKey } from "./thumbs";
import { estimateMs, rates, type Rate } from "./estimates";
import { EXPORT_JOB, type ExportOptions, type TakeLinks, type Timelines } from "./timelines";
import { readVideo } from "./video";

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
  /** What the last job loaded. A different list frees ComfyUI's memory first; unknown after a restart. */
  private lastLoads: string | null = null;
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

  async enqueue(recipeId: string, rawInput: unknown, opts: { label?: string; dependsOn?: string; clip?: { id: string; fit: boolean } } = {}): Promise<string> {
    const recipe = this.registry.recipe(recipeId);
    if (!recipe) throw new UserError(`there is no recipe called ${recipeId}`);
    const input = parseInput(recipe, rawInput); // throws a ZodError the API turns into a 400
    const id = newId();
    const at = now();
    await this.db
      .insertInto("jobs")
      .values({
        id, owner_id: OWNER, recipe_id: recipe.id, label: opts.label?.trim() || recipe.title, inputs: JSON.stringify(input),
        status: "queued", priority: recipe.output === "image" ? 0 : 10, depends_on: opts.dependsOn ?? null,
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: opts.clip?.id ?? null, clip_fit: opts.clip?.fit ? 1 : 0,
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
        id, owner_id: OWNER, recipe_id: EXPORT_JOB, label, inputs: JSON.stringify(opts), status: "queued", priority: 20, depends_on: null,
        attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, created_at: at, started_at: null, finished_at: null, updated_at: at,
      })
      .execute();
    this.events.emit("queue");
    this.events.emit("timeline");
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
    if (this.running?.gpu) throw new UserError("A render is under way and its model is in use. Wait for it, or stop it first.");
    await (await this.comfy()).client.free();
    this.lastLoads = null;
    this.holds = false;
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  /** After a render: when Setup says so, the models are unloaded once nothing has rendered for that long. */
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
    // a workflow whose settings were changed since no longer has some of what the job was sent with
    const has = new Set(this.registry.recipe(row.recipe_id)?.inputs.map((i) => i.id));
    const was = Object.fromEntries(Object.entries(JSON.parse(row.inputs) as Record<string, unknown>).filter(([k]) => !has.size || has.has(k)));
    return this.enqueue(row.recipe_id, { ...was, ...change }, {
      label: row.label,
      clip: row.clip_id ? { id: row.clip_id, fit: Boolean(row.clip_fit) } : undefined,
    });
  }

  /** Take a finished job off the list. What it made stays in the library. */
  async dismiss(id: string): Promise<boolean> {
    const r = await this.db.deleteFrom("jobs").where("id", "=", id).where("status", "in", ["done", "failed", "cancelled"]).executeTakeFirst();
    this.events.emit("queue");
    this.events.emit("timeline");
    return Number(r.numDeletedRows) > 0;
  }

  private known: { at: number; rates: Record<string, Rate> } | null = null;
  /** How long things usually take, worked out at most twice a minute. */
  private async usual(): Promise<Record<string, Rate>> {
    if (!this.known || Date.now() - this.known.at > 30_000) this.known = { at: Date.now(), rates: await rates(this.db) };
    return this.known.rates;
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
    const brief = (r: JobRow) => {
      const recipe = this.registry.recipe(r.recipe_id);
      return { ...plain(r), estimateMs: r.status === "queued" && recipe ? estimateMs(usual, recipe, JSON.parse(r.inputs) as Record<string, unknown>) : null };
    };
    const plain = (r: JobRow) => ({
      id: r.id, recipe: r.recipe_id, label: r.label, status: r.status, error: r.error, generationId: r.generation_id, clipId: r.clip_id,
      kind: r.recipe_id === EXPORT_JOB ? ("export" as const) : ("render" as const),
      // what a failed job was asked: a retry can change it (a smaller size after running out of memory)
      input: r.status === "failed" && r.recipe_id !== EXPORT_JOB ? (JSON.parse(r.inputs) as Record<string, unknown>) : null,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    });
    const run = rows.find((r) => r.status === "running");
    let running = null;
    if (run) {
      const promptId = this.running?.id === run.id ? this.running.promptId : undefined;
      const monitor = (await this.comfy()).monitor;
      running = {
        ...brief(run),
        ...(promptId ? monitor.progress(promptId) : { progress: 0, eta: 0, phase: run.recipe_id === EXPORT_JOB ? ("exporting" as const) : ("waiting" as const), step: 0, steps: 0 }),
        previewSeq: promptId ? monitor.preview(promptId).seq : 0,
        previewMime: promptId ? monitor.preview(promptId).mime ?? null : null,
      };
    }
    return {
      paused: this.paused,
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
        const next = resumed ?? active.find((r) => r.status === "queued" && !(r.depends_on && waitingOn.has(r.depends_on)) && (!this.paused || r.recipe_id === EXPORT_JOB));
        if (!next) break;
        if (next.recipe_id === EXPORT_JOB) {
          await this.runExport(next);
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
      await this.clips.export(opts.timeline, { scale: opts.scale, music: opts.music, smooth: opts.smooth, signal: abort.signal });
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
      comfy.monitor.track({ promptId: resume.promptId, totalSteps: resume.totalSteps, phases: resume.phases, passes: resume.passes, clientId: resume.clientId });
      comfy.monitor.onChange = () => this.events.emit("progress");
      let outputs;
      try {
        outputs = await waitForOutputs(comfy.client, resume.promptId, { ...this.opts.wait, signal: abort.signal });
      } finally {
        comfy.monitor.untrack(resume.promptId);
      }
      const generationId = await this.store(comfy, recipe, resume.input ?? input, resume, outputs);
      if (row.clip_id) await this.clips?.finished(row.clip_id, generationId, resume.overlap, resume.links ?? {});
      await this.finish(row.id, "done", { generationId });
      this.events.emit("library");
    } catch (err) {
      const message = (err as Error).message;
      if (this.stopped) {
        // shutting down: leave the row as it is, the next start picks it up
      } else if (err instanceof ComfyCancelled || abort.signal.aborted) {
        await this.finish(row.id, "cancelled", { error: "stopped by you" });
      } else if ((err instanceof ComfyLost || err instanceof ComfyUnreachable) && attempts < this.opts.maxAttempts) {
        console.warn(`[queue] job ${row.id} lost (${message}), queued again`);
        await this.db.updateTable("jobs").set({ status: "queued", resume: null, updated_at: now() }).where("id", "=", row.id).execute();
        this.events.emit("queue");
      } else {
        await this.finish(row.id, "failed", { error: message.slice(0, 600) });
      }
    } finally {
      this.running = null;
      void this.armIdle();
    }
  }

  /** Check the graph against this ComfyUI, free its memory if another model is coming, and queue the prompt. */
  private async submit(comfy: Comfy, recipe: Recipe<any>, raw: Record<string, unknown>, row: JobRow): Promise<Resume> {
    const catalog = await comfy.catalog();
    // a timeline clip: what it joins onto is settled now, when the clips around it have their takes
    const plan = row.clip_id && this.clips ? await this.clips.plan(row.clip_id, recipe, raw, Boolean(row.clip_fit)) : null;
    const input = plan ? (parseInput(recipe, plan.input) as Record<string, unknown>) : raw;
    // a file choice left on its default, when this ComfyUI does not have that file: the best one it has
    const chosen: Record<string, unknown> = { ...input };
    for (const spec of recipe.inputs) {
      if (spec.type !== "choice" || Array.isArray(spec.options)) continue;
      const def = catalog[spec.options.node];
      const offered = choicesOf(def?.input.required?.[spec.options.input] ?? def?.input.optional?.[spec.options.input]) ?? [];
      const all = [...(spec.extra ?? []), ...offered];
      if (all.length && !all.includes(String(chosen[spec.id])) && chosen[spec.id] === spec.default) chosen[spec.id] = pickChoice(spec, all);
    }
    const missing = recipe.nodes(input).filter((n: string) => !(n in catalog));
    if (missing.length) throw new Error(`ComfyUI is missing nodes this needs: ${missing.join(", ")}`);

    const slots: Record<string, string> = {};
    const scanned = (await comfy.scan()).families.find((f) => f.id === recipe.family);
    for (const s of scanned?.slots ?? []) {
      if (s.file) slots[s.id] = s.file;
      else if (!s.optional) throw new Error(`a file ${this.registry.family(recipe.family)?.name ?? recipe.family} needs was not found. ${s.hint}`);
    }

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
          if (painted && !painted.box) throw new Error("The mask is empty. Paint over the part to redo.");
          if (painted?.box) media[spec.id] = { width: painted.width, height: painted.height, box: painted.box };
        }
      } else if (spec.type === "clip" && value) {
        // of the clip it joins onto, the recipe gets a few frames with their sound, cut at the chosen moment
        const { asset: assetId, at } = value as ClipValue;
        const asset = await this.db.selectFrom("assets").selectAll().where("id", "=", assetId).executeTakeFirst();
        if (!asset || asset.kind !== "video") throw new Error(`the clip this one ${spec.role === "previous" ? "carries on from" : "arrives at"} is no longer in your library`);
        const bytes = await this.storage.get(asset.file_key);
        const facts = asset.duration_ms && asset.width && asset.height
          ? { durationMs: asset.duration_ms, width: asset.width, height: asset.height, hasSound: Boolean(asset.has_sound) }
          : (await readVideo(bytes, extOf(asset.mime))).facts;
        if (!facts) throw new Error("Joining clips needs ffmpeg, which was not found on the machine studai runs on. Install ffmpeg, or set FFMPEG and FFPROBE.");
        const cut = await cutFrames(bytes, extOf(asset.mime), facts, { counts: spec.frames, fps: spec.fps, side: spec.role === "previous" ? "before" : "after", at });
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
          if (!asset || asset.kind !== "image") throw new Error("a reference picture is no longer in your library");
          const bytes = await this.storage.get(asset.file_key);
          uploads[`${spec.id}.${i}`] = await comfy.client.upload(bytes, extOf(asset.mime));
          media[`${spec.id}.${i}`] = { width: asset.width ?? 0, height: asset.height ?? 0 };
        }
      } else if (spec.type === "audio" && typeof value === "string") {
        // a sound, or a video whose sound is used: ComfyUI's loader reads the sound track of either
        const asset = await this.db.selectFrom("assets").select(["file_key", "mime", "kind", "has_sound"]).where("id", "=", value).executeTakeFirst();
        if (!asset || (asset.kind !== "audio" && !(asset.kind === "video" && asset.has_sound))) throw new Error(`the ${spec.label.toLowerCase()} is no longer in your library`);
        uploads[spec.id] = await comfy.client.upload(await this.storage.get(asset.file_key), extOf(asset.mime));
      }
    }

    for (const spec of recipe.inputs) {
      // a part painted on one picture cannot be put on another one
      if (spec.type !== "image" || spec.role !== "mask" || !spec.of) continue;
      const mask = media[spec.id];
      const picture = media[spec.of];
      if (mask && picture?.width && (mask.width !== picture.width || mask.height !== picture.height)) throw new Error("The mask was painted on another picture. Paint it again on this one.");
    }

    const seed = typeof input.seed === "number" && input.seed !== RANDOM_SEED ? input.seed : randomSeed();
    const built = recipe.build(chosen, { seed, slots, uploads, media, canvas: plan?.canvas, has: (cls) => cls in catalog });
    // a model kept in another sub-folder than the one the graph names is used from where it is
    relocateFiles(built.graph, catalog);
    const problems = checkGraph(built, catalog, { files: true, uploaded: Object.values(uploads) });
    if (problems.length) {
      const fix = recipe.id.startsWith("workflow.") ? " To fix it: Workflows, then Change on this workflow." : "";
      throw new Error(`this cannot run on your ComfyUI: ${problems.slice(0, 3).join("; ")}.${fix}`);
    }

    const loads = [...built.loads].sort().join("|");
    if (this.lastLoads !== loads) await comfy.client.free().catch(() => {});
    this.lastLoads = loads;

    comfy.monitor.ensure();
    await comfy.monitor.ready();
    const promptId = await comfy.client.submit(built.graph, { preview: "latent2rgb" });
    return {
      promptId, seed, outputs: built.outputs, totalSteps: built.totalSteps, phases: built.phases, passes: built.passes,
      clientId: comfy.client.clientId, loads: built.loads, startedAt: Date.now(),
      ...(plan ? { input, links: plan.links, sources: plan.sources } : {}),
      ...(built.overlap ? { overlap: built.overlap } : {}),
    };
  }

  /** Download the results, file them in the library, and record how they were made. */
  private async store(
    comfy: Comfy, recipe: Recipe<any>, input: Record<string, unknown>, resume: Resume,
    outputs: Awaited<ReturnType<typeof waitForOutputs>>,
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
    if (!files.length) throw new Error("ComfyUI finished but returned no result");

    const generationId = newId();
    const at = now();
    await this.db
      .insertInto("generations")
      .values({
        id: generationId, owner_id: OWNER, recipe_id: recipe.id, recipe_version: recipe.version, family: recipe.family,
        inputs: JSON.stringify(input), resolved: JSON.stringify({ seed: resume.seed, loads: resume.loads, ...(resume.overlap ? { overlap: resume.overlap } : {}) }),
        gen_ms: Date.now() - resume.startedAt, created_at: at,
      })
      .execute();
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
          folder_id: null, generation_id: generationId, kept_at: null, deleted_at: null, created_at: at,
        })
        .execute();
    }
    return generationId;
  }
}
