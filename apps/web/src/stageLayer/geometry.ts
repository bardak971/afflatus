import type { Size } from "../viewer/zoom";
import type { Rect } from "./raster";

/**
 * Where things are on the Stage's layer: a point of the room (the pointer) in the picture's own pixels and back, boxes,
 * snapping to a step, aspect ratios. Pure, for the tests. Everything the layer keeps is in the picture's pixels, so it
 * holds whatever the zoom, the room's size, or the frame grown around the picture by an outpaint.
 */

/**
 * What the room fits: a frame of `w` × `h` picture pixels with the picture's top left corner at (`x`, `y`) in it. The
 * picture's own size with (0, 0) most of the time; larger around it while an outpaint frame is dragged out.
 */
export interface Frame {
  w: number;
  h: number;
  x: number;
  y: number;
}

/** Where the fitted frame is drawn in the room (zoom.ts `placed`). */
export interface Shown {
  left: number;
  top: number;
  scale: number;
}

export const frameOf = (natural: Size): Frame => ({ w: natural.w, h: natural.h, x: 0, y: 0 });

/** A point of the room (from its top left corner, in screen pixels) in the picture's pixels: outside it, below 0 or past its size. */
export function roomToPicture(at: { x: number; y: number }, shown: Shown, fit: Size, frame: Frame): { x: number; y: number } {
  const k = fit.w > 0 ? frame.w / fit.w : 1;
  return { x: ((at.x - shown.left) / shown.scale) * k - frame.x, y: ((at.y - shown.top) / shown.scale) * k - frame.y };
}

/** The nearest multiple of `step` (none under 1: as it is). */
export const snap = (v: number, step: number): number => (step > 1 ? Math.round(v / step) * step : v);

/** The next multiple of `step` at or above `v`. */
export const snapUp = (v: number, step: number): number => (step > 1 ? Math.ceil(v / step - 1e-9) * step : v);

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** An aspect ratio's words ("16:9", "Widescreen 16:9") as width over height; null for none ("Free"). */
export function ratioOf(words: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(words);
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * The box between where a drag began and where it is, either way round. `ratio` (Shift held: a square, or a shape's
 * ratio): the box holds it, as large as the drag's longer side asks, from the corner it began at.
 */
export function boxFrom(a: { x: number; y: number }, b: { x: number; y: number }, ratio?: number | null): Rect {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (ratio && ratio > 0) {
    const big = Math.max(Math.abs(w), Math.abs(h) * ratio);
    w = Math.sign(w || 1) * big;
    h = Math.sign(h || 1) * (big / ratio);
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

/** A box's eight handles, by the compass: the sides they move. */
export type Handle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Where each handle sits on a box, as a part of its width and height, and the cursor it shows. */
export const AT: Record<Handle, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
export const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };

/**
 * The handle of a box a press at `p` takes (all in the picture's pixels), within `grab`: a corner before a side, a side
 * anywhere along its length; none away from the box's edge. The outpaint frame and the region boxes both hit-test by it.
 */
export function handleOn(p: { x: number; y: number }, box: Rect, grab: number): Handle | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= grab;
  const within = (v: number, lo: number, hi: number) => v >= lo - grab && v <= hi + grab;
  if (!within(p.x, box.x, box.x + box.w) || !within(p.y, box.y, box.y + box.h)) return null;
  const west = near(p.x, box.x);
  const east = !west && near(p.x, box.x + box.w);
  const north = near(p.y, box.y);
  const south = !north && near(p.y, box.y + box.h);
  if ((west || east) && (north || south)) return `${north ? "n" : "s"}${west ? "w" : "e"}` as Handle;
  if (west || east) return west ? "w" : "e";
  if (north || south) return north ? "n" : "s";
  return null;
}

/** How many picture pixels one screen pixel is at this zoom: a grab or a click so many screen pixels wide whatever the zoom. */
export const perScreen = (frame: Frame, fit: Size, shown: Shown): number => (fit.w > 0 && shown.scale > 0 ? frame.w / (fit.w * shown.scale) : 1);

/** A rect in the picture as a part of it, for CSS (left, top, width, height in percent of the frame). */
export function percentOf(r: Rect, frame: Frame): { left: string; top: string; width: string; height: string } {
  const pc = (v: number, of: number) => `${of > 0 ? (v / of) * 100 : 0}%`;
  return { left: pc(r.x + frame.x, frame.w), top: pc(r.y + frame.y, frame.h), width: pc(r.w, frame.w), height: pc(r.h, frame.h) };
}
