import type { BuiltGraph } from "@afflatus/core";
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
  const cliffAt = over.length ? over[0]!.work : null;
  let pace: Forecast["pace"];
  let stepMs: number;
  if (cliffAt !== null && work >= cliffAt) {
    pace = "over";
    stepMs = work * median(over.map(cost));
  } else {
    // the cost of the nearest usual renders by size, blended between the one below and the one above; past the largest, that one's
    const below = [...fine].reverse().find((p) => p.work <= work);
    const above = fine.find((p) => p.work >= work);
    const c = below && above && above.work > below.work ? cost(below) + ((cost(above) - cost(below)) * (work - below.work)) / (above.work - below.work) : cost(above ?? below ?? pts[0]!);
    stepMs = work * c;
    pace = work > fitsUpTo * 1.1 ? "untested" : "usual";
  }
  return { ms: Math.round(steps * stepMs + extraMs), pace, fitsUpTo, samples: pts.length };
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
  return forecastFrom(points, work, steps, finish + (loads.length ? median(loads) : 0));
}

/** The forecast as the form says it: a line, and, past the cliff, the words that go next to the setting that drives the size. */
export function said(f: Forecast, shape: { pixels: number; frames: number }): { text: string; hint: string | null } {
  const dur = f.ms < 90_000 ? `${Math.max(1, Math.round(f.ms / 1000))} s` : `${Math.round(f.ms / 60_000)} min`;
  const fits = shape.frames > 1 ? `${Math.floor(f.fitsUpTo / Math.max(1, shape.pixels))} frames at this size` : `about ${(f.fitsUpTo / 1e6).toFixed(1)} MP`;
  if (f.pace === "over") return { text: `About ${dur}: past where this model slowed down on your card before (up to ${fits} kept the usual pace).`, hint: `past where this model slowed down on your card: up to ${fits} kept the usual pace` };
  if (f.pace === "untested") return { text: `About ${dur}, if it keeps the pace of your renders with this model: none was this large yet.`, hint: null };
  return { text: `About ${dur}, from your renders with this model.`, hint: null };
}
