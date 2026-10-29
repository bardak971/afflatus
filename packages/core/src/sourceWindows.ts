/**
 * A long source (a driving video on a timeline's source lane) made window by window: where each window's part of the
 * source starts, how long it is, and the stretch of the source its clip shows. Each window after the first carries on
 * from the one before: its part starts `carried` frames before the stretch it shows (those frames are the clip before's
 * last ones, handed over and dropped from what it makes), so the clips play the source end to end, frame for frame.
 * The same sums on the server (Make N clips) and in the browser (the lane's marks before anything is made).
 */

import { gridAtLeast, gridAtOrBefore, type FrameGrid } from "./frameGrid";
import type { InputSpec } from "./inputs";
import { quietest, type Loudness, type Pause } from "./recordingParts";
import type { VideoTraits } from "./recipe";

/** How a recipe takes a long source, in its own frames (VideoTraits.windows, at VideoTraits.fps). */
export interface WindowShape {
  fps: number;
  /** The most frames one job takes, and the fewest. */
  most: number;
  least: number;
  /** Frames of the clip before that a window carries on from. */
  carried: number;
  /** The counts the model takes (VideoTraits.frameGrid); left out, Wan's 4k + 1. */
  grid?: FrameGrid;
}

export interface SourceWindow {
  /** The part of the source the job is given (the form's driving video start and length), in seconds. */
  start: number;
  seconds: number;
  /** The stretch of the source its clip shows, in milliseconds. */
  fromMs: number;
  toMs: number;
  /** It starts a shot (the first window, or one after a scene cut): a cut, not carried on. */
  opens: boolean;
  /**
   * What its end was cut at (the last window's, the stretch's end, is none of them): a scene cut, a pause in the speech,
   * the quietest moment, or the length asked.
   */
  on?: WindowOn;
  /**
   * Ended on a scene cut: the ms its part runs past it, to the model's next frame count (a window cannot end anywhere else),
   * that its take hides (SourcePlan.hidden), so that it stops on the cut and the next window opens exactly there.
   */
  hideMs?: number;
}

/** What a window's end was cut at: the source's scene cut, a pause in its speech, its quietest moment, or the length asked. */
export type WindowOn = "cut" | "pause" | "quiet" | "length";

/** What a source is cut at besides its length, within the window asked (`withinMs`): its scene cuts, its pauses, its loudness. */
export interface SourceMarks {
  /** The scene cuts, in ms of the source. */
  cutsMs?: number[];
  /** The pauses in its speech, in seconds of the source (ffmpeg's silencedetect, as a recording's). */
  pauses?: Pause[];
  /** Its loudness (the speech band), in seconds of the source. */
  levels?: Loudness | null;
}

/** Wan's grid, the one every Motion transfer model makes its parts on: 4k + 1 frames. */
const WAN_GRID: FrameGrid = { step: 4, offset: 1 };

/**
 * The window lengths a source can be made in with `shape`, in milliseconds of the source each clip shows: from the fewest
 * a window that carries on takes (its fewest frames on the grid, past the carried ones) to the most one job shows past them.
 * A window asked for outside them is taken as the nearest: shorter, a window that carries on would be under the fewest
 * the recipe takes, and the rest of the source was left out (H3's swap at 3.75 to 4.25 s made one window of 26 s).
 */
export function windowBounds(shape: WindowShape): { leastMs: number; mostMs: number } {
  const grid = shape.grid ?? WAN_GRID;
  const fewest = gridAtLeast(shape.least + shape.carried, grid);
  const most = gridAtOrBefore(shape.most, grid);
  return { leastMs: ((fewest - shape.carried) * 1000) / shape.fps, mostMs: (Math.max(fewest, most) - shape.carried) * 1000 / shape.fps };
}

/**
 * The windows that cover `fromMs` to `toMs` of the source, each showing about `windowMs` (within what one job takes). With
 * `withinMs` (± of the length, as a recording is cut into Lip sync clips), a window ends at the best spot within that much
 * of the length asked: a scene cut (`cutsMs`), the next window opening the new shot exactly there (its part runs on to the
 * model's next frame count, which its take hides: `hideMs`); else the middle of a pause in the speech; else its quietest
 * moment; else the length asked. A cut further away is carried through, as the source plays it. The rule before ended a
 * window at every cut more than two seconds in, made it the fewest frames a job takes when that was later, and opened the
 * next one there: on a vlog of a cut every 2.7 s, 27 short windows whose cuts fell up to 3.7 s after the source's (the
 * owner, 2026-10-29). The source runs to its end: a last stretch shorter than half the window before it is taken by that
 * window when one job holds both, else the two share what is left evenly (the meme's 26.6 s in 5 s windows ended on a 2.1
 * s clip). A last stretch shorter than a job's fewest frames is still left out. `continues`: `fromMs` is where a window
 * already made ends, and the first window carries on from it as the ones after do (the source cut again after its rendered clips).
 */
