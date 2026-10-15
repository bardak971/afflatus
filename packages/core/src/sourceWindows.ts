/**
 * A long source (a driving video on a timeline's source lane) made window by window: where each window's part of the
 * source starts, how long it is, and the stretch of the source its clip shows. Each window after the first carries on
 * from the one before: its part starts `carried` frames before the stretch it shows (those frames are the clip before's
 * last ones, handed over and dropped from what it makes), so the clips play the source end to end, frame for frame.
 * The same sums on the server (Make N clips) and in the browser (the lane's marks before anything is made).
 */

import { gridAtOrBefore, type FrameGrid } from "./frameGrid";

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
 * The windows that cover `fromMs` to `toMs` of the source, each showing about `windowMs` (within what one job takes). With
 * `cutsMs` (the source's scene cuts), a window ends at a cut that falls inside it, more than two seconds in, and the next
 * one opens a new shot. A last stretch shorter than a job's fewest frames is left out.
 */
export function sourceWindows(o: { fromMs: number; toMs: number; windowMs: number; shape: WindowShape; cutsMs?: number[] }): SourceWindow[] {
  const { fps, most, least, carried } = o.shape;
  /** The most frames the model takes of `n`. */
  const onGrid = (n: number) => gridAtOrBefore(n, o.shape.grid ?? WAN_GRID);
  const frameMs = 1000 / fps;
  const out: SourceWindow[] = [];
  let covered = o.fromMs;
  let opens: boolean = true;
  for (let guard = 0; guard < 500; guard++) {
    const carry: number = opens ? 0 : carried;
    const startMs = covered - carry * frameMs;
    const left = Math.floor((o.toMs - startMs) / frameMs + 1e-6);
    let n = onGrid(Math.min(most, Math.round(o.windowMs / frameMs) + carry, left));
    if (n - carry < least) break;
    // a scene cut inside it: the window ends there, the next opens a new shot
    const cut: number | undefined = (o.cutsMs ?? []).find((c) => c > covered + 2000 && c < covered + (n - carry) * frameMs - frameMs);
    if (cut !== undefined) n = Math.max(onGrid(carry + Math.floor((cut - covered) / frameMs)), onGrid(carry + least + 3));
    const toMs = covered + (n - carry) * frameMs;
    // half a frame more, so that the part cut at the model's speed holds all `n` frames (one short would drop a grid step)
    out.push({ start: round(startMs / 1000), seconds: round((n + 0.5) / fps), fromMs: Math.round(covered), toMs: Math.round(toMs), opens });
    covered = toMs;
    opens = cut !== undefined;
  }
  return out;
}

const round = (s: number) => Math.round(s * 10_000) / 10_000;
