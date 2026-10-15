import { roughly, secondsOf, type BuiltGraph, type Recipe } from "@afflatus/core";
import type { Db } from "./db";

/**
 * What a render will take, learned from the renders this machine has done with the same model: nothing is
 * assumed about the card. Each past render is a point (how much it sampled per step, what a step cost);
 * a card that runs out of memory for a size does not slow down gradually, it starts streaming the model's
 * weights and a step costs several times more, so the points split into those at the usual pace and those
 * past that cliff, and a form is placed against both.
 */

/** The sampled work of a graph: its largest canvas in pixels, how many frames of it (1 for a picture), and the steps. */
export function workOf(built: BuiltGraph): { pixels: number; frames: number; steps: number } {
  let pixels = 0;
  let frames = 1;
  for (const node of Object.values(built.graph)) {
    const i = node.inputs;
    const w = i.width;
    const h = i.height;
    if (typeof w === "number" && typeof h === "number" && w * h > pixels) pixels = w * h;
    for (const key of ["length", "frames", "num_frames", "video_frames", "frame_count"]) {
      const v = i[key];
      if (typeof v === "number" && v > frames) frames = v;
    }
  }
  // the recipe's own count wins: its nodes may count frames in their own terms (a continuation window), or not at all (a latent loaded from a file)
  return { pixels, frames: built.frames && built.frames > 0 ? built.frames : frames, steps: Math.max(1, built.totalSteps) };
}

/** One sampled chunk of a part made in chunks: its work per step (pixels × its frames) and its steps. */
export interface Chunk {
  work: number;
  steps: number;
}

/**
 * The chunks a graph samples, when its passes say their frames (a Motion transfer part, made in one chunk or several: one
 * carried on from the clip before runs into a short last chunk); null for a graph whose passes do not say them. The work
 * recorded of a render stays its largest chunk's, the one its measured step (the first pass's) is the pace of.
 */
export function chunksOf(built: BuiltGraph, pixels: number): Chunk[] | null {
  const passes = built.passes ?? [];
  if (!passes.length || !pixels || !passes.every((p) => p.frames && p.frames > 0)) return null;
  return passes.map((p) => ({ work: pixels * p.frames!, steps: Math.max(1, p.steps) }));
}

/** What of a recorded render `workOfRow` reads. */
export interface RecordedWork {
  recipe_id: string;
  kind: "image" | "video" | "audio" | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  work: number | null;
}

/**
 * A recorded render's work as it is measured now. Until 2026-10-10 the frames of a graph whose nodes do not say them
 * plainly (H3's continuation window, a finish that loads its latent from a file) were not read: those renders were
 * recorded with the work of one frame, a hundred times too small, and taken at that they made the model's other renders
 * look a hundred times slower per unit of work. The rows are the owner's record and are not rewritten: a video whose
 * work is less than two of its own frames is read with its frames, from its length at its recipe's speed. Null when that
 * speed is not known (the row is then left out), or when the row has no work.
 */
export function workOfRow(r: RecordedWork, fpsOf: (recipeId: string) => number | undefined): number | null {
  if (r.work === null) return null;
  // a video is many frames, even sampled at a quarter of the size it is shown at (an upscale after it): less than two is none counted
  if (r.kind !== "video" || !r.width || !r.height || !r.duration_ms || r.work >= r.width * r.height * 2) return r.work;
  const fps = fpsOf(r.recipe_id);
  // its length is often read half a frame short (141 frames at 24 a second come out 5854 ms): a quarter of a frame up takes both
  return fps ? r.work * Math.max(1, Math.round((r.duration_ms * fps) / 1000 + 0.25)) : null;
}

/** One past render of a model: how much it sampled per step (pixels × frames), and what one step cost. */
export interface Point {
  work: number;
  stepMs: number;
}

