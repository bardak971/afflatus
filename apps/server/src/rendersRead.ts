import type { Db, Tables } from "./db";
import type { Registry } from "./registry";
import { shortGpu } from "@afflatus/core";
import { machinePaces } from "./forecast";
import { buildOf } from "./podImage";
import { cellOf, DAY, dayOf, dayStart, digestedThrough, digestOf, machineDigestedThrough, groupKey, median, merge, parseDigest, real, spilled, sum, WHOLE_DAY, BUCKETS, type Cell, type Digest, type Line, type RenderRow, type Setting } from "./renderDigests";

/**
 * The record of render times read: the "Render times" tab's summary and list of renders (`summary`, `list`), how much
 * room the record takes, and the record summed up for /metrics (`tallyByRecipe`). A summary by days reads each past day
 * from its digest (renderDigests.ts), so that only today's rows are worked out again on every call.
 */

/** The grain of the stretch the figures cover (`spanMs`). */
const MINUTE = 60_000;
export const OUT_OF_MEMORY = /out of memory|\boom\b|allocat|not enough memory/i;
/**
 * The failed renders among `rows` that ran out of memory (OOM): their job's error says so. A job no longer kept is
 * not counted: a full memory alone does not say why a render failed. In slices: SQLite takes so many values in one `in`.
 */
export async function outOfMemory(db: Db, rows: Array<Pick<RenderRow, "id" | "status">>): Promise<Set<string>> {
  const failed = rows.filter((r) => r.status === "failed");
  const errors = new Map<string, string | null>();
  for (let i = 0; i < failed.length; i += 400) {
    const ids = failed.slice(i, i + 400).map((r) => r.id);
    for (const j of await db.selectFrom("jobs").select(["id", "error"]).where("id", "in", ids).execute()) errors.set(j.id, j.error);
  }
  return new Set(failed.filter((r) => OUT_OF_MEMORY.test(errors.get(r.id) ?? "")).map((r) => r.id));
}

/** What a render would have taken with its model already loaded: what loading added, beyond what even a loaded model spends before its first step, taken off. */
const warmMs = (r: Pick<RenderRow, "cold" | "total_ms" | "load_ms">, usualStart: number) => (r.cold ? r.total_ms - Math.max(0, r.load_ms - usualStart) : r.total_ms);

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
  "tool.finish.seedvr": "Finish · SeedVR2", "tool.finish.rtx": "Finish · RTX", "tool.finish.model": "Finish · upscale model", "tool.finish.face": "Finish · Face refine", "tool.slow": "Slow motion · RIFE",
};
export const nameOf = (registry: Registry, recipeId: string) => {
  if (TOOL_NAMES[recipeId]) return TOOL_NAMES[recipeId]!;
  const recipe = registry.recipe(recipeId);
  if (!recipe) return recipeId;
  const family = registry.family(recipe.family)?.name;
  return !family || recipe.title.toLowerCase().startsWith(family.toLowerCase()) ? recipe.title : `${family} · ${recipe.title}`;
};

/** The parts of a render's time, as they are drawn. */
const parts = (c: Cell) => ({ loading: c.loadMs, sampling: c.sampleMs, refining: c.refineMs, finishing: c.finishMs });

