import type { Size } from "../viewer/zoom";
import { clamp, snap, snapUp, type Frame } from "./geometry";

/**
 * The outpaint frame dragged out around a picture: what each side adds, kept on the model's step and under the recipes'
 * most. Pure, for the tests; the frame tool (useFrameTool) draws it. The sides are said as the outpaint forms' own rows
 * (`padLeft`…, pictureForm's outpaint), so the result goes into the form as it is.
 */
export interface Pads {
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
}

export const NO_PADS: Pads = { padLeft: 0, padTop: 0, padRight: 0, padBottom: 0 };

/** The frame's eight handles, by the compass: the sides they move. */
export type Handle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The shapes the frame can be held to, the mock's: the outpaint forms' own (OUTPAINT_SHAPES) and a few more. */
export const FRAME_ASPECTS = ["Free", "1:1", "4:5", "2:3", "3:2", "16:9", "9:16", "21:9"] as const;

export interface FrameRules {
  /** The step the frame's size snaps to (SDXL draws in 64 px); 1: not snapped. */
  step: number;
  /** The most a side may add: the outpaint rows' max (1024). */
  most: number;
  /** Width over height the frame holds, or none. */
  ratio: number | null;
}

/** The forms' outpaint rows' limits (sdxl/common.ts OUTPAINT_INPUTS): each side 0 to 1024 px. */
export const FRAME_RULES: FrameRules = { step: 64, most: 1024, ratio: null };

/** The frame the pads make around a picture, in the picture's pixels. */
export const paddedFrame = (natural: Size, p: Pads): Frame => ({ w: natural.w + p.padLeft + p.padRight, h: natural.h + p.padTop + p.padBottom, x: p.padLeft, y: p.padTop });

/**
 * One side's pad when it is dragged to `raw`: the frame's size along it on the step (the other side and the picture as they
 * are), or none at all, whichever is nearer; never past `most`. Nothing is always allowed: the picture's own edge.
 */
export function snapSide(own: number, other: number, raw: number, step: number, most: number): number {
  const p = clamp(raw, 0, most);
  if (step <= 1) return Math.round(p);
  const base = own + other;
  // the pads on the step around p, held under the most
  const below = Math.floor((base + p) / step) * step - base;
  const options = [0, below, below + step].filter((q) => q >= 0 && q <= most);
  return options.reduce((best, q) => (Math.abs(q - p) < Math.abs(best - p) ? q : best), 0);
}

/** The two pads of one axis around a picture of `own`, adding to `extra`: split even, the odd pixel after (as padsFor). */
const centred = (extra: number) => [Math.floor(extra / 2), Math.ceil(extra / 2)] as const;

/**
 * The pads that bring a picture to a ratio, the picture in the middle, the frame's size on the step: the smallest frame of
 * that shape around it. Each side held under the most (a ratio far from the picture's then holds only roughly).
 */
export function padsForRatio(natural: Size, ratio: number, rules: Pick<FrameRules, "step" | "most">): Pads {
  const w = Math.max(snapUp(natural.w, rules.step), snap(Math.max(natural.w, natural.h * ratio), rules.step));
  const h = Math.max(snapUp(natural.h, rules.step), snap(w / ratio, rules.step));
  const [l, r] = centred(w - natural.w);
  const [t, b] = centred(h - natural.h);
  return { padLeft: Math.min(rules.most, l), padRight: Math.min(rules.most, r), padTop: Math.min(rules.most, t), padBottom: Math.min(rules.most, b) };
}

/**
 * The pads after a handle is dragged by (dx, dy) picture pixels from where they were at the press. A side moves with the
 * pointer, snapped (snapSide); with a ratio, the frame keeps it: the side dragged sets the size, the other axis grows
 * around the picture's middle, and the frame never gets smaller than the picture.
 */
export function dragFrame(start: Pads, handle: Handle, dx: number, dy: number, natural: Size, rules: FrameRules): Pads {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  // what the pointer asks of each side it moves (the west side grows as the pointer goes left)
  const raw = {
    padLeft: start.padLeft - (west ? dx : 0),
    padRight: start.padRight + (east ? dx : 0),
    padTop: start.padTop - (north ? dy : 0),
    padBottom: start.padBottom + (south ? dy : 0),
  };
  if (!rules.ratio) {
    const out = { ...start };
    if (west) out.padLeft = snapSide(natural.w, start.padRight, raw.padLeft, rules.step, rules.most);
    if (east) out.padRight = snapSide(natural.w, start.padLeft, raw.padRight, rules.step, rules.most);
    if (north) out.padTop = snapSide(natural.h, start.padBottom, raw.padTop, rules.step, rules.most);
    if (south) out.padBottom = snapSide(natural.h, start.padTop, raw.padBottom, rules.step, rules.most);
    return out;
  }
  const r = rules.ratio;
  const horizontal = west || east;
  const vertical = north || south;
  // the size the drag asks for, along each axis it moves; a corner takes the larger of the two
  const wantW = natural.w + Math.max(0, raw.padLeft) + Math.max(0, raw.padRight);
  const wantH = natural.h + Math.max(0, raw.padTop) + Math.max(0, raw.padBottom);
  let w = horizontal && vertical ? Math.max(wantW, wantH * r) : horizontal ? wantW : wantH * r;
  w = Math.max(w, natural.w, natural.h * r);
  // each size on the step, nearest the ratio, and never under the picture's
  const W = Math.max(snapUp(natural.w, rules.step), snap(w, rules.step));
  const H = Math.max(snapUp(natural.h, rules.step), snap(W / r, rules.step));
  /** One axis's two pads for a size: the side dragged takes what the other leaves, an axis not dragged splits it. */
  const axis = (size: number, own: number, lo: number, hi: number, movesLo: boolean, movesHi: boolean): [number, number] => {
    const extra = size - own;
    if (movesLo && !movesHi) {
      const keep = Math.min(hi, extra);
      return [extra - keep, keep];
    }
    if (movesHi && !movesLo) {
      const keep = Math.min(lo, extra);
      return [keep, extra - keep];
    }
    const [a, b] = centred(extra);
    return [a, b];
  };
  const [padLeft, padRight] = axis(W, natural.w, start.padLeft, start.padRight, west, east);
  const [padTop, padBottom] = axis(H, natural.h, start.padTop, start.padBottom, north, south);
  return held({ padLeft, padRight, padTop, padBottom }, rules.most);
}

/** Each side under the most: what one side cannot take goes to the other of its axis, while it has room. */
function held(p: Pads, most: number): Pads {
  const pair = (a: number, b: number): [number, number] => {
    if (a > most) [a, b] = [most, b + a - most];
    if (b > most) [a, b] = [Math.min(most, a + b - most), most];
    return [a, b];
  };
  const [padLeft, padRight] = pair(p.padLeft, p.padRight);
  const [padTop, padBottom] = pair(p.padTop, p.padBottom);
  return { padLeft, padRight, padTop, padBottom };
}

/** Whether the pads add anything: an outpaint with none has nothing to draw (the recipes refuse it). */
export const padded = (p: Pads): boolean => p.padLeft + p.padTop + p.padRight + p.padBottom > 0;