export function sourceWindows(o: { fromMs: number; toMs: number; windowMs: number; shape: WindowShape; withinMs?: number; continues?: boolean } & SourceMarks): SourceWindow[] {
  const { fps, most, least, carried } = o.shape;
  const grid = o.shape.grid ?? WAN_GRID;
  /** The most frames the model takes of `n`. */
  const onGrid = (n: number) => gridAtOrBefore(n, grid);
  const frameMs = 1000 / fps;
  // a window asked for shorter than a job takes is made as the shortest that does (windowBounds)
  const windowMs = Math.max(o.windowMs, windowBounds(o.shape).leastMs);
  const within = Math.max(0, o.withinMs ?? 0);
  const out: SourceWindow[] = [];
  let covered = o.fromMs;
  let opens: boolean = !o.continues;
  for (let guard = 0; guard < 500; guard++) {
    const carry: number = opens ? 0 : carried;
    const startMs = covered - carry * frameMs;
    const left = Math.floor((o.toMs - startMs) / frameMs + 1e-6);
    /** Whether a part of `k` frames is one the recipe takes: the fewest past the carried ones, and on the grid. */
    const takes = (k: number) => k - carry >= least;
    let n = onGrid(Math.min(most, Math.round(windowMs / frameMs) + carry, left));
    if (!takes(n)) break;
    let cut: number | undefined;
    let on: WindowOn = "length";
    if (within > 0) {
      // the spots within the window asked and within what this job can show: the one nearest the length asked wins
      const fewest = gridAtLeast(carry + least, grid);
      const whole = onGrid(Math.min(most, left));
      const lo = covered + Math.max((fewest - carry) * frameMs, windowMs - within);
      const hi = covered + Math.min((whole - carry) * frameMs, windowMs + within);
      const want = covered + windowMs;
      const nearest = (xs: number[]) => xs.filter((m) => m >= lo && m <= hi && m < o.toMs - frameMs).reduce<number | null>((best, m) => (best === null || Math.abs(m - want) < Math.abs(best - want) ? m : best), null);
      const c = nearest(o.cutsMs ?? []);
      // on a cut: the model's next count at or past it, its overshoot hidden; one past what the job or the stretch holds is no spot
      const k = c !== null ? gridAtLeast(carry + Math.ceil((c - covered) / frameMs - 1e-6), grid) : 0;
      if (c !== null && k <= Math.min(most, left) && takes(k)) {
        n = k;
        cut = c;
        on = "cut";
      } else {
        const pause = nearest((o.pauses ?? []).map((p) => ((p.start + p.end) / 2) * 1000));
        const quiet = pause === null ? quietest(o.levels, lo / 1000, hi / 1000, want / 1000) : null;
        const spot = pause ?? (quiet !== null ? quiet * 1000 : null);
        if (spot !== null) {
          // the model's count nearest the spot, within what the job takes
          const below = onGrid(carry + Math.floor((spot - covered) / frameMs + 1e-6));
          const counts = [below, below + grid.step].filter((x) => x >= fewest && x <= whole);
          if (counts.length) {
            const endOf = (x: number) => covered + (x - carry) * frameMs;
            n = counts.reduce((best, x) => (Math.abs(endOf(x) - spot) < Math.abs(endOf(best) - spot) ? x : best));
            on = pause !== null ? "pause" : "quiet";
          }
        }
      }
    }
    const picked = n;
    if (cut === undefined && left > n) {
      /** Whether what is left after a window of `k` frames is a part the next window can take (it carries `carried` back). */
      const restTakes = (k: number) => onGrid(Math.min(most, left - k + carried)) - carried >= least;
      const whole = onGrid(Math.min(most, left));
      if ((left - n) < (n - carry) / 2) {
        // a short stretch would be left after it: this window runs to the end, or shares the rest with the next one. Shared,
        // each half must still be one the recipe takes (H3's swap, 90 frames at least, made 73), the next one's too: else
        // this one takes what it can (shared, the swap's rest was left out, 4.25 s where taking whole left out 2.8)
        const shared = onGrid(Math.min(most, carry + Math.ceil((left - carry) / 2)));
        n = left - whole < grid.step || !takes(shared) || !restTakes(shared) ? whole : shared;
      } else if (!restTakes(n)) {
        // the rest is too short for a job of its own: this window takes as much of it as one job holds, rather than all of it left out
        n = whole;
      }
      // moved for the stretch's end: no longer on the spot it was cut at
      if (n !== picked) on = "length";
    }
    const ends = covered + (n - carry) * frameMs;
    const toMs = cut ?? ends;
    // half a frame more, so that the part cut at the model's speed holds all `n` frames (one short would drop a grid step)
    out.push({
      start: round(startMs / 1000), seconds: round((n + 0.5) / fps), fromMs: Math.round(covered), toMs: Math.round(toMs), opens,
      on, ...(cut !== undefined && ends - cut >= 0.5 ? { hideMs: Math.round(ends - cut) } : {}),
    });
    covered = toMs;
    opens = cut !== undefined;
  }
  // the last window ends where the stretch does, at none of the spots
  if (out.length) delete out[out.length - 1]!.on;
  return out;
}