export interface Forecast {
  ms: number;
  /** usual: within what this model rendered at its usual pace; untested: larger than any render so far, the pace assumed to hold; over: past where the card slowed down before. */
  pace: "usual" | "untested" | "over";
  /** The largest work that rendered at the usual pace. */
  fitsUpTo: number;
  samples: number;
  /** What loading the model adds, included in `ms`: 0 when it is the one in memory. A batch of renders loads it once. */
  loadMs: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** How many times the usual cost per unit of work a step must cost to count as past the cliff: a card streaming its weights costs three to four times. */
const OVER = 2;

/**
 * The forecast from the points alone: `extraMs` is what surrounds the sampling (finishing, the passes after, the load). A
 * part made in `chunks` is priced chunk by chunk, each at its own size (its pace and its fit are its largest's, `work`).
 */
export function forecastFrom(points: Point[], work: number, steps: number, extraMs: number, chunks?: readonly Chunk[] | null): Forecast | null {
  const pts = points.filter((p) => p.work > 0 && p.stepMs > 0).sort((a, b) => a.work - b.work);
  if (!pts.length || work <= 0) return null;
  const cost = (p: Point) => p.stepMs / p.work;
  // the usual cost per unit: the middle of the smaller half of the renders, which no card has trouble with
  const usual = median(pts.slice(0, Math.max(1, Math.ceil(pts.length / 2))).map(cost));
  const over = pts.filter((p) => cost(p) > OVER * usual);
  const fine = pts.filter((p) => cost(p) <= OVER * usual);
  const fitsUpTo = fine.length ? fine[fine.length - 1]!.work : 0;
  // a cliff is two slow renders or more, all larger than the largest at the usual pace: one slow render (the machine busy
  // with something else, a model loaded from a cold disk) or slow ones among usual ones of their size say nothing of the card
  const past = over.filter((p) => p.work > fitsUpTo);
  const cliffAt = past.length >= 2 ? past[0]!.work : null;
  /** What one step of this much work costs. */
  const stepAt = (w: number): number => {
    if (cliffAt !== null && w >= cliffAt) return w * median(past.map(cost));
    // the cost of the nearest usual renders by size, blended between the one below and the one above; past the largest, that one's
    const below = [...fine].reverse().find((p) => p.work <= w);
    const above = fine.find((p) => p.work >= w);
    const c = below && above && above.work > below.work ? cost(below) + ((cost(above) - cost(below)) * (w - below.work)) / (above.work - below.work) : cost(above ?? below ?? pts[0]!);
    return w * c;
  };
  const pace: Forecast["pace"] = cliffAt !== null && work >= cliffAt ? "over" : work > fitsUpTo * 1.1 ? "untested" : "usual";
  const sampling = chunks?.length ? chunks.reduce((sum, c) => sum + c.steps * stepAt(c.work), 0) : steps * stepAt(work);
  return { ms: Math.round(sampling + extraMs), pace, fitsUpTo, samples: pts.length, loadMs: 0 };
}

/** What a form is besides its work: what tells the renders like it from the model's others. */
export interface Like {
  /** Its recipe: an upscale or a fix-face with a model is not priced like its text-to-picture. */
  recipeId?: string;
  /** Its settings that decide the time (core's timeKey): what surrounds its steps (the passes after them, the finishing) is theirs. */
  timeKey?: string;
  /** Its model's family: a model never loaded cold here is taken to load like the others of its family. */
  family?: string;
  /** A recipe's frames a second, to read the renders recorded before every video's frames were (workOfRow); left out, those are left out. */
  fps?: (recipeId: string) => number | undefined;
  /** Whether it samples a picture of its own first (its graph has a sampling phase); left out, it is not told. */
  samples?: boolean;
  /** The chunks it samples, each at its own size (chunksOf); left out, its `steps` all sample `work`. */
  chunks?: readonly Chunk[] | null;
  /**
   * The machine it would render on (settings.ts `machines`): its own renders of the recipe as soon as it has one, else the
   * renders of the machine that rendered it most, at its pace against that one's (`paces`, onMachine). Left out, every
   * machine's renders as they are.
   */
  machine?: string | null;
  /** Each machine's learned pace (machinePaces), to read another machine's renders at `machine`'s pace. */
  paces?: ReadonlyMap<string, number>;
}

/** What of a recorded render `onMachine` reads and scales. */
interface Timed {
  machine_id: string | null;
  recipe_id: string;
  step_ms: number | null;
  total_ms: number;
  load_ms: number;
  sample_ms: number;
  refine_ms: number;
}

/**
 * The renders a forecast for `like.machine` is read from. Its own renders of the recipe (with its others of the model) as
 * soon as it has one: two windows on a rented A40 (214 and 225 s) say more of the next one there than a dozen on the
 * owner's 4070 Ti. Before that, the renders of the machine that rendered it most (this computer, as a rule), at this
 * machine's pace against that one's (machinePaces, learned on the models both rendered); as they are when this machine's
 * pace is not known yet. The load is left as it was: it is the disk's, not the card's. No machine asked: every render as
 * it is.
 */
export function onMachine<R extends Timed>(rows: R[], like: Pick<Like, "machine" | "paces" | "recipeId">): R[] {
  const machine = like.machine;
  if (!machine) return rows;
  const ofRecipe = (rs: R[]) => (like.recipeId ? rs.filter((r) => r.recipe_id === like.recipeId) : rs);
  const mine = rows.filter((r) => r.machine_id === machine);
  if (ofRecipe(mine).length) return mine;
  // the machine with the most renders of the recipe (else of the model); a tie goes to the one that rendered last
  const counted = ofRecipe(rows).length ? ofRecipe(rows) : rows;
  const counts = new Map<string | null, number>();
  for (const r of counted) counts.set(r.machine_id, (counts.get(r.machine_id) ?? 0) + 1);
  const most = [...counts].reduce<[string | null, number] | null>((best, c) => (!best || c[1] > best[1] ? c : best), null)?.[0] ?? null;
  const theirs = rows.filter((r) => r.machine_id === most);
  const target = like.paces?.get(machine);
  const from = most === null ? undefined : like.paces?.get(most);
  if (target === undefined || from === undefined) return theirs;
  const k = target / from;
  return theirs.map((r) => ({ ...r, step_ms: r.step_ms === null ? null : r.step_ms * k, total_ms: r.load_ms + (r.total_ms - r.load_ms) * k, sample_ms: r.sample_ms * k, refine_ms: r.refine_ms * k }));
}

/** What this model's past renders say about a render of `work` sampled over `steps`, with its model to load or already in memory. */
export async function forecast(db: Db, modelFile: string, work: number, steps: number, cold: boolean, like: Like = {}): Promise<Forecast | null> {
  if (!modelFile) return null;
  const found = await db
    .selectFrom("render_stats")
    .select(["machine_id", "recipe_id", "time_key", "kind", "width", "height", "duration_ms", "work", "steps", "step_ms", "total_ms", "sample_ms", "refine_ms", "load_ms", "cold"])
    .where("model_file", "=", modelFile)
    .where("status", "=", "done")
    .where("whole", "=", 1)
    .where("step_ms", "is not", null)
    .where("work", "is not", null)
    .orderBy("created_at", "desc")
    .limit(200)
    .execute();
  const fps = like.fps ?? (() => undefined);
  const all = onMachine(found.flatMap((r) => {
    const w = workOfRow(r, fps);
    return w ? [{ ...r, work: w }] : [];
  }), like);
  // a render that samples nothing of its own (a finish re-sampling a draft's latent, a sharper pass over a picture) spends its
  // steps in the passes after, and is priced from the renders like it: next to a draft's, its steps read nothing alike
  const kin = like.samples === undefined ? all : all.filter((r) => (r.sample_ms > 0) === like.samples);
  const rows = kin.length ? kin : all;
  if (!rows.length) return null;
  // the renders of the same recipe when there are enough of them: the model's others sample something else per step
  // (an upscale re-samples tiles of a larger picture), and placed among them a form read like theirs
  const own = like.recipeId ? rows.filter((r) => r.recipe_id === like.recipeId) : [];
  const keyed = like.timeKey ? own.filter((r) => r.time_key === like.timeKey) : [];
  const pool = own.length >= OWN_POINTS ? own : rows;
  const points = pool.map((r) => ({ work: r.work, stepMs: r.step_ms! }));
  // what surrounds the steps (the finishing, the passes after them, what a step does not count) is the settings' own: from
  // the renders with the same ones, else the recipe's, else the model's, as usualParts tells it for the running render: it is
  // what each took beyond its steps and its load, so that its passes after are not counted twice, as steps and again as a
  // pass. A recipe made in chunks counts every chunk's steps at its first chunk's pace (the one its step measures): with a
  // short last chunk that is more than its sampling took, and what surrounds the steps read as nothing; its sampling is taken then
  const stepped = (r: (typeof rows)[number]) => {
    const counted = Math.max(1, r.steps) * r.step_ms!;
    return like.chunks && r.sample_ms > 0 ? Math.min(counted, r.sample_ms + r.refine_ms) : counted;
  };
  const around = median((keyed.length ? keyed : own.length ? own : rows).map((r) => r.total_ms - r.load_ms - stepped(r)));
  // and what comes before the first step: what even a model in memory spends (the text, the pictures), and with the
  // model to load, that load. A model never loaded cold here is taken to load as the family's others did, else any
  // model: left out, the cold forecast said less than the same form with the model in memory
  const warmLoads = pool.filter((r) => !r.cold).map((r) => r.load_ms);
  const warm = warmLoads.length ? median(warmLoads) : 0;
  let load = warm;
  if (cold) {
    const coldLoads = [pool, rows].map((rs) => rs.filter((r) => r.cold).map((r) => r.load_ms)).find((ls) => ls.length) ?? (await coldLoadsElsewhere(db, like.family));
    load = Math.max(warm, coldLoads.length ? median(coldLoads) : 0);
  }
  const f = forecastFrom(points, work, steps, Math.max(0, around) + load, like.chunks);
  // what the load adds over what a model in memory still spends before its first step
  return f && cold ? { ...f, loadMs: Math.round(load - warm) } : f;
}

/** The loads of the latest renders that loaded their model cold: of the family's models, else of any. */
async function coldLoadsElsewhere(db: Db, family: string | undefined): Promise<number[]> {
  const of = (fam: string | null) => {
    let q = db.selectFrom("render_stats").select("load_ms").where("status", "=", "done").where("whole", "=", 1).where("cold", "=", 1).where("model_file", "!=", "");
    if (fam) q = q.where("family", "=", fam);
    return q.orderBy("created_at", "desc").limit(50).execute();
  };
  const ofFamily = family ? await of(family) : [];
  return (ofFamily.length ? ofFamily : await of(null)).map((r) => r.load_ms);
}

/** How many renders of a recipe its own points are taken from alone: with fewer, the model's others say more. */
const OWN_POINTS = 3;

/**
 * What renders queued one after another take in all, from each one's forecast (its `ms` with its `loadMs`) and `times`
 * renders of each: a model loads for the first of a run of renders with it, and the others find it in memory. A part
 * with no model (a tool on the GPU) frees it: the render after loads its own again.
 */
export function inARow(parts: Array<{ ms: number; loadMs: number; model: string; times?: number }>): number {
  let total = 0;
  let held = "";
  for (const p of parts) {
    const load = p.model && p.model === held ? 0 : p.loadMs;
    total += (p.ms - p.loadMs) * Math.max(1, p.times ?? 1) + load;
    held = p.model;
  }
  return total;
}

// ---------------------------------------------------------------- where no render of the model was measured yet

/**
 * Per recipe, the usual time of one job and, for videos, of one second of video, from what was rendered
 * before (the generations, kept since before render times were recorded). Only what `forecast` falls back on
 * for a form it cannot place (a tool with no steps, a model not measured yet): never a figure of its own.
 */
export interface Rate {
  /** The usual time of one job, in milliseconds. */
  perJobMs: number;
  /** Of a video recipe: the usual time for one second of video. */
  perSecondMs: number | null;
  /** How many past renders this rests on. */
  samples: number;
}

/** How many past renders the fallback looks at: the recent ones say more about the machine as it is now. */
const LOOK_BACK = 400;

export async function rates(db: Db): Promise<Record<string, Rate>> {
  const rows = await db
    .selectFrom("generations")
    .innerJoin("assets", "assets.generation_id", "generations.id")
    .select(["generations.id", "generations.recipe_id", "generations.gen_ms", "assets.kind", "assets.duration_ms"])
    .orderBy("generations.created_at", "desc")
    .limit(LOOK_BACK)
    .execute();
  const seen = new Set<string>();
  const byRecipe = new Map<string, { jobs: number[]; perSecond: number[] }>();
  for (const r of rows) {
    // a job that gave several results is one render
    if (seen.has(r.id) || r.gen_ms <= 0) continue;
    seen.add(r.id);
    const at = byRecipe.get(r.recipe_id) ?? { jobs: [], perSecond: [] };
    at.jobs.push(r.gen_ms);
    if (r.kind === "video" && r.duration_ms && r.duration_ms > 0) at.perSecond.push(r.gen_ms / (r.duration_ms / 1000));
    byRecipe.set(r.recipe_id, at);
  }
  return Object.fromEntries([...byRecipe].map(([id, v]) => [id, { perJobMs: Math.round(median(v.jobs)), perSecondMs: v.perSecond.length ? Math.round(median(v.perSecond)) : null, samples: v.jobs.length }]));
}

/** The fallback as a forecast: the recipe's usual job, or its usual pace times the video's seconds; null when it never rendered. */
export function fromRates(all: Record<string, Rate>, recipe: Recipe<any>, input: Record<string, unknown>): Forecast | null {
  const rate = all[recipe.id];
  if (!rate) return null;
  const seconds = secondsOf(recipe.inputs, input);
  const ms = rate.perSecondMs && seconds ? Math.round(rate.perSecondMs * seconds) : rate.perJobMs;
  return { ms, pace: "usual", fitsUpTo: 0, samples: rate.samples, loadMs: 0 };
}

/** The forecast as the form says it: a line, and, past the cliff, the words that go next to the setting that drives the size. */
export function said(f: Forecast, shape: { pixels: number; frames: number }): { text: string; hint: string | null } {
  // rounded as the Generate button rounds it (core's roughly): the two say one figure
  const dur = roughly(f.ms);
  const fits = shape.frames > 1 ? `${Math.floor(f.fitsUpTo / Math.max(1, shape.pixels))} frames at this size` : `about ${(f.fitsUpTo / 1e6).toFixed(1)} MP`;
  if (f.pace === "over") return { text: `About ${dur}: past where this model slowed down on your card before (up to ${fits} kept the usual pace).`, hint: `past where this model slowed down on your card: up to ${fits} kept the usual pace` };
  if (f.pace === "untested") return { text: `About ${dur}, if it keeps the pace of your renders with this model: none was this large yet.`, hint: null };
  if (!f.fitsUpTo) return { text: `About ${dur}, from your renders of this kind.`, hint: null };
  return { text: `About ${dur}, from your renders with this model.`, hint: null };
}

/**
 * Each machine's pace against all of them (settings.ts `machines`), learned from its own renders: for every model and set
 * of settings rendered on more than one machine, a machine's usual step against the usual step of all, and the middle of
 * those. 1 is the common pace, 2 half as fast; a machine with nothing to compare is taken at 1. The forecasts are read from
 * every machine's renders together, and a machine's is that times its pace.
 */
/** How many renders of the same settings a machine needs before its pace is set against another's. */
const PACE_RENDERS = 3;

export async function machinePaces(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("render_stats")
    .select(["machine_id", "model_file", "time_key", "step_ms"])
    .where("status", "=", "done")
    .where("whole", "=", 1)
    .where("step_ms", "is not", null)
    .where("machine_id", "is not", null)
    .where("model_file", "!=", "")
    .orderBy("created_at", "desc")
    .limit(600)
    .execute();
  const byKey = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    const key = `${r.model_file}\n${r.time_key}`;
    const machines = byKey.get(key) ?? new Map<string, number[]>();
    byKey.set(key, machines);
    const steps = machines.get(r.machine_id!) ?? [];
    steps.push(r.step_ms!);
    machines.set(r.machine_id!, steps);
  }
  // a machine is compared on the settings it rendered a few times: one render (a model loaded cold, the card busy elsewhere)
  // made the owner's own PC read 1.8 times slower than a pod and every estimate on it nearly doubled
  for (const machines of byKey.values()) for (const [machine, steps] of machines) if (steps.length < PACE_RENDERS) machines.delete(machine);
  const ratios = new Map<string, number[]>();
  for (const machines of byKey.values()) {
    if (machines.size < 2) continue;
    const all = median([...machines.values()].flat());
    if (!(all > 0)) continue;
    for (const [machine, steps] of machines) ratios.set(machine, [...(ratios.get(machine) ?? []), median(steps) / all]);
  }
  return new Map([...ratios].map(([machine, rs]) => [machine, median(rs)]));
}