/** `paced`: each machine's learned pace, as the queue keeps it (renders-api.ts); left out, worked out from the record. */
export async function summary(db: Db, registry: Registry, period: Period | Window, keepDays: number, when = Date.now(), machine: string | null = null, paced: () => Promise<ReadonlyMap<string, number>> = () => machinePaces(db)) {
  const first = (await db.selectFrom("render_stats").select((eb) => eb.fn.min("created_at").as("at")).executeTakeFirst())?.at ?? null;
  const firstDay = (await db.selectFrom("render_days").select((eb) => eb.fn.min("day").as("day")).executeTakeFirst())?.day ?? null;
  const since = firstDay ? `${firstDay}T00:00:00.000Z` : first;
  const { start, end, step, times } = windowOf(period, since, when);
  const index = (ms: number) => Math.floor((ms - start) / step);
  const iso = (ms: number) => new Date(ms).toISOString();

  // cut into days, the days over are read from their digests, and only the rows after them (today's) are read whole;
  // bounded at the end too: a window in the past counts nothing that came after it
  // one machine's figures (settings.ts `machines`): from its own days' digests and its renders one by one, as long as they
  // are kept so (the folded figures are of every machine together)
  const through = step !== DAY ? null : machine ? await machineDigestedThrough(db) : await digestedThrough(db);
  const rowsFrom = through ? Math.max(start, Date.parse(dayStart(through)) + DAY) : start;
  let rowsOf = db.selectFrom("render_stats").selectAll().where("created_at", ">=", iso(rowsFrom)).where("created_at", "<", iso(end));
  if (machine) rowsOf = rowsOf.where("machine_id", "=", machine);
  const rows = rowsFrom < end ? await rowsOf.orderBy("created_at", "desc").execute() : [];
  const days = { from: dayOf(iso(start)), to: dayOf(iso(Math.min(rowsFrom, end))) };
  const digested = rowsFrom <= start ? []
    : machine ? await db.selectFrom("render_machine_digests").select(["day", "digest"]).where("machine_id", "=", machine).where("day", ">=", days.from).where("day", "<", days.to).execute()
    : await db.selectFrom("render_digests").select(["day", "digest"]).where("day", ">=", days.from).where("day", "<", days.to).execute();
  const folded = step === DAY && !machine ? await db.selectFrom("render_days").selectAll().where("day", ">=", dayOf(iso(start))).execute() : [];

  // each stretch: the digest of its rows, and the figures of days that are no longer rows
  const ownRows = times.map(() => [] as RenderRow[]);
  for (const r of rows) ownRows[index(Date.parse(r.created_at))]?.push(r);
  const digests: Array<Digest | null> = ownRows.map((own) => (own.length ? digestOf(own) : null));
  for (const d of digested) {
    const i = index(Date.parse(dayStart(d.day)));
    if (i >= 0 && i < digests.length) digests[i] = parseDigest(machine ? `${d.day} ${machine}` : d.day, d.digest);
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
  // (they reached no machine: counted with every machine, not with one)
  const unsent = machine ? [] : await notRendered(db, start, end, keepDays, when);
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
  const prior = !machine && period !== "all" && since && Date.parse(since) <= priorFrom + Math.max(step, (end - start) / 10) ? await totals(db, priorFrom, start, step === DAY, keepDays, when) : null;
  // each machine's share of the window and its learned pace, from the renders kept one by one
  const shares = await db.selectFrom("render_stats").select(["machine_id", (eb) => eb.fn.countAll<number>().as("n"), (eb) => eb.fn.sum<number>("total_ms").as("ms")])
    .where("created_at", ">=", iso(start)).where("created_at", "<", iso(end)).groupBy("machine_id").execute();
  const paces = await paced();
  // a rented pod by the GPU it ran on (its last session's), for one terminated since: its id ("rp-abc…") said nothing
  const pods = shares.flatMap((m) => (m.machine_id ? [m.machine_id] : []));
  // and the CUDA build its image was, where it was kept (0080): a slower build on a GPU shows apart
  const gpus = new Map<string, string>();
  if (pods.length) {
    for (const r of await db.selectFrom("rent_sessions").select(["machine_id", "gpu", "image", "started_at"]).where("machine_id", "in", pods).where("gpu", "is not", null).orderBy("started_at").execute()) {
      const build = buildOf(r.image);
      gpus.set(r.machine_id, `${shortGpu(r.gpu!)} pod${build ? ` · CUDA ${build}` : ""}`);
    }
  }

  return {
    period: typeof period === "string" ? period : ("window" as const), from: start, to: end, step, times, keepDays, since, buckets,
    /** The machine the figures are of; null: every machine. */
    machine,
    /** Each machine that rendered in the window: how many renders, their GPU time, and its learned pace (1 the common pace, 2 half as fast; null: nothing to compare yet). */
    machines: shares.filter((m) => m.machine_id).map((m) => ({
      id: m.machine_id!, renders: Number(m.n), gpuMs: Number(m.ms ?? 0), pace: paces.get(m.machine_id!) ?? null,
      /** A rented pod's GPU ("A40 pod · CUDA 12.8"), for one no longer among the machines; null for a ComfyUI of its own. */
      name: gpus.get(m.machine_id!) ?? null,
    })),
    upscale,
    /**
     * The stretch of time the figures cover: the period, or since the first render when that is later. In whole minutes:
     * to the millisecond it changed on every call, and the summary was never the same twice for its ETag. Not in whole
     * steps: a first render 1 h 29 min ago made it one hour, and the GPU busy past 100 %.
     */
    spanMs: Math.max(MINUTE, Math.round((Math.min(end, when) - Math.max(start, since ? Date.parse(since) : start)) / MINUTE) * MINUTE),
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
/** The render summary as GET /api/renders/summary answers it: what the web's types are held against (test/apiTypes.test.ts). @internal */
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
 * A named period cut finer than days ends at the end of the stretch now is in: ending at the millisecond, its stretches
 * moved on every call, and the page's copy of "day" and "week" was never current (no 304) however little had changed.
 */
export function windowOf(period: Period | Window, since: string | null, when: number): { start: number; end: number; step: number; times: number[] } {
  const length = period === "day" ? DAY : period === "week" ? 7 * DAY : period === "month" ? 30 * DAY : 0;
  const win: Window = typeof period !== "string" ? { from: Math.min(period.from, period.to - 60_000), to: Math.min(period.to, when + 60_000) }
    : length ? { from: when - length, to: when }
    : { from: Math.min(when - DAY, since ? Date.parse(since) : when - DAY), to: when };
  const step = stepFor(win.to - win.from);
  const whole = step < DAY && length > 0;
  const end = step === DAY ? Date.parse(`${dayOf(new Date(win.to).toISOString())}T00:00:00.000Z`) + DAY : whole ? Math.ceil(when / step) * step : win.to;
  const count = whole ? length / step : Math.max(2, Math.min(730, Math.ceil((end - win.from) / step)));
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
export async function list(db: Db, registry: Registry, opts: { recipe?: string; trouble?: boolean; before?: string; limit?: number; from?: number; to?: number; machine?: string }) {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  let q = db.selectFrom("render_stats").selectAll();
  if (opts.recipe) q = q.where("recipe_id", "=", opts.recipe);
  if (opts.trouble) q = q.where("status", "!=", "done");
  if (opts.from) q = q.where("created_at", ">=", new Date(opts.from).toISOString());
  if (opts.to) q = q.where("created_at", "<", new Date(opts.to).toISOString());
  if (opts.machine) q = q.where("machine_id", "=", opts.machine);
  let counted = db.selectFrom("render_stats").select((eb) => eb.fn.countAll<number>().as("n"));
  if (opts.recipe) counted = counted.where("recipe_id", "=", opts.recipe);
  if (opts.trouble) counted = counted.where("status", "!=", "done");
  if (opts.from) counted = counted.where("created_at", ">=", new Date(opts.from).toISOString());
  if (opts.to) counted = counted.where("created_at", "<", new Date(opts.to).toISOString());
  if (opts.machine) counted = counted.where("machine_id", "=", opts.machine);
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
      /** The machine it ran on (settings.ts `machines`); null for a render from before there could be several that was not filed under the first. */
      machine: r.machine_id ?? null,
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
