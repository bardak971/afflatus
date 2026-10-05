import type { Selectable } from "kysely";
import type { Measured } from "@afflatus/comfy";
import { guess, modelOf, timeKey, type Guess, type Known, type Recipe } from "@afflatus/core";
import { now, OWNER, type Db, type Tables } from "./db";
import type { Registry } from "./registry";
import type { JobRow, Resume } from "./queueModel";

/**
 * The record of render times: what every render took and where its time went.
 *
 *  - `record` writes one row when a render that ran on ComfyUI ends, finished or not;
 *  - `fold` turns the rows older than the days they are kept into one line of figures per model and
 *    day, which stay for good: the charts go on reaching back, the list of renders does not;
 *  - `summary` and `list` are what the "Render times" tab shows;
 *  - `known` is what the next render's time is guessed from.
 */

export type RenderRow = Selectable<Tables["render_stats"]>;

const DAY = 86_400_000;
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const at = (values: number[], q: number): number | null => {
  const s = sorted(values);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))]! : null;
};
const median = (values: number[]) => at(values, 0.5);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const real = (values: Array<number | null>): number[] => values.filter((v): v is number => v !== null && Number.isFinite(v));
/** The middle of values that each stand for several renders: what the middle of all of them would about be. */
function weighted(pairs: Array<[number | null, number]>, q = 0.5): number | null {
  const known = pairs.filter((p): p is [number, number] => p[0] !== null && p[1] > 0).sort((a, b) => a[0] - b[0]);
  const total = sum(known.map((p) => p[1]));
  let seen = 0;
  for (const [value, weight] of known) {
    seen += weight;
    if (seen >= total * q) return value;
  }
  return null;
}
const max = (values: Array<number | null>): number | null => (real(values).length ? Math.max(...real(values)) : null);

/** The bounds, in seconds, of the histogram of render times kept in a cell (and said to Prometheus). */
export const BUCKETS = [5, 10, 20, 40, 60, 120, 300, 600, 1200, 2400, 3600];

/** The figures of some renders taken together: one model on one day, a stretch of a chart, a whole period. */
export interface Cell {
  renders: number;
  done: number;
  failed: number;
  cancelled: number;
  /** How many had to load their model first. */
  cold: number;
  images: number;
  videos: number;
  /** Sums, in milliseconds: the GPU time, and its parts. */
  totalMs: number;
  loadMs: number;
  sampleMs: number;
  refineMs: number;
  finishMs: number;
  /** The length of the videos made, and the GPU time of what failed or was stopped. */
  videoMs: number;
  lostMs: number;
  longestMs: number;
  /** The usual render: the middle one of those whose model was already loaded. */
  usualMs: number | null;
  /** Nine in ten were faster. */
  slowMs: number | null;
  /** The middle one of those that loaded their model first. */
  coldMs: number | null;
  stepMs: number | null;
  /** What loading the model took, usually, when it had to load. */
  loadUsualMs: number | null;
  waitedUsualMs: number | null;
  waitedSlowMs: number | null;
  /** How far the estimates were off, usually: 0.1 is ten percent. */
  off: number | null;
  vramPeak: number | null;
  heatPeak: number | null;
  vramUsual: number | null;
  heatUsual: number | null;
  /** How many finished renders took up to each of BUCKETS seconds (cumulative, as Prometheus has it). Missing on cells written before it was kept. */
  hist?: number[];
}

