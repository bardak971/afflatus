import { sql } from "kysely";
import { modelName, modelOf, type JoinKind, joinKindOf } from "@afflatus/core";
import { CUT_JOB, EXPORT_JOB } from "./timelines";
import type { JobRow, QueueCore, Resume } from "./queueModel";

/** What the queue screen shows: the line as it stands with the running job's progress, the history of finished jobs, and a live preview. */

async function spillingNow(core: QueueCore): Promise<boolean> {
  const r = core.running;
  if (!r?.gpu || !r.expectedMs || !r.startedAt || Date.now() - r.startedAt < 2 * r.expectedMs) return false;
  const load = await (await core.comfy()).load().catch(() => null);
  return Boolean(load?.gpus.some((g) => g.vramPercent >= 95));
}

export async function status(core: QueueCore) {
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
    .where("status", "in", ["done", "failed", "cancelled"])
    .orderBy("finished_at", "desc")
    .limit(20)
    .execute();
  const usual = await core.usual();
  // down the line, a job whose model is not the one before it has to load it first
  let held = core.lastLoads === null ? null : new Set(core.lastLoads.split("|").map(modelName));
  const brief = (r: JobRow) => {
    const recipe = core.registry.recipe(r.recipe_id);
    if (r.status !== "queued" || !recipe || r.warm) return { ...plain(r), estimateMs: null };
    const input = JSON.parse(r.inputs) as Record<string, unknown>;
    const model = modelOf(recipe.inputs, input);
    const cold = Boolean(model && held && !held.has(model));
    if (model) held = new Set([model]);
    return { ...plain(r), estimateMs: core.expected(usual, recipe, input, cold) };
  };
  /** How a clip render joins the clip before, once its graph is built: in the latent, or on pinned frames; null when it starts on its own or is not a clip. */
  const joinOf = (r: JobRow): JoinKind | null => {
    if (!r.clip_id || !r.resume) return null;
    return joinKindOf((JSON.parse(r.resume) as Resume).overlap);
  };
  const plain = (r: JobRow) => ({
    id: r.id, recipe: r.recipe_id, label: r.label, status: r.status, error: r.error, generationId: r.generation_id, clipId: r.clip_id, draftId: r.draft_id, join: joinOf(r),
    kind: r.recipe_id === EXPORT_JOB ? ("export" as const) : r.recipe_id === CUT_JOB ? ("cut" as const) : r.warm ? ("load" as const) : ("render" as const),
    // what a failed job was asked: a retry can change it (a smaller size after running out of memory)
    input: r.status === "failed" && r.recipe_id !== EXPORT_JOB && r.recipe_id !== CUT_JOB ? (JSON.parse(r.inputs) as Record<string, unknown>) : null,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
  });
  const run = rows.find((r) => r.status === "running");
  let running = null;
  if (run) {
    const promptId = core.running?.id === run.id ? core.running.promptId : undefined;
    const monitor = (await core.comfy()).monitor;
    running = {
      ...brief(run),
      // a tool on ComfyUI (a finish, a slow motion): which step runs, not a step count (its one-step passes would read 99 % at once)
      ...(promptId && run.recipe_id === CUT_JOB ? { ...monitor.progress(promptId), progress: 0, eta: 0, step: 0, steps: 0 } : promptId ? monitor.progress(promptId) : { progress: 0, eta: 0, phase: run.recipe_id === EXPORT_JOB ? ("exporting" as const) : run.recipe_id === CUT_JOB ? ("cutting" as const) : ("waiting" as const), step: 0, steps: 0 }),
      previewSeq: promptId ? monitor.preview(promptId).seq : 0,
      previewMime: promptId ? monitor.preview(promptId).mime ?? null : null,
      // what the workflow showed on the way (its Preview nodes), oldest first; the title comes from the graph it was built with
      stages: (promptId ? monitor.stages(promptId) : []).map((st, n) => ({ n, node: st.node, title: core.running?.titles?.[st.node] ?? null, count: st.files.length })),
      // spilling out of video memory: the memory full and twice what was expected already gone (see renders.spilled)
      spilling: await spillingNow(core),
    };
  }
  return {
    paused: core.paused,
    /** The model ComfyUI was last asked to load, by name. Null when none is, or when it is not known. */
    model: core.lastLoads === null ? null : core.lastModel,
    online: core.offlineSince === null,
    offlineForMs: core.offlineSince ? Date.now() - core.offlineSince : 0,
    running,
    waiting: rows.filter((r) => r.status === "queued").map(brief),
    recent: recent.map(brief),
  };
}

/** One picture a node of the running job showed on the way (stage `n`, its first file), fetched from ComfyUI. */
export async function stage(core: QueueCore, jobId: string, n: number) {
  if (core.running?.id !== jobId || !core.running.promptId) return null;
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
 * Counts say how many of each status there are in all, so that a filter can show its number.
 */
export async function history(core: QueueCore, opts: { status?: "done" | "failed" | "cancelled"; q?: string; model?: string; offset?: number; limit?: number } = {}) {
  const { db } = core;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 60));
  const offset = Math.max(0, opts.offset ?? 0);
  // a job that only loaded a model made nothing: not part of the history
  let query = db.selectFrom("jobs").selectAll().where("status", "in", ["done", "failed", "cancelled"]).where("warm", "=", 0);
  if (opts.status) query = query.where("status", "=", opts.status);
  // the text looked for, as a LIKE pattern: its own %, _ and \ made literal with a backslash, which the clause then names as
  // the escape character (SQLite has none by default; the clause reads the same on Postgres). Model files are full of underscores.
  const like = (text: string) => `%${text.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (opts.q?.trim()) {
    const pattern = like(opts.q);
    query = query.where(sql<boolean>`(label like ${pattern} escape '\\' or inputs like ${pattern} escape '\\')`);
  }
  if (opts.model?.trim()) query = query.where(sql<boolean>`inputs like ${like(opts.model)} escape '\\'`);
  const rows = await query.orderBy("finished_at", "desc").orderBy("created_at", "desc").limit(limit + 1).offset(offset).execute();
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  // what each made, and how it was settled
  const genIds = page.map((r) => r.generation_id).filter((g): g is string => Boolean(g));
  const gens = genIds.length ? await db.selectFrom("generations").select(["id", "resolved"]).where("id", "in", genIds).execute() : [];
  const made = genIds.length
    ? await db.selectFrom("assets").select(["id", "generation_id", "kind", "width", "height", "duration_ms", "kept_at", "deleted_at", "name"]).where("generation_id", "in", genIds).where("origin", "!=", "mask").orderBy("created_at").execute()
    : [];
  const counts = Object.fromEntries((await db.selectFrom("jobs").select(["status", (eb) => eb.fn.countAll<number>().as("n")]).where("status", "in", ["done", "failed", "cancelled"]).where("warm", "=", 0).groupBy("status").execute()).map((c) => [c.status, Number(c.n)])) as Partial<Record<"done" | "failed" | "cancelled", number>>;
  const items = page.map((r) => {
    const recipe = core.registry.recipe(r.recipe_id);
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
