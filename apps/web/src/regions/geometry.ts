import { clamp, type Handle } from "../stageLayer/geometry";
import type { Size } from "../viewer/zoom";
import { plural } from "../format";
import type { RegionKind, RegionValue, UnitBox } from "./types";

/**
 * Where the region boxes are: drawn, moved and resized in parts of the frame (0 to 1), so that the form's size changed, or
 * the boxes laid over a finished picture of another size, keeps each box where it was. Pure, for the tests; the region tool
 * (useRegionTool) hands it the pointer in the picture's pixels and the frame's size.
 */

/** The smallest a box is drawn or resized to, as a part of the frame's side: a click is not a box. */
const MIN_SIDE = 0.03;

/** A point of the picture in parts of it. */
export const unitPoint = (p: { x: number; y: number }, size: Size): { x: number; y: number } => ({ x: size.w > 0 ? p.x / size.w : 0, y: size.h > 0 ? p.y / size.h : 0 });

/** A box in the picture's pixels. */
export const pixelBox = (b: UnitBox, size: Size) => ({ x: b.x * size.w, y: b.y * size.h, w: b.w * size.w, h: b.h * size.h });

/** A box kept inside the frame, at its size where it fits (a box moved past an edge stops at it, never shrinks). */
export function keptInside(b: UnitBox): UnitBox {
  const w = clamp(b.w, 0, 1);
  const h = clamp(b.h, 0, 1);
  return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h };
}

/** The box between where a drag began and where it is (parts of the frame), either way round, cut at the frame's edges. */
export function drawnBox(a: { x: number; y: number }, b: { x: number; y: number }): UnitBox {
  const x0 = clamp(Math.min(a.x, b.x), 0, 1);
  const y0 = clamp(Math.min(a.y, b.y), 0, 1);
  const x1 = clamp(Math.max(a.x, b.x), 0, 1);
  const y1 = clamp(Math.max(a.y, b.y), 0, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether a drawn box is large enough to keep. */
export const isBox = (b: UnitBox): boolean => b.w >= MIN_SIDE && b.h >= MIN_SIDE;

/** A box moved by (dx, dy) parts of the frame from where it was at the press, held inside it. */
export const movedBox = (start: UnitBox, dx: number, dy: number): UnitBox => keptInside({ ...start, x: start.x + dx, y: start.y + dy });

/**
 * A box after a handle is dragged by (dx, dy) parts of the frame: the sides the handle holds move with the pointer, never past
 * the frame's edge nor closer than the smallest side to the side opposite.
 */
export function resizedBox(start: UnitBox, handle: Handle, dx: number, dy: number): UnitBox {
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (handle.includes("w")) x0 = clamp(x0 + dx, 0, x1 - MIN_SIDE);
  if (handle.includes("e")) x1 = clamp(x1 + dx, x0 + MIN_SIDE, 1);
  if (handle.includes("n")) y0 = clamp(y0 + dy, 0, y1 - MIN_SIDE);
  if (handle.includes("s")) y1 = clamp(y1 + dy, y0 + MIN_SIDE, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The region whose box holds a point (parts of the frame): the last drawn first, as it lies on top. */
export function regionAt(regions: readonly RegionValue[], p: { x: number; y: number }): RegionValue | undefined {
  for (let i = regions.length - 1; i >= 0; i--) {
    const b = regions[i]!.box;
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return regions[i];
  }
  return undefined;
}

/** The box a person dropped on empty canvas gets: this size, centred where they landed, held inside the frame. */
const DROP_BOX = { w: 0.3, h: 0.5 };
export const droppedBox = (at: { x: number; y: number }): UnitBox => keptInside({ x: at.x - DROP_BOX.w / 2, y: at.y - DROP_BOX.h / 2, ...DROP_BOX });

/** A new region's id: one no region of the list has. */
export function newRegionId(regions: readonly RegionValue[]): string {
  const taken = new Set(regions.map((r) => r.id));
  let n = regions.length + 1;
  while (taken.has(`r${n}`)) n++;
  return `r${n}`;
}

/**
 * A new region with its box, the next id, nothing said yet: of `kind` on a model whose regions have kinds (MOSS's object or
 * text, an object when none is asked), with `cast` when a person was dropped to make it.
 */
export function newRegion(regions: readonly RegionValue[], box: UnitBox, { kinds, kind, cast }: { kinds?: boolean; kind?: RegionKind; cast?: string } = {}): RegionValue {
  return { id: newRegionId(regions), box, prompt: "", ...(cast ? { cast } : {}), ...(kinds ? { kind: kind ?? "object" } : {}) };
}

/**
 * Why no box can be added, or undefined: the list holds the most there may be. Said as regions on a form, as boxes on
 * Edit in box (whose boxes are an edit's, not a model's regions).
 */
export function fullSaid(count: number, max: number, noun: "region" | "box" = "region"): string | undefined {
  if (count < max) return undefined;
  return noun === "box" ? `${plural(max, "box", "boxes")} already: the most one edit takes` : `${plural(max, "region")} already: the most this model takes`;
}

const pc = (v: number) => Math.round(v * 100);

/**
 * Where a box is, in a few words for its row ("left · x 9–45 %", "top · y 6–30 %", "bottom left"): its third of the frame
 * each way, and the span of the side it fills less of when it fills most of the other.
 */
export function whereSaid(b: UnitBox): string {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const across = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "";
  const down = cy < 1 / 3 ? "top" : cy > 2 / 3 ? "bottom" : "";
  if (b.h >= 0.6 && b.w < 0.6) return `${across || "middle"} · x ${pc(b.x)}–${pc(b.x + b.w)} %`;
  if (b.w >= 0.6 && b.h < 0.6) return `${down || "middle"} · y ${pc(b.y)}–${pc(b.y + b.h)} %`;
  if (b.w >= 0.6 && b.h >= 0.6) return "most of the picture";
  return [down, across].filter(Boolean).join(" ") || "middle";
}

/** The colours the regions are told apart by, the same on the Stage and in the form: by their place in the list. */
const REGION_COLOURS = ["#ff8a65", "#86aeff", "#b9a2e0", "#5ad6bd", "#f48fb1", "#f5c451", "#9ccc65", "#4dd0e1"] as const;
export const regionColour = (index: number): string => REGION_COLOURS[index % REGION_COLOURS.length]!;
