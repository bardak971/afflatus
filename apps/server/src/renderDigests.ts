import type { Kysely, Selectable } from "kysely";
import type { Tables } from "./db";

/**
 * The figures of renders taken together, and the days over digested: a `Cell` is what some renders add up to (one model
 * on one day, a stretch of a chart), and a day's digest (`digestDays`) is what a summary reads of that day's rows,
 * written once the day is over. The record itself is written by renders.ts and read by rendersRead.ts.
 */

/** A render's row as the figures read it: when its job took the machine (0088) is Costs' alone, and older rows have none. */
export type RenderRow = Omit<Selectable<Tables["render_stats"]>, "started_at"> & { started_at?: string | null };

export const DAY = 86_400_000;
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const at = (values: number[], q: number): number | null => {
  const s = sorted(values);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))]! : null;
};
/**
 * The middle of the values: of an even count, the mean of its two middle ones, as the forecast reads it (forecast.ts). The
 * upper one alone said 11.6 s for renders of 6.2 and 11.6 s, and a usual boot of 20 min for boots of 5 and 20.
 */
export const median = (values: number[]): number | null => {
  const s = sorted(values);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const real = (values: Array<number | null>): number[] => values.filter((v): v is number => v !== null && Number.isFinite(v));
/** The middle of values that each stand for several renders: what the middle of all of them would about be. */
export function weighted(pairs: Array<[number | null, number]>, q = 0.5): number | null {
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

/**
 * Ran out of video memory, as far as the figures can tell: the memory was full (ComfyUI fills it with any large model, so that
 * alone says nothing) and it took at least twice what was expected of it. The card then works out of system memory at a
 * fraction of its pace (a 6-minute SeedVR2 clip past 20 minutes, 2026-10-08). A failure is not counted; a stop is.
 */
export const spilled = (r: Pick<RenderRow, "status" | "vram_peak" | "expected_ms" | "total_ms">) =>
  r.status !== "failed" && r.vram_peak !== null && r.vram_peak >= 95 && r.expected_ms !== null && r.expected_ms > 0 && r.total_ms >= 2 * r.expected_ms;

/** The day as a whole, among the rows of `render_days`. */
export const WHOLE_DAY = "*";
export const dayOf = (iso: string) => iso.slice(0, 10);

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
export interface Digest {
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
export interface Line {
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
export interface Setting {
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

export const groupKey = (recipe: string, file?: string) => (file === undefined ? recipe : `${recipe}\n${file}`);
export const dayStart = (day: string) => `${day}T00:00:00.000Z`;
const megapixels = (r: Pick<RenderRow, "width" | "height">) => (r.width && r.height ? (r.width * r.height) / 1e6 : 0);
const hiresPace = (r: RenderRow) => (r.kind === "image" && /hires=true/.test(r.time_key) && r.refine_ms && megapixels(r) ? r.refine_ms / 1000 / megapixels(r) : null);

/** The digest of some rows, newest first. */
export function digestOf(rows: RenderRow[]): Digest {
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
export function parseDigest(day: string, text: string): Digest {
  const had = parsed.get(day);
  if (had?.text === text) return had.digest;
  const digest = JSON.parse(text) as Digest;
  parsed.set(day, { text, digest });
  return digest;
}

/** The last day digested. Every day before it that is still rows has its digest: days are digested oldest first, and fold away with their rows. */
export async function digestedThrough(db: Kysely<Tables>): Promise<string | null> {
  return (await db.selectFrom("render_digests").select((eb) => eb.fn.max("day").as("day")).executeTakeFirst())?.day ?? null;
}

/**
 * The last day digested machine by machine. Every day before it that is still rows has a digest for each machine that
 * rendered then (a machine with none on a day had no render that day); a day of renders on no machine has none.
 */
export async function machineDigestedThrough(db: Kysely<Tables>): Promise<string | null> {
  return (await db.selectFrom("render_machine_digests").select((eb) => eb.fn.max("day").as("day")).executeTakeFirst())?.day ?? null;
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
  await digestMachines(db, today, again);
}

/**
 * The same days digested for each machine on its own (one machine's summary, rendersRead.ts), from the last day so
 * digested: one machine's "all" read every row it had kept on each call. Its own last day, apart from the days of every
 * machine together: the days digested before there were machine digests are digested so at the first fold after.
 */
async function digestMachines(db: Kysely<Tables>, today: string, again?: string): Promise<void> {
  const through = await machineDigestedThrough(db);
  const rowsOf = (from: string | null, to: string) => {
    let q = db.selectFrom("render_stats").selectAll().where("machine_id", "is not", null).where("created_at", "<", to);
    if (from) q = q.where("created_at", ">=", from);
    return q.orderBy("created_at", "desc").execute();
  };
  const rows = await rowsOf(through ? new Date(Date.parse(dayStart(through)) + DAY).toISOString() : null, dayStart(today));
  if (again && through && again <= through && again < today) rows.push(...(await rowsOf(dayStart(again), new Date(Date.parse(dayStart(again)) + DAY).toISOString())));
  const days = new Map<string, Map<string, RenderRow[]>>();
  for (const r of rows) {
    const day = dayOf(r.created_at);
    const machines = days.get(day) ?? days.set(day, new Map()).get(day)!;
    const list = machines.get(r.machine_id!);
    if (list) list.push(r);
    else machines.set(r.machine_id!, [r]);
  }
  // oldest day first, as the days of every machine, and a day's machines in one statement: a stop half way leaves every
  // day up to the last one written digested for each of its machines
  for (const day of [...days.keys()].sort()) {
    const values = [...days.get(day)!].map(([machine_id, own]) => ({ day, machine_id, digest: JSON.stringify(digestOf(own)) }));
    await db.insertInto("render_machine_digests").values(values).onConflict((oc) => oc.columns(["day", "machine_id"]).doUpdateSet((eb) => ({ digest: eb.ref("excluded.digest") }))).execute();
  }
}
