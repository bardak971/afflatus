import type { Kysely, Selectable } from "kysely";
import type { Measured } from "@afflatus/comfy";
import { modelOf, timeKey, TOOLS_FAMILY, type Recipe } from "@afflatus/core";
import { now, OWNER, type Db, type Tables } from "./db";
import type { Registry } from "./registry";
import type { JobRow, Resume } from "./queueModel";

/**
 * The record of render times: what every render took and where its time went.
 *
 *  - `record` writes one row when a render that ran on ComfyUI ends, finished or not;
 *  - `fold` turns the rows older than the days they are kept into one line of figures per model and
 *    day, which stay for good: the charts go on reaching back, the list of renders does not;
 *  - `summary` and `list` are what the "Render times" tab shows; a summary by days reads each past day from its digest
 *    (`digestDays`, written once the day is over), so that only today's rows are worked out again on every call;
 *  - `usualParts` is what a running render is expected to do after its first pass. The next render's time is
 *    forecast from the same rows (forecast.ts).
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
      vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made?.id ?? null, created_at: at,
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
  work: number | null, expectedMs: number | null,
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
      vram_peak: measured?.vramPeak ?? null, heat_peak: measured?.heatPeak ?? null, asset_id: made.assetId, created_at: at,
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

/**
 * Ran out of video memory, as far as the figures can tell: the memory was full (ComfyUI fills it with any large model, so that
 * alone says nothing) and it took at least twice what was expected of it. The card then works out of system memory at a
 * fraction of its pace (a 6-minute SeedVR2 clip past 20 minutes, 2026-10-08). A failure is not counted; a stop is.
 */
export const spilled = (r: Pick<RenderRow, "status" | "vram_peak" | "expected_ms" | "total_ms">) =>
  r.status !== "failed" && r.vram_peak !== null && r.vram_peak >= 95 && r.expected_ms !== null && r.expected_ms > 0 && r.total_ms >= 2 * r.expected_ms;

const OUT_OF_MEMORY = /out of memory|\boom\b|allocat|not enough memory/i;
/**
 * The failed renders among `rows` that ran out of memory (OOM): their job's error says so. A job no longer kept is
 * not counted: a full memory alone does not say why a render failed. In slices: SQLite takes so many values in one `in`.
 */
async function outOfMemory(db: Db, rows: Array<Pick<RenderRow, "id" | "status">>): Promise<Set<string>> {
  const failed = rows.filter((r) => r.status === "failed");
  const errors = new Map<string, string | null>();
  for (let i = 0; i < failed.length; i += 400) {
    const ids = failed.slice(i, i + 400).map((r) => r.id);
    for (const j of await db.selectFrom("jobs").select(["id", "error"]).where("id", "in", ids).execute()) errors.set(j.id, j.error);
  }
  return new Set(failed.filter((r) => OUT_OF_MEMORY.test(errors.get(r.id) ?? "")).map((r) => r.id));
}

// ---------------------------------------------------------------- folding the old rows into days

/** The day as a whole, among the rows of `render_days`. */
const WHOLE_DAY = "*";
const dayOf = (iso: string) => iso.slice(0, 10);

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

// ---------------------------------------------------------------- the days over, digested

/**
 * What a summary reads of the rows of one stretch of its chart, worked out at once: its figures as a whole, per recipe,
 * and per recipe and model file; what each recipe's line reads one render at a time (Line); its longest renders; how many
 * were tools and how many ran out of video memory; the upscales' paces. A summary cut into days ("month", "all") reads
 * each day that is over from its digest in `render_digests` instead of working it out again from its rows, which on
 * "all" were every row kept. The digest is this same function applied to the day's rows, newest first, as the summary
 * reads them: the answer is the same to the byte. Today, and any stretch of a summary cut finer than days, is digested
 * on the fly.
 */
interface Digest {
  whole: Cell;
  /** In the order they first appear, newest first. */
  recipes: Array<[recipe: string, cell: Cell, line: Line]>;
  files: Array<[recipe: string, file: string, cell: Cell]>;
  /** The longest renders, the longest first (the newest first among equals). */
  top: Array<Pick<RenderRow, "id" | "recipe_id" | "model" | "total_ms" | "status" | "asset_id">>;
  tools: number;
  spills: number;
  /** The time the runs that spilled out of video memory took over what was expected of them. */
  spillLostMs: number;
  /** The video routes and the picture upscales that ran, in the order they first appear newest first; whether a picture had a hires pass. */
  video: string[];
  pictures: string[];
  hires: boolean;
  /** The middle pace of each recipe's finished runs that did not spill (see upscalePaces), where it has one. */
  paces: { video: Array<[recipe: string, pace: number]>; pictures: Array<[recipe: string, pace: number]>; hires: number | null };
}

