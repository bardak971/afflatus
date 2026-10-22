import type { Kysely } from "kysely";
import type { Measured } from "@afflatus/comfy";
import { modelOf, timeKey, TOOLS_FAMILY, type Recipe } from "@afflatus/core";
import { freezeOld, keepSplitsUntil } from "./costs";
import { now, OWNER, type Db, type Tables } from "./db";
import { RELOAD_MS, reloadAbove } from "./forecast";
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

/** A render's milliseconds per node class as kept (render_stats.node_ms): null when none were heard. */
const nodeMs = (measured: Measured | null): string | null => (measured?.nodes && Object.keys(measured.nodes).length ? JSON.stringify(measured.nodes) : null);
/** Bytes as GB to a tenth, as render_stats keeps the RAM; null when not read. */
const gbOf = (bytes: number | null | undefined): number | null => (bytes ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null);

/**
 * One row for a render that ran on ComfyUI, finished or not: where its time went (loading, sampling, the
 * passes after, the finishing), what it made, and what was expected of it. Written once: a job found
 * again after a crash does not count twice. The queue calls this from its `note`, which never lets a
 * failure here reach the render.
 */
export async function record(
  db: Db, row: Pick<JobRow, "id" | "created_at">, recipe: Recipe<any>, resume: Pick<Resume, "timing" | "totalSteps" | "startedAt">, measured: Measured | null,
  status: "done" | "failed" | "cancelled", whole: boolean, totalMs: number, generationId?: string,
  /** The machine it ran on, and its GPU's name: each machine's speed is learned from its own rows. `energy`: what its GPU drew (power.ts). */
  where: { machine: string | null; gpu: string | null; energy?: { wh: number; avgW: number } | null } = { machine: null, gpu: null },
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
  const cold = Boolean(resume.timing?.cold) || (await reloaded(db, resume.timing?.modelFile ?? "", where.machine, load));
  const at = now();
  await db
    .insertInto("render_stats")
    .values({
      id: row.id, owner_id: OWNER, recipe_id: recipe.id, family: recipe.family,
      model: resume.timing?.model ?? "", model_file: resume.timing?.modelFile ?? "", time_key: resume.timing?.timeKey ?? "",
      kind: made?.kind ?? null, width: made?.width ?? null, height: made?.height ?? null, duration_ms: made?.duration_ms ?? null,
      steps: resume.totalSteps, status, whole: whole && measured ? 1 : 0, cold: cold ? 1 : 0,
      waited_ms: Math.max(0, resume.startedAt - new Date(row.created_at).getTime()),
      total_ms: Math.round(totalMs), load_ms: load, sample_ms: sample, refine_ms: refine, finish_ms: finish,
      step_ms: measured?.stepMs ?? null, expected_ms: resume.timing?.expectedMs ?? null, work: resume.timing?.work ?? null,
      vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made?.id ?? null, machine_id: where.machine, gpu: where.gpu, node_ms: nodeMs(measured), created_at: at,
      energy_wh: where.energy ? Math.round(where.energy.wh * 1000) / 1000 : null, power_avg_w: where.energy ? Math.round(where.energy.avgW * 10) / 10 : null,
      ram_peak: gbOf(measured?.ramPeak), ram_total: gbOf(measured?.ramTotal),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  await digestDays(db, Date.now(), dayOf(at));
}

/**
 * Whether a render sent with its model in memory loaded it all the same: whether it must load is what this app last asked
 * ComfyUI for, not what ComfyUI holds, and ComfyUI lets a model go to make room for another. Filed warm, one such load
 * (two minutes, of a model rendered twice) made its next renders read 140 s for 20. It did when its load is past what the
 * model's loads in memory on this machine say (forecast.ts reloadAbove); with none on record, it is not told.
 */
export async function reloaded(db: Db, modelFile: string, machine: string | null, loadMs: number): Promise<boolean> {
  if (!modelFile || loadMs <= RELOAD_MS) return false;
  let q = db.selectFrom("render_stats").select("load_ms").where("model_file", "=", modelFile).where("status", "=", "done").where("whole", "=", 1).where("cold", "=", 0);
  q = machine ? q.where("machine_id", "=", machine) : q.where("machine_id", "is", null);
  const loads = (await q.orderBy("created_at", "desc").limit(30).execute()).map((r) => r.load_ms);
  return loads.length > 0 && loadMs > reloadAbove(loads);
}

/**
 * One row for a tool that ran on ComfyUI (a finish, a slow motion): like a render's, so that it has its lane, its share of
 * the GPU time by phase and its pace. `work` is what it made, pixels × frames; `expectedMs` what its own record said.
 * One row per job: an attempt that did not end done is replaced by the job's next one (a slow motion lost in a restart of
 * its ComfyUI, run again and done, was said failed, its render's time on the pod's bill read as idle). A done one stays.
 */
export async function recordTool(
  db: Db, row: { id: string; created_at: string; startedAt: number }, what: { recipe: string; model: string; timeKey: string },
  measured: Measured | null, status: "done" | "failed" | "cancelled", totalMs: number, made: { assetId: string | null; width: number | null; height: number | null; durationMs: number | null },
  work: number | null, expectedMs: number | null, machine: string | null = null, energy: { wh: number; avgW: number } | null = null,
): Promise<void> {
  const spent = measured?.phases ?? {};
  const of = (...phases: string[]) => Math.round(phases.reduce((n, p) => n + (spent[p] ?? 0), 0));
  const load = of("waiting", "loading");
  const refine = of("upscaling", "refining", "restoring", "detailing", "processing");
  const finish = measured ? Math.max(0, Math.round(totalMs) - load - refine) : 0;
  const at = now();
  const values = {
    owner_id: OWNER, recipe_id: what.recipe, family: TOOLS_FAMILY, model: what.model, model_file: "", time_key: what.timeKey,
    kind: "video" as const, width: made.width, height: made.height, duration_ms: made.durationMs, steps: 0, status, whole: measured ? 1 : 0, cold: 0,
    waited_ms: Math.max(0, row.startedAt - new Date(row.created_at).getTime()),
    total_ms: Math.round(totalMs), load_ms: load, sample_ms: 0, refine_ms: refine, finish_ms: finish, step_ms: null, expected_ms: expectedMs, work,
    vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made.assetId, machine_id: machine, node_ms: nodeMs(measured), created_at: at,
    energy_wh: energy ? Math.round(energy.wh * 1000) / 1000 : null, power_avg_w: energy ? Math.round(energy.avgW * 10) / 10 : null,
    ram_peak: gbOf(measured?.ramPeak), ram_total: gbOf(measured?.ramTotal),
  };
  await db
    .insertInto("render_stats")
    .values({ id: row.id, ...values })
    .onConflict((oc) => oc.column("id").doUpdateSet(values).where("render_stats.status", "!=", "done"))
    .execute();
  await digestDays(db, Date.now(), dayOf(at));
}

/** A tool's usual paces from its own record (toolPaces): each machine's, and every machine's together. */
export interface ToolPaces {
  on: ReadonlyMap<string | null, number>;
  all: number | null;
}

/**
 * A tool's usual pace from its own record: milliseconds per unit of work (pixels × frames), the middle of its last finished
 * runs, on each machine and on all of them. A run that spilled out of video memory is not the usual pace: one twice as
 * slow as the middle of its own machine's runs is left out. Measured against what was expected of it, a pod's every finish
 * was dropped, expected as they were at this computer's pace.
 */
export async function toolPaces(db: Db, recipe: string): Promise<ToolPaces> {
  const rows = await db.selectFrom("render_stats").select(["total_ms", "work", "machine_id"]).where("recipe_id", "=", recipe).where("status", "=", "done").where("whole", "=", 1).orderBy("created_at", "desc").limit(60).execute();
  const byMachine = new Map<string | null, number[]>();
  for (const r of rows) if (r.work) byMachine.set(r.machine_id, [...(byMachine.get(r.machine_id) ?? []), r.total_ms / r.work]);
  const kept = new Map([...byMachine].map(([m, paces]) => {
    const usual = median(paces) ?? 0;
    return [m, paces.filter((p) => p < 2 * usual)] as const;
  }));
  const on = new Map([...kept].flatMap(([m, paces]) => {
    const usual = median(paces);
    return usual === null ? [] : [[m, usual] as const];
  }));
  return { on, all: median([...kept.values()].flat()) };
}

/** Of a tool's paces, the one on `machine`: its own runs as soon as it has one, else every machine's at its `pace` (1 the common pace, 2 half as fast). */
export function paceOn(paces: ToolPaces, machine: string | null = null, pace = 1): number | null {
  const own = machine === null ? undefined : paces.on.get(machine);
  if (own !== undefined) return own;
  return paces.all === null ? null : paces.all * (machine === null ? 1 : pace);
}

/** A tool's usual pace on `machine` (toolPaces, paceOn); left out, every machine's together. */
export async function toolPace(db: Db, recipe: string, machine: string | null = null, pace = 1): Promise<number | null> {
  return paceOn(await toolPaces(db, recipe), machine, pace);
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
    // the rented sessions' splits kept before their renders become figures (costs.ts freezeSplits): those ended a day ago
    // whole, and those the cutoff has passed the start of up to it (keepSplitsUntil), a pod still running or ended since
    await freezeOld(tx, when);
    const before = `${dayOf(new Date(when - keepDays * DAY).toISOString())}T00:00:00.000Z`;
    if (keepDays > 0) await keepSplitsUntil(tx, Date.parse(before), when);
    const folded = keepDays > 0 ? await foldBefore(tx, before) : 0;
    await digestDays(tx, when);
    return folded;
  });
}

async function foldBefore(db: Kysely<Tables>, before: string): Promise<number> {
  // a folded day is read from its figures in render_days from now on, not from its digest
  await db.deleteFrom("render_digests").where("day", "<", dayOf(before)).execute();
  await db.deleteFrom("render_machine_digests").where("day", "<", dayOf(before)).execute();
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
export async function clear(db: Db, now = Date.now()): Promise<void> {
  await db.transaction().execute(async (tx) => {
    // every rented session's split kept first: forgotten, its renders would read as idle (costs.ts freezeSplits). Those
    // ended a day ago are kept whole; a pod still running, or ended since, has its split kept up to now (keepSplitsUntil),
    // finished by the fold a day after its end: a render cut by its end has its row written a moment after, and kept whole
    // at once, the split read that render as idle for good
    await freezeOld(tx, now);
    await keepSplitsUntil(tx, now, now);
    await tx.deleteFrom("render_stats").execute();
    await tx.deleteFrom("render_days").execute();
    await tx.deleteFrom("render_digests").execute();
    await tx.deleteFrom("render_machine_digests").execute();
  });
}
