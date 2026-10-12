import type { Kysely } from "kysely";
import type { Measured } from "@afflatus/comfy";
import { modelOf, timeKey, TOOLS_FAMILY, type Recipe } from "@afflatus/core";
import { now, OWNER, type Db, type Tables } from "./db";
import type { JobRow, Resume } from "./queueModel";
import { cellOf, DAY, dayOf, digestDays, median, merge, WHOLE_DAY, type Cell, type RenderRow } from "./renderDigests";

/**
 * The record of render times: what every render took and where its time went.
 *
 *  - `record` writes one row when a render that ran on ComfyUI ends, finished or not;
 *  - `fold` turns the rows older than the days they are kept into one line of figures per model and
 *    day, which stay for good: the charts go on reaching back, the list of renders does not;
 *  - `summary` and `list` are what the "Render times" tab shows (rendersRead.ts); a summary by days reads each past day
 *    from its digest (renderDigests.ts `digestDays`, written once the day is over), so that only today's rows are worked
 *    out again on every call;
 *  - `usualParts` is what a running render is expected to do after its first pass. The next render's time is
 *    forecast from the same rows (forecast.ts).
 */

// ---------------------------------------------------------------- one render on the record

/**
 * One row for a render that ran on ComfyUI, finished or not: where its time went (loading, sampling, the
 * passes after, the finishing), what it made, and what was expected of it. Written once: a job found
 * again after a crash does not count twice. The queue calls this from its `note`, which never lets a
 * failure here reach the render.
 */