/**
 * What a recipe's line in a summary reads of its renders one by one, kept so that the stretches put together give what
 * the renders of the whole window would: the newest first, and every figure a middle is taken of (see modelLines).
 */
interface Line {
  /** Of the newest render. */
  kind: RenderRow["kind"];
  /** Its model files in the order they first appear, newest first, each with the model of its oldest render. */
  files: Array<[file: string, model: string]>;
  /** The time of the newest finished renders (24 at most), the newest first. */
  trend: number[];
  /** The renders that failed: whether they ran out of memory is asked of their jobs when the summary is read. */
  failed: string[];
  /** What loading took in the measured renders that loaded their model, finished or not. */
  coldLoads: number[];
  /** Its finished, measured renders by setting and model file, in the order they first appear, newest first. */
  settings: Setting[];
}
/** The finished, measured renders of one setting (time key) and model file: the newest one's figures, and the others' one column each. */
interface Setting {
  key: string;
  newest: Pick<RenderRow, "width" | "height" | "duration_ms" | "steps" | "model">;
  step: Array<number | null>;
  sample: number[];
  refine: number[];
  finish: number[];
  total: number[];
  load: number[];
  cold: number[];
}

/** The Line of one recipe's rows, newest first. */
function lineOf(own: RenderRow[]): Line {
  const done = own.filter((r) => r.status === "done");
  const files = new Map<string, string>();
  for (const r of own) if (r.model_file) files.set(r.model_file, r.model);
  const settings = new Map<string, Setting>();
  for (const r of done) {
    if (!r.whole) continue;
    const key = `${r.time_key}\n${r.model_file}`;
    let g = settings.get(key);
    if (!g) settings.set(key, (g = { key, newest: { width: r.width, height: r.height, duration_ms: r.duration_ms, steps: r.steps, model: r.model }, step: [], sample: [], refine: [], finish: [], total: [], load: [], cold: [] }));
    g.step.push(r.step_ms); g.sample.push(r.sample_ms); g.refine.push(r.refine_ms); g.finish.push(r.finish_ms); g.total.push(r.total_ms); g.load.push(r.load_ms); g.cold.push(r.cold);
  }
  return {
    kind: own[0]!.kind, files: [...files], trend: done.slice(0, 24).map((r) => r.total_ms), failed: own.filter((r) => r.status === "failed").map((r) => r.id),
    coldLoads: own.filter((r) => r.cold && r.whole).map((r) => r.load_ms), settings: [...settings.values()],
  };
}

const groupKey = (recipe: string, file?: string) => (file === undefined ? recipe : `${recipe}\n${file}`);
const dayStart = (day: string) => `${day}T00:00:00.000Z`;
const megapixels = (r: Pick<RenderRow, "width" | "height">) => (r.width && r.height ? (r.width * r.height) / 1e6 : 0);
const hiresPace = (r: RenderRow) => (r.kind === "image" && /hires=true/.test(r.time_key) && r.refine_ms && megapixels(r) ? r.refine_ms / 1000 / megapixels(r) : null);

/** The digest of some rows, newest first. */
function digestOf(rows: RenderRow[]): Digest {
  const recipes = new Map<string, RenderRow[]>();
  const files = new Map<string, RenderRow[]>();
  const add = (m: Map<string, RenderRow[]>, key: string, r: RenderRow) => {
    const list = m.get(key);
    if (list) list.push(r);
    else m.set(key, [r]);
  };
  for (const r of rows) {
    add(recipes, r.recipe_id, r);
    add(files, groupKey(r.recipe_id, r.model_file), r);
  }
  const spills = rows.filter(spilled);
  // the paces are those of the finished runs that did not spill, recipe by recipe
  const fine = rows.filter((r) => r.status === "done" && !spilled(r));
  const paceOf = (pick: (r: RenderRow) => number | null) =>
    [...recipes.keys()].flatMap((recipe): Array<[string, number]> => {
      const pace = median(real(fine.filter((r) => r.recipe_id === recipe).map(pick)));
      return pace === null ? [] : [[recipe, pace]];
    });
  return {
    whole: cellOf(rows),
    recipes: [...recipes].map(([recipe, own]) => [recipe, cellOf(own), lineOf(own)]),
    files: [...files.values()].map((own) => [own[0]!.recipe_id, own[0]!.model_file, cellOf(own)]),
    top: [...rows].sort((a, b) => b.total_ms - a.total_ms).slice(0, 8).map((r) => ({ id: r.id, recipe_id: r.recipe_id, model: r.model, total_ms: r.total_ms, status: r.status, asset_id: r.asset_id })),
    tools: rows.filter((r) => r.recipe_id.startsWith("tool.")).length,
    spills: spills.length, spillLostMs: sum(spills.map((r) => Math.max(0, r.total_ms - (r.expected_ms ?? 0)))),
    video: [...new Set(rows.filter((r) => r.recipe_id.startsWith("tool.") && r.duration_ms).map((r) => r.recipe_id))],
    pictures: [...new Set(rows.filter((r) => r.kind === "image" && /\.sharper$|^tools\.|upscale/i.test(r.recipe_id) && r.width && r.height).map((r) => r.recipe_id))],
    hires: rows.some((r) => r.kind === "image" && /hires=true/.test(r.time_key) && r.refine_ms),
    paces: {
      video: paceOf((r) => (r.duration_ms ? r.total_ms / 60_000 / (r.duration_ms / 1000) : null)),
      pictures: paceOf((r) => (megapixels(r) ? r.total_ms / 1000 / megapixels(r) : null)),
      hires: median(real(fine.map(hiresPace))),
    },
  };
}

