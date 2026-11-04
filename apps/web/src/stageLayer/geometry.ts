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

/** A rect in the picture as a part of it, for CSS (left, top, width, height in percent of the frame). */
export function percentOf(r: Rect, frame: Frame): { left: string; top: string; width: string; height: string } {
  const pc = (v: number, of: number) => `${of > 0 ? (v / of) * 100 : 0}%`;
  return { left: pc(r.x + frame.x, frame.w), top: pc(r.y + frame.y, frame.h), width: pc(r.w, frame.w), height: pc(r.h, frame.h) };
}