export async function record(
  db: Db, row: Pick<JobRow, "id" | "created_at">, recipe: Recipe<any>, resume: Pick<Resume, "timing" | "totalSteps" | "startedAt">, measured: Measured | null,
  status: "done" | "failed" | "cancelled", whole: boolean, totalMs: number, generationId?: string,
  /** The machine it ran on, and its GPU's name: each machine's speed is learned from its own rows. */
  where: { machine: string | null; gpu: string | null } = { machine: null, gpu: null },
): Promise<void> {
  const made = generationId ? await db.selectFrom("assets").select(["id", "kind", "width", "height", "duration_ms"]).where("generation_id", "=", generationId).orderBy("created_at").executeTakeFirst() : undefined;
  const spent = measured?.phases ?? {};
  const of = (...phases: string[]) => Math.round(phases.reduce((n, p) => n + (spent[p] ?? 0), 0));
  const load = of("waiting", "loading");
  const sample = of("sampling");
  // every pass after the main sampling: a refine or hires pass, an upscale (pixel, latent, SeedVR2), a detailer, a tool's processing
  const refine = of("upscaling", "refining", "restoring", "detailing", "processing");
  // what is left is the finishing: decoding, smoothing, saving (and anything a workflow of its own does that has no name here)
  const finish = measured ? Math.max(0, Math.round(totalMs) - load - sample - refine) : 0;
  const at = now();
  await db
    .insertInto("render_stats")
    .values({
      id: row.id, owner_id: OWNER, recipe_id: recipe.id, family: recipe.family,
      model: resume.timing?.model ?? "", model_file: resume.timing?.modelFile ?? "", time_key: resume.timing?.timeKey ?? "",
      kind: made?.kind ?? null, width: made?.width ?? null, height: made?.height ?? null, duration_ms: made?.duration_ms ?? null,
      steps: resume.totalSteps, status, whole: whole && measured ? 1 : 0, cold: resume.timing?.cold ? 1 : 0,
      waited_ms: Math.max(0, resume.startedAt - new Date(row.created_at).getTime()),
      total_ms: Math.round(totalMs), load_ms: load, sample_ms: sample, refine_ms: refine, finish_ms: finish,
      step_ms: measured?.stepMs ?? null, expected_ms: resume.timing?.expectedMs ?? null, work: resume.timing?.work ?? null,
      vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made?.id ?? null, machine_id: where.machine, gpu: where.gpu, created_at: at,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await digestDays(db, Date.now(), dayOf(at));
}

/**
 * One row for a tool that ran on ComfyUI (a finish, a slow motion): like a render's, so that it has its lane, its share of
 * the GPU time by phase and its pace. `work` is what it made, pixels × frames; `expectedMs` what its own record said.
 */
export async function recordTool(
  db: Db, row: { id: string; created_at: string; startedAt: number }, what: { recipe: string; model: string; timeKey: string },
  measured: Measured | null, status: "done" | "failed" | "cancelled", totalMs: number, made: { assetId: string | null; width: number | null; height: number | null; durationMs: number | null },
  work: number | null, expectedMs: number | null, machine: string | null = null,
): Promise<void> {
  const spent = measured?.phases ?? {};
  const of = (...phases: string[]) => Math.round(phases.reduce((n, p) => n + (spent[p] ?? 0), 0));
  const load = of("waiting", "loading");
  const refine = of("upscaling", "refining", "restoring", "detailing", "processing");
  const finish = measured ? Math.max(0, Math.round(totalMs) - load - refine) : 0;
  const at = now();
  await db
    .insertInto("render_stats")
    .values({
      id: row.id, owner_id: OWNER, recipe_id: what.recipe, family: TOOLS_FAMILY, model: what.model, model_file: "", time_key: what.timeKey,
      kind: "video", width: made.width, height: made.height, duration_ms: made.durationMs, steps: 0, status, whole: measured ? 1 : 0, cold: 0,
      waited_ms: Math.max(0, row.startedAt - new Date(row.created_at).getTime()),
      total_ms: Math.round(totalMs), load_ms: load, sample_ms: 0, refine_ms: refine, finish_ms: finish, step_ms: null, expected_ms: expectedMs, work,
      vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made.assetId, machine_id: machine, created_at: at,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await digestDays(db, Date.now(), dayOf(at));
}

/** A tool's usual pace from its own record: milliseconds per unit of work (pixels × frames), the middle of its last finished runs. */
export async function toolPace(db: Db, recipe: string): Promise<number | null> {
  const rows = await db.selectFrom("render_stats").select(["total_ms", "work", "vram_peak", "expected_ms"]).where("recipe_id", "=", recipe).where("status", "=", "done").where("whole", "=", 1).orderBy("created_at", "desc").limit(30).execute();
  // a run that spilled out of video memory is not the usual pace
  return median(rows.filter((r) => r.work && !(r.expected_ms && r.total_ms >= 2 * r.expected_ms)).map((r) => r.total_ms / r.work!));
}

// ---------------------------------------------------------------- folding the old rows into days

/**
 * Rows older than `keepDays` become figures per model and day. Only whole days are folded: a day is
 * either all rows or all figures. 0 keeps every row for good. Returns how many rows were folded. In one
 * transaction: a stop half way, or a second fold at the same moment, never counts a row twice. The days
 * over that are still rows are digested on the way (see `digestDays`): the fold runs at start and every
 * hour, so a day is digested soon after it ends even when nothing renders.
 */
export async function fold(db: Db, keepDays: number, when = Date.now()): Promise<number> {
  return db.transaction().execute(async (tx) => {
    const folded = keepDays > 0 ? await foldBefore(tx, `${dayOf(new Date(when - keepDays * DAY).toISOString())}T00:00:00.000Z`) : 0;
    await digestDays(tx, when);
    return folded;
  });
}

async function foldBefore(db: Kysely<Tables>, before: string): Promise<number> {
  // a folded day is read from its figures in render_days from now on, not from its digest
  await db.deleteFrom("render_digests").where("day", "<", dayOf(before)).execute();
  const old = await db.selectFrom("render_stats").selectAll().where("created_at", "<", before).execute();
  if (!old.length) return 0;
  const days = new Map<string, RenderRow[]>();
  for (const r of old) days.set(dayOf(r.created_at), [...(days.get(dayOf(r.created_at)) ?? []), r]);
  for (const [day, rows] of days) {
    const groups = new Map<string, RenderRow[]>();
    for (const r of rows) groups.set(`${r.recipe_id}\n${r.model_file}`, [...(groups.get(`${r.recipe_id}\n${r.model_file}`) ?? []), r]);
    const lines = [...groups.values()].map((g) => ({ day, recipe_id: g[0]!.recipe_id, model_file: g[0]!.model_file, model: g[0]!.model, family: g[0]!.family, cell: cellOf(g) }));
    lines.push({ day, recipe_id: WHOLE_DAY, model_file: "", model: "", family: "", cell: cellOf(rows) });
    for (const { cell, ...line } of lines) {
      // a day folded twice (rows that arrived late): the two halves are put together
      const had = await db.selectFrom("render_days").select("figures").where("day", "=", day).where("recipe_id", "=", line.recipe_id).where("model_file", "=", line.model_file).executeTakeFirst();
      const figures = JSON.stringify(had ? merge([JSON.parse(had.figures) as Cell, cell]) : cell);
      await db.insertInto("render_days").values({ ...line, figures }).onConflict((oc) => oc.columns(["day", "recipe_id", "model_file"]).doUpdateSet({ figures })).execute();
    }
  }
  await db.deleteFrom("render_stats").where("created_at", "<", before).execute();
  return old.length;
}

// ---------------------------------------------------------------- what the running render is expected to do next

/** What usually follows the first sampling pass in renders like this one: the passes after it, and the finishing. For the time left while it renders. */
export async function usualParts(db: Db, recipe: Recipe<any>, input: Record<string, unknown>): Promise<{ laterMs?: number; finishMs?: number }> {
  const rows = await db.selectFrom("render_stats").select(["time_key", "model_file", "refine_ms", "finish_ms"]).where("recipe_id", "=", recipe.id).where("status", "=", "done").where("whole", "=", 1).orderBy("created_at", "desc").limit(80).execute();
  if (!rows.length) return {};
  const key = timeKey(recipe.inputs, input);
  const model = modelOf(recipe.inputs, input);
  const same = rows.filter((r) => r.time_key === key && (!model || r.model_file === model));
  const ofModel = model ? rows.filter((r) => r.model_file === model) : [];
  const from = same.length ? same : ofModel.length ? ofModel : rows;
  return { laterMs: Math.round(median(from.map((r) => r.refine_ms)) ?? 0), finishMs: Math.round(median(from.map((r) => r.finish_ms)) ?? 0) };
}

/** Forget everything that was measured. */
export async function clear(db: Db): Promise<void> {
  await db.deleteFrom("render_stats").execute();
  await db.deleteFrom("render_days").execute();
  await db.deleteFrom("render_digests").execute();
}