/**
 * The digests read so far, parsed: a day's digest is written once, so the same text comes back on every summary, and
 * parsing it (two megabytes for "all" at four thousand renders) was most of what is left of a summary's time. Kept
 * by its text, so a digest written again (or another database's) is parsed again; read only, never changed.
 */
const parsed = new Map<string, { text: string; digest: Digest }>();
function parseDigest(day: string, text: string): Digest {
  const had = parsed.get(day);
  if (had?.text === text) return had.digest;
  const digest = JSON.parse(text) as Digest;
  parsed.set(day, { text, digest });
  return digest;
}

/** The last day digested. Every day before it that is still rows has its digest: days are digested oldest first, and fold away with their rows. */
async function digestedThrough(db: Kysely<Tables>): Promise<string | null> {
  return (await db.selectFrom("render_digests").select((eb) => eb.fn.max("day").as("day")).executeTakeFirst())?.day ?? null;
}

/**
 * Digest the days before `when`'s that are rows and have no digest yet, oldest first: after each render (usually
 * nothing to do but one look at the last day digested), and with the fold. `again`: the day of a row just written;
 * when that day was digested already (the clock set back over midnight), it is digested again with its new row.
 */
export async function digestDays(db: Kysely<Tables>, when: number, again?: string): Promise<void> {
  const today = dayOf(new Date(when).toISOString());
  const through = await digestedThrough(db);
  let q = db.selectFrom("render_stats").selectAll().where("created_at", "<", dayStart(today));
  if (through) q = q.where("created_at", ">=", new Date(Date.parse(dayStart(through)) + DAY).toISOString());
  const rows = await q.orderBy("created_at", "desc").execute();
  if (again && through && again <= through && again < today) {
    const next = new Date(Date.parse(dayStart(again)) + DAY).toISOString();
    rows.push(...(await db.selectFrom("render_stats").selectAll().where("created_at", ">=", dayStart(again)).where("created_at", "<", next).orderBy("created_at", "desc").execute()));
  }
  const days = new Map<string, RenderRow[]>();
  for (const r of rows) {
    const list = days.get(dayOf(r.created_at));
    if (list) list.push(r);
    else days.set(dayOf(r.created_at), [r]);
  }
  for (const day of [...days.keys()].sort()) {
    const digest = JSON.stringify(digestOf(days.get(day)!));
    await db.insertInto("render_digests").values({ day, digest }).onConflict((oc) => oc.column("day").doUpdateSet({ digest })).execute();
  }
}

// ---------------------------------------------------------------- what the running render is expected to do next

/** What a render would have taken with its model already loaded: what loading added, beyond what even a loaded model spends before its first step, taken off. */
const warmMs = (r: Pick<RenderRow, "cold" | "total_ms" | "load_ms">, usualStart: number) => (r.cold ? r.total_ms - Math.max(0, r.load_ms - usualStart) : r.total_ms);

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
function stepFor(spanMs: number): number {
  const H = 3_600_000;
  return spanMs <= 3 * H ? 5 * 60_000 : spanMs <= 12 * H ? 15 * 60_000 : spanMs <= 48 * H ? H : spanMs <= 7 * DAY + H ? 6 * H : DAY;
}

