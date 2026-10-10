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
  return { pixels, frames, steps: Math.max(1, built.totalSteps) };
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

/** The forecast from the points alone: `extraMs` is what surrounds the sampling (finishing, the passes after, the load). */
export function forecastFrom(points: Point[], work: number, steps: number, extraMs: number): Forecast | null {
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
  let pace: Forecast["pace"];
  let stepMs: number;
  if (cliffAt !== null && work >= cliffAt) {
    pace = "over";
    stepMs = work * median(past.map(cost));
  } else {
    // the cost of the nearest usual renders by size, blended between the one below and the one above; past the largest, that one's
    const below = [...fine].reverse().find((p) => p.work <= work);
    const above = fine.find((p) => p.work >= work);
    const c = below && above && above.work > below.work ? cost(below) + ((cost(above) - cost(below)) * (work - below.work)) / (above.work - below.work) : cost(above ?? below ?? pts[0]!);
    stepMs = work * c;
    pace = work > fitsUpTo * 1.1 ? "untested" : "usual";
  }
  return { ms: Math.round(steps * stepMs + extraMs), pace, fitsUpTo, samples: pts.length, loadMs: 0 };
}

/** What this model's past renders say about a render of `work` sampled over `steps`, with its model to load or already in memory. */
export async function forecast(db: Db, modelFile: string, work: number, steps: number, cold: boolean): Promise<Forecast | null> {
  if (!modelFile) return null;
  const rows = await db
    .selectFrom("render_stats")
    .select(["work", "step_ms", "finish_ms", "refine_ms", "load_ms", "cold"])
    .where("model_file", "=", modelFile)
    .where("status", "=", "done")
    .where("whole", "=", 1)
    .where("step_ms", "is not", null)
    .where("work", "is not", null)
    .orderBy("created_at", "desc")
    .limit(200)
    .execute();
  if (!rows.length) return null;
  const points = rows.map((r) => ({ work: r.work!, stepMs: r.step_ms! }));
  // what surrounds the sampling: the finishing and any pass after it, and the load when the model is not the one in memory
  const finish = median(rows.map((r) => r.finish_ms + r.refine_ms));
  const loads = rows.filter((r) => Boolean(r.cold) === cold).map((r) => r.load_ms);
  const f = forecastFrom(points, work, steps, finish + (loads.length ? median(loads) : 0));
  if (!f || !cold || !loads.length) return f;
  // what the load adds over what a model in memory still spends before its first step (the text, the pictures)
  const warm = rows.filter((r) => !r.cold).map((r) => r.load_ms);
  return { ...f, loadMs: Math.round(Math.max(0, median(loads) - (warm.length ? median(warm) : 0))) };
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