export function cellOf(rows: RenderRow[]): Cell {
  const done = rows.filter((r) => r.status === "done");
  const warm = done.filter((r) => !r.cold);
  const cold = rows.filter((r) => r.cold && r.whole);
  return {
    renders: rows.length, done: done.length, failed: rows.filter((r) => r.status === "failed").length, cancelled: rows.filter((r) => r.status === "cancelled").length,
    cold: rows.filter((r) => r.cold).length, images: done.filter((r) => r.kind === "image").length, videos: done.filter((r) => r.kind === "video").length,
    totalMs: sum(rows.map((r) => r.total_ms)), loadMs: sum(rows.map((r) => r.load_ms)), sampleMs: sum(rows.map((r) => r.sample_ms)),
    refineMs: sum(rows.map((r) => r.refine_ms)), finishMs: sum(rows.map((r) => r.finish_ms)),
    videoMs: sum(done.filter((r) => r.kind === "video").map((r) => r.duration_ms ?? 0)), lostMs: sum(rows.filter((r) => r.status !== "done").map((r) => r.total_ms)),
    longestMs: Math.max(0, ...done.map((r) => r.total_ms)),
    usualMs: median((warm.length ? warm : done).map((r) => r.total_ms)), slowMs: at(done.map((r) => r.total_ms), 0.9),
    coldMs: median(done.filter((r) => r.cold).map((r) => r.total_ms)), stepMs: median(real(done.map((r) => r.step_ms))),
    loadUsualMs: median(cold.map((r) => r.load_ms)),
    waitedUsualMs: median(rows.map((r) => r.waited_ms)), waitedSlowMs: at(rows.map((r) => r.waited_ms), 0.9),
    off: median(done.filter((r) => r.expected_ms && r.total_ms > 0).map((r) => Math.abs(r.total_ms - r.expected_ms!) / r.total_ms)),
    vramPeak: max(rows.map((r) => r.vram_peak)), heatPeak: max(rows.map((r) => r.heat_peak)),
    vramUsual: median(real(rows.map((r) => r.vram_peak))), heatUsual: median(real(rows.map((r) => r.heat_peak))),
    hist: BUCKETS.map((le) => done.filter((r) => r.total_ms / 1000 <= le).length),
  };
}

/** Several cells as one. Sums add up; a "usual" is the middle of the usuals, each counted for the renders behind it. */
export function merge(cells: Cell[]): Cell {
  const add = (pick: (c: Cell) => number) => sum(cells.map(pick));
  const mid = (pick: (c: Cell) => number | null, weight: (c: Cell) => number, q = 0.5) => weighted(cells.map((c) => [pick(c), weight(c)]), q);
  return {
    renders: add((c) => c.renders), done: add((c) => c.done), failed: add((c) => c.failed), cancelled: add((c) => c.cancelled), cold: add((c) => c.cold),
    images: add((c) => c.images), videos: add((c) => c.videos),
    totalMs: add((c) => c.totalMs), loadMs: add((c) => c.loadMs), sampleMs: add((c) => c.sampleMs), refineMs: add((c) => c.refineMs), finishMs: add((c) => c.finishMs),
    videoMs: add((c) => c.videoMs), lostMs: add((c) => c.lostMs), longestMs: Math.max(0, ...cells.map((c) => c.longestMs)),
    usualMs: mid((c) => c.usualMs, (c) => c.done), slowMs: mid((c) => c.slowMs, (c) => c.done, 0.9), coldMs: mid((c) => c.coldMs, (c) => c.cold),
    stepMs: mid((c) => c.stepMs, (c) => c.done), loadUsualMs: mid((c) => c.loadUsualMs, (c) => c.cold),
    waitedUsualMs: mid((c) => c.waitedUsualMs, (c) => c.renders), waitedSlowMs: mid((c) => c.waitedSlowMs, (c) => c.renders, 0.9),
    off: mid((c) => c.off, (c) => c.done),
    vramPeak: max(cells.map((c) => c.vramPeak)), heatPeak: max(cells.map((c) => c.heatPeak)),
    vramUsual: mid((c) => c.vramUsual, (c) => c.renders), heatUsual: mid((c) => c.heatUsual, (c) => c.renders),
    hist: BUCKETS.map((_le, i) => sum(cells.map((c) => c.hist?.[i] ?? 0))),
  };
}

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
      vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made?.id ?? null, created_at: now(),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

// ---------------------------------------------------------------- folding the old rows into days

/** The day as a whole, among the rows of `render_days`. */
const WHOLE_DAY = "*";
const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Rows older than `keepDays` become figures per model and day. Only whole days are folded: a day is
 * either all rows or all figures. 0 keeps every row for good. Returns how many rows were folded.
 */