/** The tools that run on ComfyUI without a recipe of their own (a finish, a slow motion): their record's name. */
const TOOL_NAMES: Record<string, string> = {
  "tool.finish.seedvr": "Finish · SeedVR2", "tool.finish.rtx": "Finish · RTX", "tool.finish.model": "Finish · upscale model", "tool.slow": "Slow motion · RIFE",
};
const nameOf = (registry: Registry, recipeId: string) => {
  if (TOOL_NAMES[recipeId]) return TOOL_NAMES[recipeId]!;
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
  const { start, end, step, times } = windowOf(period, since, when);
  const index = (ms: number) => Math.floor((ms - start) / step);
  const iso = (ms: number) => new Date(ms).toISOString();

  // cut into days, the days over are read from their digests, and only the rows after them (today's) are read whole;
  // bounded at the end too: a window in the past counts nothing that came after it
  const through = step === DAY ? await digestedThrough(db) : null;
  const rowsFrom = through ? Math.max(start, Date.parse(dayStart(through)) + DAY) : start;
  const rows = rowsFrom < end ? await db.selectFrom("render_stats").selectAll().where("created_at", ">=", iso(rowsFrom)).where("created_at", "<", iso(end)).orderBy("created_at", "desc").execute() : [];
  const digested = rowsFrom > start ? await db.selectFrom("render_digests").selectAll().where("day", ">=", dayOf(iso(start))).where("day", "<", dayOf(iso(Math.min(rowsFrom, end)))).execute() : [];
  const folded = step === DAY ? await db.selectFrom("render_days").selectAll().where("day", ">=", dayOf(iso(start))).execute() : [];

  // each stretch: the digest of its rows, and the figures of days that are no longer rows
  const ownRows = times.map(() => [] as RenderRow[]);
  for (const r of rows) ownRows[index(Date.parse(r.created_at))]?.push(r);
  const digests: Array<Digest | null> = ownRows.map((own) => (own.length ? digestOf(own) : null));
  for (const d of digested) {
    const i = index(Date.parse(dayStart(d.day)));
    if (i >= 0 && i < digests.length) digests[i] = parseDigest(d.day, d.digest);
  }
  const stretch = digests.map((d) => ({
    digest: d,
    recipes: new Map(d?.recipes.map(([recipe, cell]) => [recipe, cell])),
    files: new Map(d?.files.map(([recipe, file, cell]) => [groupKey(recipe, file), cell])),
    days: [] as Array<{ recipe: string; file: string; cell: Cell }>,
  }));
  for (const d of folded) stretch[index(Date.parse(dayStart(d.day)))]?.days.push({ recipe: d.recipe_id, file: d.model_file, cell: JSON.parse(d.figures) as Cell });

  // each stretch's folded days sorted once by recipe, and by recipe and model file: a cell is then read off its own group
  const groups = stretch.map((s) => {
    const days = new Map<string, Cell[]>();
    const add = (key: string, v: Cell) => {
      const list = days.get(key);
      if (list) list.push(v);
      else days.set(key, [v]);
    };
    for (const d of s.days) {
      add(groupKey(d.recipe), d.cell);
      add(groupKey(d.recipe, d.file), d.cell);
    }
    return days;
  });
  /** The figures of each stretch, for everything or for the renders of one recipe (and one model file): worked out once each. */
  const cells = new Map<string, Array<Cell | null>>();
  const cellsOf: CellsOf = (of) => {
    const key = of ? `${of.file === undefined ? 0 : 1}\n${groupKey(of.recipe, of.file)}` : "";
    const had = cells.get(key);
    if (had) return had;
    const list = stretch.map((s, i) => {
      const own = !s.digest ? undefined : !of ? s.digest.whole : of.file === undefined ? s.recipes.get(of.recipe) : s.files.get(groupKey(of.recipe, of.file));
      const old = of ? (groups[i]!.get(groupKey(of.recipe, of.file)) ?? []) : (groups[i]!.get(WHOLE_DAY) ?? []);
      // a digest's cell alone is the cell as it is: merge would give it back unchanged
      return old.length ? merge([...(own ? [own] : []), ...old]) : (own ?? null);
    });
    cells.set(key, list);
    return list;
  };
  const series = <T>(pick: (c: Cell) => T) => cellsOf().map((c) => (c ? pick(c) : null));
  const whole = merge(cellsOf().filter((c): c is Cell => c !== null));
  const count0 = (v: number | null) => v ?? 0;
  const digestsOf = digests.filter((d): d is Digest => d !== null);

  // the jobs that failed or were stopped before they reached ComfyUI: no render row, but the Queue lists them, so the counts do too
  const unsent = await notRendered(db, start, end, keepDays, when);
  const unsentAt = times.map(() => ({ failed: 0, cancelled: 0 }));
  for (const j of unsent) { const at = unsentAt[index(Date.parse(j.finished_at))]; if (at) at[j.status] += 1; }
  const unsentCount = { failed: sum(unsentAt.map((u) => u.failed)), cancelled: sum(unsentAt.map((u) => u.cancelled)) };

  // each recipe's lines, the newest stretch first
  const lines = new Map<string, Line[]>();
  for (const d of [...digestsOf].reverse()) {
    for (const [recipe, _cell, line] of d.recipes) {
      const list = lines.get(recipe);
      if (list) list.push(line);
      else lines.set(recipe, [line]);
    }
  }
  // the failures that ran out of memory, for the models and the tiles
  const oom = await outOfMemory(db, [...lines.values()].flat().flatMap((l) => l.failed.map((id) => ({ id, status: "failed" as const }))));
  // the models: everything made with one recipe, and under it each model file
  const models = modelLines(registry, lines, folded, cellsOf, oom);

  // what rendered in each stretch, the longest first: for the pointer, and for the lanes (a recipe's name looked up once)
  const names = new Map<string, string>();
  const name = (recipe: string) => names.get(recipe) ?? names.set(recipe, nameOf(registry, recipe)).get(recipe)!;
  const buckets = stretch.map((s) => ({
    renders: (s.digest?.whole.renders ?? 0) + sum(s.days.filter((d) => d.recipe === WHOLE_DAY).map((d) => d.cell.renders)),
    top: (s.digest?.top ?? []).map((r) => ({ id: r.id, name: name(r.recipe_id), model: r.model, totalMs: r.total_ms, status: r.status, assetId: r.asset_id })),
  }));

  const upscale = upscalePaces(registry, digests);
  // the period before, as long, for "Δ vs prior": none for "all", nor when the record covers less than nine tenths of it
  const priorFrom = start - (end - start);
  const prior = period !== "all" && since && Date.parse(since) <= priorFrom + Math.max(step, (end - start) / 10) ? await totals(db, priorFrom, start, step === DAY, keepDays, when) : null;

  return {
    period: typeof period === "string" ? period : ("window" as const), from: start, to: end, step, times, keepDays, since, buckets,
    upscale,
    /**
     * The stretch of time the figures cover: the period, or since the first render when that is later. In whole steps: to
     * the millisecond it changed on every call, and the summary was never the same twice for its ETag.
     */
    spanMs: Math.max(step, Math.round((Math.min(end, when) - Math.max(start, since ? Date.parse(since) : start)) / step) * step),
    tiles: {
      done: whole.done, images: whole.images, videos: whole.videos, failed: whole.failed + unsentCount.failed, cancelled: whole.cancelled + unsentCount.cancelled,
      // of those, the ones that never reached ComfyUI: they took no GPU time (said in the tip)
      unsent: unsentCount,
      videoMs: whole.videoMs, lostMs: whole.lostMs, gpuMs: whole.totalMs, longestMs: whole.longestMs,
      loadMs: whole.loadMs, loads: whole.cold, loadUsualMs: whole.loadUsualMs,
      waitedUsualMs: whole.waitedUsualMs, waitedSlowMs: whole.waitedSlowMs, off: whole.off,
      vramPeak: whole.vramPeak, vramUsual: whole.vramUsual, heatPeak: whole.heatPeak, heatUsual: whole.heatUsual,
      // the tools among the renders (finishes, slow motions), and the runs that ran out of video memory
      tools: sum(digestsOf.map((d) => d.tools)),
      spills: sum(digestsOf.map((d) => d.spills)), spillLostMs: sum(digestsOf.map((d) => d.spillLostMs)),
      oom: oom.size,
    },
    prior,
    finished: { images: series((c) => c.images).map(count0), videos: series((c) => c.videos).map(count0), bad: series((c) => c.failed + c.cancelled).map((v, i) => count0(v) + unsentAt[i]!.failed + unsentAt[i]!.cancelled), videoMs: series((c) => c.videoMs).map(count0) },
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

/** The totals of a window, rows, digested days and folded days: what a period is set against. Days only when the window is whole days. */
async function totals(db: Db, from: number, to: number, days: boolean, keepDays: number, when: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const through = days ? await digestedThrough(db) : null;
  const rowsFrom = through ? Math.max(from, Date.parse(dayStart(through)) + DAY) : from;
  const rows = rowsFrom < to ? await db.selectFrom("render_stats").selectAll().where("created_at", ">=", iso(rowsFrom)).where("created_at", "<", iso(to)).execute() : [];
  const digested = rowsFrom > from ? await db.selectFrom("render_digests").select(["day", "digest"]).where("day", ">=", dayOf(iso(from))).where("day", "<", dayOf(iso(Math.min(rowsFrom, to)))).execute() : [];
  const folded = days ? await db.selectFrom("render_days").select("figures").where("recipe_id", "=", WHOLE_DAY).where("day", ">=", dayOf(iso(from))).where("day", "<", dayOf(iso(to))).execute() : [];
  // only its sums are read: they add up the same however the renders are grouped
  const c = merge([...(rows.length ? [cellOf(rows)] : []), ...digested.map((d) => parseDigest(d.day, d.digest).whole), ...folded.map((d) => JSON.parse(d.figures) as Cell)]);
  const unsent = await notRendered(db, from, to, keepDays, when);
  const unsentOf = (status: "failed" | "cancelled") => unsent.filter((j) => j.status === status).length;
  return { from, to, gpuMs: c.totalMs, done: c.done, failed: c.failed + unsentOf("failed"), cancelled: c.cancelled + unsentOf("cancelled"), videoMs: c.videoMs };
}

/**
 * The jobs that failed or were stopped in a window without a render row: refused before they were sent (a model file
 * ComfyUI does not have), stopped while they waited, a cut or an export that failed in ffmpeg. They took no GPU time,
 * but the Queue lists them, and a dashboard that counts fewer failures than the Queue shows is not trusted. Only from
 * the day the rows are kept from: a folded day keeps no job ids, so a job that did render then cannot be told apart.
 * A job that only loaded models (`warm`) is not counted, as it is not in the history either.
 */
async function notRendered(db: Db, from: number, to: number, keepDays: number, when: number): Promise<Array<{ status: "failed" | "cancelled"; finished_at: string }>> {
  const kept = keepDays > 0 ? Date.parse(`${dayOf(new Date(when - keepDays * DAY).toISOString())}T00:00:00.000Z`) : from;
  const start = Math.max(from, kept);
  if (start >= to) return [];
  const rows = await db
    .selectFrom("jobs")
    .select(["status", "finished_at"])
    .where("status", "in", ["failed", "cancelled"])
    .where("warm", "=", 0)
    .where("finished_at", ">=", new Date(start).toISOString())
    .where("finished_at", "<", new Date(to).toISOString())
    .where("id", "not in", (eb) => eb.selectFrom("render_stats").select("id"))
    .execute();
  return rows.filter((r): r is { status: "failed" | "cancelled"; finished_at: string } => r.finished_at !== null && (r.status === "failed" || r.status === "cancelled"));
}

/**
 * The window a summary covers: a named period ends now; "all" reaches back to the first render (`since`); a
 * window is as given. Cut into stretches by its length; days are whole days (UTC), so that a folded day is one stretch.
 */
function windowOf(period: Period | Window, since: string | null, when: number): { start: number; end: number; step: number; times: number[] } {
  const win: Window = typeof period === "string"
    ? { from: period === "day" ? when - DAY : period === "week" ? when - 7 * DAY : period === "month" ? when - 30 * DAY : Math.min(when - DAY, since ? Date.parse(since) : when - DAY), to: when }
    : { from: Math.min(period.from, period.to - 60_000), to: Math.min(period.to, when + 60_000) };
  const step = stepFor(win.to - win.from);
  const end = step === DAY ? Date.parse(`${dayOf(new Date(win.to).toISOString())}T00:00:00.000Z`) + DAY : win.to;
  const count = Math.max(2, Math.min(730, Math.ceil((end - win.from) / step)));
  const start = end - count * step;
  return { start, end, step, times: Array.from({ length: count }, (_x, i) => start + i * step) };
}

/** The figures of each stretch of a summary, for everything or for one recipe (and one of its model files). */
type CellsOf = (of?: { recipe: string; file?: string }) => Array<Cell | null>;

/**
 * A summary's line per recipe, the busiest first: its figures per stretch, its usual setting spelled out, and each of its model files.
 * `lines`: each recipe's Line in each stretch, the newest first; together they read as the renders of the whole window would.
 */
function modelLines(registry: Registry, lines: Map<string, Line[]>, folded: Array<Tables["render_days"]>, cellsOf: CellsOf, oom: Set<string>) {
  const recipes = [...new Set([...lines.keys(), ...folded.filter((d) => d.recipe_id !== WHOLE_DAY).map((d) => d.recipe_id)])];
  return recipes.map((recipe) => {
    const own = lines.get(recipe) ?? [];
    const cells = cellsOf({ recipe });
    const all = merge(cells.filter((c): c is Cell => c !== null));
    const files = new Map<string, string>();
    for (const l of own) for (const [file, model] of l.files) files.set(file, model);
    for (const d of folded) if (d.recipe_id === recipe && d.model_file) files.set(d.model_file, files.get(d.model_file) ?? d.model);
    // the setting used most: what the estimate is spelled out for (among as many, the first seen newest first)
    const settings = new Map<string, Setting[]>();
    for (const l of own) {
      for (const g of l.settings) {
        const list = settings.get(g.key);
        if (list) list.push(g);
        else settings.set(g.key, [g]);
      }
    }
    const count = (parts: Setting[]) => sum(parts.map((g) => g.total.length));
    const most = [...settings.values()].sort((a, b) => count(b) - count(a))[0];
    // the parts of the renders whose model was already loaded (finished, measured, not cold)
    const warm = { load: [] as number[], sample: [] as number[], refine: [] as number[], finish: [] as number[] };
    for (const g of [...settings.values()].flat()) {
      g.cold.forEach((cold, i) => {
        if (cold) return;
        warm.load.push(g.load[i]!); warm.sample.push(g.sample[i]!); warm.refine.push(g.refine[i]!); warm.finish.push(g.finish[i]!);
      });
    }
    const start0 = median(warm.load) ?? 0;
    const setting = most && (() => {
      const newest = most[0]!.newest;
      const of = <T>(pick: (g: Setting) => T[]) => most.flatMap(pick);
      return {
        width: newest.width, height: newest.height, seconds: newest.duration_ms ? Math.round(newest.duration_ms / 100) / 10 : null, steps: newest.steps, model: newest.model, samples: count(most),
        stepMs: median(real(of((g) => g.step))), sampleMs: median(of((g) => g.sample)) ?? 0, refineMs: median(of((g) => g.refine)) ?? 0, finishMs: median(of((g) => g.finish)) ?? 0,
        warmMs: Math.round(median(of((g) => g.total.map((total, i) => warmMs({ cold: g.cold[i]!, total_ms: total, load_ms: g.load[i]! }, start0)))) ?? 0),
        loadMs: Math.round(median(own.flatMap((l) => l.coldLoads).map((load) => Math.max(0, load - start0))) ?? 0),
      };
    })();
    const mean = (parts: number[]) => (parts.length ? Math.round(sum(parts) / parts.length) : 0);
    return {
      key: recipe, name: nameOf(registry, recipe), kind: own[0]?.kind ?? null,
      renders: all.renders, usualMs: all.usualMs, slowMs: all.slowMs, stepMs: all.stepMs, loadMs: all.loadUsualMs, gpuMs: all.totalMs,
      failed: all.failed, cancelled: all.cancelled, lostMs: all.lostMs, oom: own.flatMap((l) => l.failed).filter((id) => oom.has(id)).length, loads: all.cold,
      trend: own.flatMap((l) => l.trend).slice(0, 24).reverse(),
      usual: cells.map((c) => c?.usualMs ?? null), slow: cells.map((c) => c?.slowMs ?? null), cold: cells.map((c) => c?.coldMs ?? null),
      // its pace against its own usual: 100 is as ever
      pace: cells.map((c) => (c?.stepMs && all.stepMs ? Math.round((c.stepMs / all.stepMs) * 1000) / 10 : null)),
      phases: { loading: mean(warm.load), sampling: mean(warm.sample), refining: mean(warm.refine), finishing: mean(warm.finish) },
      setting: setting ?? null,
      files: [...files].map(([file, name]) => {
        const each = cellsOf({ recipe, file });
        const of = merge(each.filter((c): c is Cell => c !== null));
        return { file, name: name || file, renders: of.renders, stepMs: of.stepMs, step: each.map((c) => c?.stepMs ?? null) };
      }),
    };
  }).sort((a, b) => b.gpuMs - a.gpuMs);
}

/**
 * The upscales' pace per stretch (`digests`: of each stretch's rows): a video route in minutes of work per second of video,
 * a picture tool or a hires pass in seconds per megapixel made (what a picture's own size does to it taken out).
 */
function upscalePaces(registry: Registry, digests: Array<Digest | null>) {
  // the routes and tools in the order they first appear, newest first
  const newest = digests.filter((d): d is Digest => d !== null).reverse();
  const videoRoutes = [...new Set(newest.flatMap((d) => d.video))];
  const pictureTools = [...new Set(newest.flatMap((d) => d.pictures))];
  const paceSeries = (pace: (d: Digest) => number | null) => digests.map((d) => (d ? pace(d) : null));
  const of = (paces: Array<[string, number]>, key: string) => paces.find(([recipe]) => recipe === key)?.[1] ?? null;
  return {
    video: videoRoutes.map((key) => ({ key, name: nameOf(registry, key), points: paceSeries((d) => of(d.paces.video, key)) })),
    pictures: [
      ...pictureTools.map((key) => ({ key, name: nameOf(registry, key), points: paceSeries((d) => of(d.paces.pictures, key)) })),
      // the hires pass of picture renders: its own time (the passes after the first sampling) over the megapixels made
      ...(newest.some((d) => d.hires) ? [{ key: "hires", name: "Hires fix (in picture renders)", points: paceSeries((d) => d.paces.hires) }] : []),
    ],
  };
}

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
  const oom = await outOfMemory(db, rows);
  return {
    total,
    more: rows.length > limit,
    items: rows.slice(0, limit).map((r) => ({
      id: r.id, at: r.created_at, recipe: r.recipe_id, name: nameOf(registry, r.recipe_id), model: r.model, kind: r.kind, width: r.width, height: r.height,
      seconds: r.duration_ms ? Math.round(r.duration_ms / 100) / 10 : null, steps: r.steps, stepMs: r.step_ms,
      phases: { loading: r.load_ms, sampling: r.sample_ms, refining: r.refine_ms, finishing: r.finish_ms },
      totalMs: r.total_ms, expectedMs: r.expected_ms, cold: Boolean(r.cold), whole: Boolean(r.whole), waitedMs: r.waited_ms, vram: r.vram_peak, heat: r.heat_peak, status: r.status,
      spilled: spilled(r),
      oom: oom.has(r.id),
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
  await db.deleteFrom("render_digests").execute();
}

// ---------------------------------------------------------------- the record summed up, for /metrics

/** One recipe's record summed up: how its renders ended, their time by phase, the videos made, and how many finished under each of BUCKETS. */
export interface RecipeSum { done: number; failed: number; cancelled: number; cold: number; total: number; doneTotal: number; load: number; sample: number; refine: number; finish: number; waited: number; video: number; hist: number[] }

/** The whole record summed up by recipe, rows and folded days alike: what only ever grows, as Prometheus counts it (metrics.ts). */
export async function tallyByRecipe(db: Db): Promise<Map<string, RecipeSum>> {
  const rows = await db.selectFrom("render_stats").select(["recipe_id", "status", "kind", "total_ms", "load_ms", "sample_ms", "refine_ms", "finish_ms", "waited_ms", "duration_ms", "cold"]).execute();
  const days = await db.selectFrom("render_days").select(["recipe_id", "figures"]).where("recipe_id", "!=", "*").execute();
  const by = new Map<string, RecipeSum>();
  const of = (recipe: string) => {
    let v = by.get(recipe);
    if (!v) by.set(recipe, (v = { done: 0, failed: 0, cancelled: 0, cold: 0, total: 0, doneTotal: 0, load: 0, sample: 0, refine: 0, finish: 0, waited: 0, video: 0, hist: BUCKETS.map(() => 0) }));
    return v;
  };
  for (const r of rows) {
    const v = of(r.recipe_id);
    v[r.status]++;
    v.cold += r.cold;
    v.total += r.total_ms; v.load += r.load_ms; v.sample += r.sample_ms; v.refine += r.refine_ms; v.finish += r.finish_ms; v.waited += r.waited_ms;
    if (r.status === "done") v.doneTotal += r.total_ms;
    if (r.status === "done" && r.kind === "video") v.video += r.duration_ms ?? 0;
    if (r.status === "done") BUCKETS.forEach((le, i) => { if (r.total_ms / 1000 <= le) v.hist[i]!++; });
  }
  for (const d of days) {
    const c = JSON.parse(d.figures) as Cell;
    const v = of(d.recipe_id);
    v.done += c.done; v.failed += c.failed; v.cancelled += c.cancelled; v.cold += c.cold;
    v.total += c.totalMs; v.doneTotal += c.totalMs - c.lostMs; v.load += c.loadMs; v.sample += c.sampleMs; v.refine += c.refineMs; v.finish += c.finishMs; v.video += c.videoMs;
    v.waited += (c.waitedUsualMs ?? 0) * c.renders;
    (c.hist ?? []).forEach((n, i) => { if (v.hist[i] !== undefined) v.hist[i] += n; });
  }
  return by;
}