/**
 * Each GPU's pace against all of them, by its name as ComfyUI gave it (render_stats.gpu), as machinePaces does for the
 * machines, with how many renders it rests on: what the GPU hunt (hunt.ts) ranks RunPod's GPUs by. With one GPU rendered
 * on, it is the common pace (1); a GPU with nothing to compare to the others is taken at 1 too.
 */
export async function gpuPaces(db: Db): Promise<Array<{ gpu: string; pace: number; renders: number }>> {
  const rows = await db
    .selectFrom("render_stats")
    .select(["gpu", "model_file", "time_key", "step_ms"])
    .where("status", "=", "done")
    .where("whole", "=", 1)
    .where("step_ms", "is not", null)
    .where("gpu", "is not", null)
    .where("model_file", "!=", "")
    .orderBy("created_at", "desc")
    .limit(600)
    .execute();
  const counts = new Map<string, number>();
  const byKey = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    counts.set(r.gpu!, (counts.get(r.gpu!) ?? 0) + 1);
    const key = `${r.model_file}\n${r.time_key}`;
    const gpus = byKey.get(key) ?? new Map<string, number[]>();
    byKey.set(key, gpus);
    gpus.set(r.gpu!, [...(gpus.get(r.gpu!) ?? []), r.step_ms!]);
  }
  const ratios = new Map<string, number[]>();
  for (const gpus of byKey.values()) {
    if (gpus.size < 2) continue;
    const all = median([...gpus.values()].flat());
    if (!(all > 0)) continue;
    for (const [gpu, steps] of gpus) ratios.set(gpu, [...(ratios.get(gpu) ?? []), median(steps) / all]);
  }
  return [...counts].map(([gpu, renders]) => ({ gpu, pace: ratios.has(gpu) ? median(ratios.get(gpu)!) : 1, renders }));
}
