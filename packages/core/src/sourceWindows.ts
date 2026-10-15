/**
 * A long source (a driving video on a timeline's source lane) made window by window: where each window's part of the
 * source starts, how long it is, and the stretch of the source its clip shows. Each window after the first carries on
 * from the one before: its part starts `carried` frames before the stretch it shows (those frames are the clip before's
 * last ones, handed over and dropped from what it makes), so the clips play the source end to end, frame for frame.
 * The same sums on the server (Make N clips) and in the browser (the lane's marks before anything is made).
 */

import { gridAtLeast, gridAtOrBefore, type FrameGrid } from "./frameGrid";

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
 * `cutsMs` (the source's scene cuts), a window ends at a cut that falls inside it, more than two seconds in, and the next
 * one opens a new shot. The source runs to its end: a last stretch shorter than half the window before it is taken by that window
 * when one job holds both, else the two share what is left evenly (the meme's 26.6 s in 5 s windows ended on a 2.1 s clip).
 * A last stretch shorter than a job's fewest frames is still left out.
 */
export function sourceWindows(o: { fromMs: number; toMs: number; windowMs: number; shape: WindowShape; cutsMs?: number[] }): SourceWindow[] {
  const { fps, most, least, carried } = o.shape;
  const grid = o.shape.grid ?? WAN_GRID;
  /** The most frames the model takes of `n`. */
  const onGrid = (n: number) => gridAtOrBefore(n, grid);
  const frameMs = 1000 / fps;
  // a window asked for shorter than a job takes is made as the shortest that does (windowBounds)
  const windowMs = Math.max(o.windowMs, windowBounds(o.shape).leastMs);
  const out: SourceWindow[] = [];
  let covered = o.fromMs;
  let opens: boolean = true;
  for (let guard = 0; guard < 500; guard++) {
    const carry: number = opens ? 0 : carried;
    const startMs = covered - carry * frameMs;
    const left = Math.floor((o.toMs - startMs) / frameMs + 1e-6);
    /** Whether a part of `k` frames is one the recipe takes: the fewest past the carried ones, and on the grid. */
    const takes = (k: number) => k - carry >= least;
    let n = onGrid(Math.min(most, Math.round(windowMs / frameMs) + carry, left));
    if (!takes(n)) break;
    // a scene cut inside it: the window ends there (or as near after it as the fewest frames allow), the next opens a new shot
    const cut: number | undefined = (o.cutsMs ?? []).find((c) => c > covered + 2000 && c < covered + (n - carry) * frameMs - frameMs);
    if (cut !== undefined) n = Math.min(n, Math.max(onGrid(carry + Math.floor((cut - covered) / frameMs)), gridAtLeast(carry + least, grid)));
    else if (left > n && (left - n) < (n - carry) / 2) {
      // a short stretch would be left after it: this window runs to the end, or shares the rest with the next one. Shared,
      // each half must still be one the recipe takes (H3's swap, 90 frames at least, made 73): else this one takes what it can
      const whole = onGrid(Math.min(most, left));
      const shared = onGrid(Math.min(most, carry + Math.ceil((left - carry) / 2)));
      n = left - whole < grid.step || !takes(shared) ? whole : shared;
    }
    const toMs = covered + (n - carry) * frameMs;
    // half a frame more, so that the part cut at the model's speed holds all `n` frames (one short would drop a grid step)
    out.push({ start: round(startMs / 1000), seconds: round((n + 0.5) / fps), fromMs: Math.round(covered), toMs: Math.round(toMs), opens });
    covered = toMs;
    opens = cut !== undefined;
  }
  return out;
}

const round = (s: number) => Math.round(s * 10_000) / 10_000;
