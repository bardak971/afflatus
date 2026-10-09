import type { Clip, Measure } from "../api";
import { SHOWS } from "./attention";

/**
 * How far a take's look has slid along its run: the clips joined one after the other ("continue"), from the
 * first of them, the run's start. Against the clip just before (the hop) and against the run's start (the whole
 * slide). Read by the hover card over the track and by the Inspector's Look card, so that both say the same.
 * Kept apart so that all of it is tested without a browser.
 */

/**
 * Past these, a change shows. A few per cent is the model's own variation; a chain continued from exact latents
 * drifts darker and softer clip after clip. Pace: H3 slows down after each hand-over, and a slower clip than
 * -15 % reads as slow motion. Colour: the distance moved in U/V (0 to 255 chroma), past 3 a cast shows.
 * Run-up end: past ×3 the model stepped away from its guide, and the join shows (SHOWS, as every join figure).
 */
export const DRIFT = { luma: -0.08, sharp: -0.15, pace: -0.15, colour: 3, handover: SHOWS } as const;

type Joined = Pick<Clip, "joined">;

/** The first clip of the run `index` is in: itself when it does not continue the clip before. */
export function runStart(clips: Joined[], index: number): number {
  let k = index;
  while (k > 0 && clips[k]!.joined === "continue") k--;
  return k;
}

/** The last clip of the run `index` is in. */
export function runEnd(clips: Joined[], index: number): number {
  let k = index;
  while (k + 1 < clips.length && clips[k + 1]!.joined === "continue") k++;
  return k;
}

/** A change from `b` to `a`, as a part of `b` (-0.32: a third less); `floor` keeps a tiny `b` from blowing it up. Null when either is missing. */
export function change(a: number | null | undefined, b: number | null | undefined, floor = 1): number | null {
  return a == null || b == null ? null : (a - b) / Math.max(floor, Math.abs(b));
}

/** "−32 %", "+1 %"; the minus is a real one. */
export const pct = (x: number) => `${x < 0 && Math.round(x * 100) !== 0 ? "−" : "+"}${Math.round(Math.abs(x) * 100)} %`;

/** "+0.4", "−1.2". */
export const signed = (x: number, digits = 1) => `${x < 0 && Number(Math.abs(x).toFixed(digits)) !== 0 ? "−" : "+"}${Math.abs(x).toFixed(digits)}`;

/** How far the colour moved, in U/V; null without chroma on either. */
export function colourShift(a: Measure | null | undefined, b: Measure | null | undefined): number | null {
  return a?.chroma && b?.chroma ? Math.hypot(a.chroma.u - b.chroma.u, a.chroma.v - b.chroma.v) : null;
}

/** The three figures a drift is read on, against one other take: brightness, sharpness, pace (parts of it), colour (a distance). */
export interface Against {
  luma: number | null;
  sharp: number | null;
  pace: number | null;
  colour: number | null;
}

export function against(m: Measure, other: Measure | null | undefined): Against {
  return {
    luma: change(m.luma, other?.luma),
    sharp: change(m.sharp, other?.sharp, 0.01),
    pace: change(m.pace, other?.pace, 0.1),
    colour: colourShift(m, other),
  };
}

/** A figure past its threshold: a warning. */
export function past(what: keyof Against, x: number | null): boolean {
  if (x == null) return false;
  return what === "colour" ? x > DRIFT.colour : x < DRIFT[what];
}

export interface Drift {
  /** The run's first clip, from 0. */
  start: number;
  /** The clip just before, from 0. */
  before: number;
  /** The clip before is the run's start: one column says both. */
  same: boolean;
  /** Against the clip before and against the run's start; a figure is null where a take was not measured. */
  hop: Against;
  whole: Against;
}

/**
 * How the take that plays on clip `index` stands against the clip before and the run's start. Null when the clip
 * does not continue the one before, or its take carries no measure.
 */
export function driftOf(clips: Array<Pick<Clip, "joined" | "take">>, index: number): Drift | null {
  const m = clips[index]?.take?.measure;
  if (!m || index === 0 || clips[index]!.joined !== "continue") return null;
  const start = runStart(clips, index);
  const before = index - 1;
  return {
    start,
    before,
    same: before === start,
    hop: against(m, clips[before]?.take?.measure),
    whole: against(m, clips[start]?.take?.measure),
  };
}

/** The header's warning: "darker, softer than clip 1"; against the run's start first, else against the clip before. Null when nothing is past. */
export function driftWords(d: Drift | null): string | null {
  if (!d) return null;
  const words = (a: Against) => [past("luma", a.luma) && "darker", past("sharp", a.sharp) && "softer", past("pace", a.pace) && "slower", past("colour", a.colour) && "tinted"].filter(Boolean).join(", ");
  const whole = words(d.whole);
  if (whole) return `${whole} than clip ${d.start + 1}`;
  const hop = words(d.hop);
  return hop ? `${hop} than clip ${d.before + 1}` : null;
}

/** One clip of a run on the Look card's chart: its number from 0, and its sharpness and brightness against the run's start (1 = the same); null where not measured. */
export interface RunPoint {
  index: number;
  sharp: number | null;
  luma: number | null;
}

/** Every clip of the run `index` is in, its sharpness and brightness against the run's start. Empty when the start was not measured. */
export function runSeries(clips: Array<Pick<Clip, "joined" | "take">>, index: number): RunPoint[] {
  const start = runStart(clips, index);
  const end = runEnd(clips, index);
  const first = clips[start]?.take?.measure;
  if (!first) return [];
  const out: RunPoint[] = [];
  for (let i = start; i <= end; i++) {
    const m = clips[i]?.take?.measure;
    out.push({ index: i, sharp: m ? m.sharp / Math.max(0.01, first.sharp) : null, luma: m ? m.luma / Math.max(1, first.luma) : null });
  }
  return out;
}

/**
 * The clips marked under the chart of a run of `count` clips that starts at clip number `first` (from 1): the one
 * shown (`at`, in the run from 0), the ends, and round clip numbers between, none closer than `gap` clips to
 * another (the shown one, then the ends win). Places in the run, from 0.
 */
export function runTicks(count: number, at: number, first = 1, gap = Math.max(1, count / 8)): number[] {
  if (count <= 0) return [];
  const every = [1, 2, 5, 10, 20, 50, 100].find((s) => count / s <= 6) ?? 100;
  const marks = [at, 0, count - 1];
  for (let i = 1; i < count - 1; i++) if ((first + i) % every === 0) marks.push(i);
  const kept: number[] = [];
  for (const m of marks) if (m >= 0 && m < count && !kept.some((k) => Math.abs(k - m) < gap)) kept.push(m);
  return kept.sort((a, b) => a - b);
}