const round = (s: number) => Math.round(s * 10_000) / 10_000;

/** What windowShapeOf reads of a recipe: its speed, its grid and how it takes a long source. */
interface WindowedTraits {
  traits?: null | { fps: number; frameGrid?: FrameGrid; windows?: { most: number; least: number; carried: number; runUp?: { input: string; counts: number[] } } };
}

/** The frames a window carries on from with this form: the count its run-up input has, when it is one the recipe takes, else the recipe's own. */
export function carriedOf(recipe: WindowedTraits | undefined, inputs?: Record<string, unknown>): number {
  const w = recipe?.traits?.windows;
  if (!w) return 0;
  const asked = w.runUp && inputs ? Number(inputs[w.runUp.input]) : NaN;
  return w.runUp && w.runUp.counts.includes(asked) ? asked : w.carried;
}

/**
 * How a recipe takes a long source with this form (its run-up as set, H3's 5, 22 or 39 frames), or null for one not made
 * window by window. The server's cut and the lane's marks both read it, so that the clips made are the ones drawn.
 */
export function windowShapeOf(recipe: WindowedTraits | undefined, inputs?: Record<string, unknown>): WindowShape | null {
  const t = recipe?.traits;
  const w = t?.windows;
  return t && w ? { fps: t.fps, grid: t.frameGrid, most: w.most, least: w.least, carried: carriedOf(recipe, inputs) } : null;
}

/**
 * Whether two forms that make a source window by window cut it the same way: the same frame rate, frame grid and window
 * shape (H3's Swap character and Motion transfer between them). Between two such forms a source changes form in place, its
 * windows and their takes kept, and each window may take either (card #42); across grids (SCAIL-2 and H3) its windows are
 * made anew.
 */
export function sameWindowGrid(a: { traits?: VideoTraits | null } | undefined, b: { traits?: VideoTraits | null } | undefined): boolean {
  const [x, y] = [a?.traits, b?.traits];
  if (!x?.windows || !y?.windows) return false;
  const same = (p: unknown, q: unknown) => JSON.stringify(p) === JSON.stringify(q);
  return x.fps === y.fps && same(x.frameGrid, y.frameGrid) && x.windows.most === y.windows.most && x.windows.least === y.windows.least && x.windows.carried === y.windows.carried;
}

/**
 * How long a window of a source will play before it is rendered, in seconds: its part of the source less the frames it
 * carries on from (the clip before's last ones, dropped from what it makes) and the half frame its part is asked longer
 * by. Null for a clip not made window by window. Read as the part's whole length, the 21 carried-on windows of a 1:50
 * source were drawn 19 s longer than the source itself (the owner, 2026-10-29).
 */
export function windowPlaysSeconds(recipe: (WindowedTraits & { inputs: readonly InputSpec[] }) | undefined, inputs: Record<string, unknown>, joined: "continue" | "cut" | undefined): number | null {
  const fps = recipe?.traits?.fps;
  const driving = recipe?.traits?.windows ? recipe.inputs.find((i) => i.type === "clip" && i.role === "source" && i.window) : undefined;
  if (!fps || driving?.type !== "clip" || !driving.window) return null;
  const seconds = Number(inputs[driving.window.seconds]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const frames = Math.floor(seconds * fps + 0.01) - (joined === "continue" ? carriedOf(recipe, inputs) : 0);
  return frames > 0 ? frames / fps : null;
}

/** Where a window's end lies on a pause's middle: within a frame, or half a step of the model's counts it was brought onto. */
const ON_PAUSE_MS = 30;

/**
 * What a made window's end was cut at, read back from where it lies (the Source panel counts its clips by it, as the
 * recording's panel does): the next window opening on it, a scene cut; a pause's middle (within `nearMs`, half a step of
 * the model's counts); else the quietest moment when it was cut within a window, else the length asked.
 */
export function windowEndOn(endMs: number, nextOpens: boolean, marks: Pick<SourceMarks, "pauses">, withinMs: number, nearMs = ON_PAUSE_MS): WindowOn {
  if (nextOpens) return "cut";
  const near = Math.max(ON_PAUSE_MS, nearMs);
  if ((marks.pauses ?? []).some((p) => Math.abs(((p.start + p.end) / 2) * 1000 - endMs) <= near)) return "pause";
  return withinMs > 0 ? "quiet" : "length";
}