export async function fold(db: Db, keepDays: number, when = Date.now()): Promise<number> {
  if (keepDays <= 0) return 0;
  const before = `${dayOf(new Date(when - keepDays * DAY).toISOString())}T00:00:00.000Z`;
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

// ---------------------------------------------------------------- what the next render is guessed from

/** How many past renders are looked at: the recent ones say more about the machine as it is now. */
const LOOK_BACK = 600;

/** What a render would have taken with its model already loaded: what loading added, beyond what even a loaded model spends before its first step, taken off. */
const warmMs = (r: RenderRow, usualStart: number) => (r.cold ? r.total_ms - Math.max(0, r.load_ms - usualStart) : r.total_ms);

/** Per recipe, what its past renders say. Only renders that finished and were measured from their first moment. */
export async function known(db: Db): Promise<Record<string, Known>> {
  const rows = await db.selectFrom("render_stats").selectAll().where("status", "=", "done").where("whole", "=", 1).orderBy("created_at", "desc").limit(LOOK_BACK).execute();
  const byRecipe = new Map<string, RenderRow[]>();
  for (const r of rows) byRecipe.set(r.recipe_id, [...(byRecipe.get(r.recipe_id) ?? []), r]);
  const out: Record<string, Known> = {};
  for (const [recipe, own] of byRecipe) {
    // what a loaded model still spends before its first step: the text, the pictures
    const start = median(own.filter((r) => !r.cold).map((r) => r.load_ms)) ?? 0;
    const figures = (list: RenderRow[]) => {
      const perSecond = list.filter((r) => r.kind === "video" && (r.duration_ms ?? 0) > 0).map((r) => warmMs(r, start) / (r.duration_ms! / 1000));
      const loads = list.filter((r) => r.cold).map((r) => Math.max(0, r.load_ms - start));
      return { ms: Math.round(median(list.map((r) => warmMs(r, start))) ?? 0), perSecondMs: perSecond.length ? Math.round(median(perSecond)!) : null, loadMs: Math.round(median(loads) ?? 0), samples: list.length };
    };
    const group = <K extends string>(key: (r: RenderRow) => K) => {
      const groups = new Map<K, RenderRow[]>();
      for (const r of own) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
      return [...groups.values()];
    };
    const whole = figures(own);
    // a recipe with no model that ever loaded knows no load time: the one of all its models then
    const models = group((r) => r.model_file).filter((g) => g[0]!.model_file).map((g) => ({ model: g[0]!.model_file, ...figures(g) })).map((m) => ({ ...m, loadMs: m.loadMs || whole.loadMs }));
    const settings = group((r) => `${r.time_key}\n${r.model_file}`).map((g) => ({ key: g[0]!.time_key, model: g[0]!.model_file, ms: figures(g).ms, samples: g.length }));
    out[recipe] = { settings, models, ...whole };
  }
  return out;
}

/** About how long this render will take with its model loaded, and what a model to load adds. */
export function guessFor(all: Record<string, Known>, recipe: Recipe<any>, input: Record<string, unknown>): Guess | null {
  return guess(all[recipe.id], recipe.inputs, input);
}

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

// ---------------------------------------------------------------- what the tab shows

export type Period = "day" | "week" | "month" | "all";
/** A window of time, ms since the epoch. */
export interface Window { from: number; to: number }
/** How long a stretch of a chart is for a window: five minutes up to three hours, a quarter up to twelve, an hour up to two days, six hours up to a week, a day beyond. */
export function stepFor(spanMs: number): number {
  const H = 3_600_000;
  return spanMs <= 3 * H ? 5 * 60_000 : spanMs <= 12 * H ? 15 * 60_000 : spanMs <= 48 * H ? H : spanMs <= 7 * DAY + H ? 6 * H : DAY;
}

const nameOf = (registry: Registry, recipeId: string) => {
  const recipe = registry.recipe(recipeId);
  if (!recipe) return recipeId;
  const family = registry.family(recipe.family)?.name;
  return !family || recipe.title.toLowerCase().startsWith(family.toLowerCase()) ? recipe.title : `${family} · ${recipe.title}`;
};

/** The parts of a render's time, as they are drawn. */
const parts = (c: Cell) => ({ loading: c.loadMs, sampling: c.sampleMs, refining: c.refineMs, finishing: c.finishMs });

export async function summary(db: Db, registry: Registry, period: Period | Window, keepDays: number, when = Date.now()) {
  const first = (await db.selectFrom("render_stats").select((eb) => eb.fn.min("created_at").as("at")).executeTakeFirst())?.at ?? null;
  const firstDay = (await db.selectFrom("render_days").select((eb) => eb.fn.min("day").as("day")).executeTakeFirst())?.day ?? null;
  const since = firstDay ? `${firstDay}T00:00:00.000Z` : first;
  // the window: a named period ends now; "all" reaches back to the first render; a window is as given
  const win: Window = typeof period === "string"
    ? { from: period === "day" ? when - DAY : period === "week" ? when - 7 * DAY : period === "month" ? when - 30 * DAY : Math.min(when - DAY, since ? Date.parse(since) : when - DAY), to: when }
    : { from: Math.min(period.from, period.to - 60_000), to: Math.min(period.to, when + 60_000) };
  // the window cut into stretches by its length; days are whole days (UTC), so that a folded day is one stretch
  const step = stepFor(win.to - win.from);
  const end = step === DAY ? Date.parse(`${dayOf(new Date(win.to).toISOString())}T00:00:00.000Z`) + DAY : win.to;
  const count = Math.max(2, Math.min(730, Math.ceil((end - win.from) / step)));
  const start = end - count * step;
  const times = Array.from({ length: count }, (_x, i) => start + i * step);
  const index = (ms: number) => Math.floor((ms - start) / step);

  const rows = await db.selectFrom("render_stats").selectAll().where("created_at", ">=", new Date(start).toISOString()).orderBy("created_at", "desc").execute();
  const folded = step === DAY ? await db.selectFrom("render_days").selectAll().where("day", ">=", dayOf(new Date(start).toISOString())).execute() : [];

  // each stretch: its rows, and the figures of days that are no longer rows
  const stretch = times.map(() => ({ rows: [] as RenderRow[], days: [] as Array<{ recipe: string; file: string; cell: Cell }> }));
  for (const r of rows) stretch[index(Date.parse(r.created_at))]?.rows.push(r);
  for (const d of folded) stretch[index(Date.parse(`${d.day}T00:00:00.000Z`))]?.days.push({ recipe: d.recipe_id, file: d.model_file, cell: JSON.parse(d.figures) as Cell });

  /** The figures of one stretch, for everything or for the renders a test lets through. */
  const cellAt = (i: number, of?: { recipe: string; file?: string }) => {
    const s = stretch[i]!;
    const own = s.rows.filter((r) => !of || (r.recipe_id === of.recipe && (of.file === undefined || r.model_file === of.file)));
    const old = s.days.filter((d) => (of ? d.recipe === of.recipe && (of.file === undefined || d.file === of.file) : d.recipe === WHOLE_DAY)).map((d) => d.cell);
    return own.length || old.length ? merge([...(own.length ? [cellOf(own)] : []), ...old]) : null;
  };
  const series = <T>(pick: (c: Cell) => T, of?: { recipe: string; file?: string }) => times.map((_t, i) => { const c = cellAt(i, of); return c ? pick(c) : null; });
  const whole = merge(times.map((_t, i) => cellAt(i)).filter((c): c is Cell => c !== null));
  const count0 = (v: number | null) => v ?? 0;

  // the models: everything made with one recipe, and under it each model file
  const recipes = [...new Set([...rows.map((r) => r.recipe_id), ...folded.filter((d) => d.recipe_id !== WHOLE_DAY).map((d) => d.recipe_id)])];
  const models = recipes.map((recipe) => {
    const own = rows.filter((r) => r.recipe_id === recipe);
    const cells = times.map((_t, i) => cellAt(i, { recipe }));
    const all = merge(cells.filter((c): c is Cell => c !== null));
    const done = own.filter((r) => r.status === "done");
    const warm = done.filter((r) => !r.cold && r.whole);
    const files = new Map<string, string>();
    for (const r of own) if (r.model_file) files.set(r.model_file, r.model);
    for (const d of folded) if (d.recipe_id === recipe && d.model_file) files.set(d.model_file, files.get(d.model_file) ?? d.model);
    // the setting used most: what the estimate is spelled out for
    const groups = new Map<string, RenderRow[]>();
    for (const r of done.filter((x) => x.whole)) groups.set(`${r.time_key}\n${r.model_file}`, [...(groups.get(`${r.time_key}\n${r.model_file}`) ?? []), r]);
    const most = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    const start0 = median(warm.map((r) => r.load_ms)) ?? 0;
    const setting = most && {
      width: most[0]!.width, height: most[0]!.height, seconds: most[0]!.duration_ms ? Math.round(most[0]!.duration_ms / 100) / 10 : null, steps: most[0]!.steps, model: most[0]!.model, samples: most.length,
      stepMs: median(real(most.map((r) => r.step_ms))), sampleMs: median(most.map((r) => r.sample_ms)) ?? 0, refineMs: median(most.map((r) => r.refine_ms)) ?? 0, finishMs: median(most.map((r) => r.finish_ms)) ?? 0,
      warmMs: Math.round(median(most.map((r) => warmMs(r, start0))) ?? 0),
      loadMs: Math.round(median(own.filter((r) => r.cold && r.whole).map((r) => Math.max(0, r.load_ms - start0))) ?? 0),
    };
    const mean = (pick: (r: RenderRow) => number) => (warm.length ? Math.round(sum(warm.map(pick)) / warm.length) : 0);
    return {
      key: recipe, name: nameOf(registry, recipe), kind: own[0]?.kind ?? null,
      renders: all.renders, usualMs: all.usualMs, slowMs: all.slowMs, stepMs: all.stepMs, loadMs: all.loadUsualMs, gpuMs: all.totalMs,
      trend: done.slice(0, 24).reverse().map((r) => r.total_ms),
      usual: cells.map((c) => c?.usualMs ?? null), slow: cells.map((c) => c?.slowMs ?? null), cold: cells.map((c) => c?.coldMs ?? null),
      // its pace against its own usual: 100 is as ever
      pace: cells.map((c) => (c?.stepMs && all.stepMs ? Math.round((c.stepMs / all.stepMs) * 1000) / 10 : null)),
      phases: { loading: mean((r) => r.load_ms), sampling: mean((r) => r.sample_ms), refining: mean((r) => r.refine_ms), finishing: mean((r) => r.finish_ms) },
      setting: setting ?? null,
      files: [...files].map(([file, name]) => {
        const of = merge(times.map((_t, i) => cellAt(i, { recipe, file })).filter((c): c is Cell => c !== null));
        return { file, name: name || file, renders: of.renders, stepMs: of.stepMs, step: series((c) => c.stepMs, { recipe, file }) };
      }),
    };
  }).sort((a, b) => b.gpuMs - a.gpuMs);

  // what rendered in each stretch, the longest first: for the pointer, and for the lanes
  const buckets = stretch.map((s) => {
    const longest = [...s.rows].sort((a, b) => b.total_ms - a.total_ms);
    return {
      renders: s.rows.length + sum(s.days.filter((d) => d.recipe === WHOLE_DAY).map((d) => d.cell.renders)),
      top: longest.slice(0, 8).map((r) => ({ id: r.id, name: nameOf(registry, r.recipe_id), model: r.model, totalMs: r.total_ms, status: r.status, assetId: r.asset_id })),
    };
  });

  return {
    period: typeof period === "string" ? period : "window", from: start, to: end, step, times, keepDays, since, buckets,
    /** The stretch of time the figures cover: the period, or since the first render when that is later. */
    spanMs: Math.max(step, Math.min(end, when) - Math.max(start, since ? Date.parse(since) : start)),
    tiles: {
      done: whole.done, images: whole.images, videos: whole.videos, failed: whole.failed, cancelled: whole.cancelled,
      videoMs: whole.videoMs, lostMs: whole.lostMs, gpuMs: whole.totalMs, longestMs: whole.longestMs,
      loadMs: whole.loadMs, loads: whole.cold, loadUsualMs: whole.loadUsualMs,
      waitedUsualMs: whole.waitedUsualMs, waitedSlowMs: whole.waitedSlowMs, off: whole.off,
      vramPeak: whole.vramPeak, vramUsual: whole.vramUsual, heatPeak: whole.heatPeak, heatUsual: whole.heatUsual,
    },
    finished: { images: series((c) => c.images).map(count0), videos: series((c) => c.videos).map(count0), bad: series((c) => c.failed + c.cancelled).map(count0) },
    phases: {
      loading: series((c) => parts(c).loading).map(count0), sampling: series((c) => parts(c).sampling).map(count0),
      refining: series((c) => parts(c).refining).map(count0), finishing: series((c) => parts(c).finishing).map(count0),
    },
    wait: { usual: series((c) => c.waitedUsualMs), slow: series((c) => c.waitedSlowMs) },
    gpu: { vram: series((c) => c.vramPeak), heat: series((c) => c.heatPeak) },
    models,
  };
}
export type TimesSummary = Awaited<ReturnType<typeof summary>>;

/** The renders that are still rows, newest first: one page of them. */
export async function list(db: Db, registry: Registry, opts: { recipe?: string; trouble?: boolean; before?: string; limit?: number; from?: number; to?: number }) {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  let q = db.selectFrom("render_stats").selectAll();
  if (opts.recipe) q = q.where("recipe_id", "=", opts.recipe);
  if (opts.trouble) q = q.where("status", "!=", "done");
  if (opts.from) q = q.where("created_at", ">=", new Date(opts.from).toISOString());
  if (opts.to) q = q.where("created_at", "<", new Date(opts.to).toISOString());
  let counted = db.selectFrom("render_stats").select((eb) => eb.fn.countAll<number>().as("n"));
  if (opts.recipe) counted = counted.where("recipe_id", "=", opts.recipe);
  if (opts.trouble) counted = counted.where("status", "!=", "done");
  if (opts.from) counted = counted.where("created_at", ">=", new Date(opts.from).toISOString());
  if (opts.to) counted = counted.where("created_at", "<", new Date(opts.to).toISOString());
  const total = Number((await counted.executeTakeFirst())?.n ?? 0);
  if (opts.before) q = q.where("created_at", "<", opts.before);
  const rows = await q.orderBy("created_at", "desc").limit(limit + 1).execute();
  // what it made, when that is still in the library: shown beside it
  const ids = rows.map((r) => r.asset_id).filter((id): id is string => Boolean(id));
  const alive = new Set(ids.length ? (await db.selectFrom("assets").select("id").where("id", "in", ids).where("deleted_at", "is", null).execute()).map((a) => a.id) : []);
  return {
    total,
    more: rows.length > limit,
    items: rows.slice(0, limit).map((r) => ({
      id: r.id, at: r.created_at, recipe: r.recipe_id, name: nameOf(registry, r.recipe_id), model: r.model, kind: r.kind, width: r.width, height: r.height,
      seconds: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : null, steps: r.steps, stepMs: r.step_ms,
      phases: { loading: r.load_ms, sampling: r.sample_ms, refining: r.refine_ms, finishing: r.finish_ms },
      totalMs: r.total_ms, expectedMs: r.expected_ms, cold: Boolean(r.cold), whole: Boolean(r.whole), waitedMs: r.waited_ms, vram: r.vram_peak, heat: r.heat_peak, status: r.status,
      assetId: r.asset_id && alive.has(r.asset_id) ? r.asset_id : null,
    })),
  };
}

/** How much room the record takes: how many renders are rows, how many days are figures. */
export async function size(db: Db) {
  const rows = Number((await db.selectFrom("render_stats").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ?? 0);
  const days = Number((await db.selectFrom("render_days").select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ?? 0);
  return { renders: rows, days, bytes: rows * 420 + days * 560 };
}

/** Forget everything that was measured. */
export async function clear(db: Db): Promise<void> {
  await db.deleteFrom("render_stats").execute();
  await db.deleteFrom("render_days").execute();
}
