import { Hand, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { LayerPlace } from "../viewer/ZoomPicture";
import type { Rect } from "./raster";

/**
 * The tools of the Stage's drawing layer, one shape for all: the mask's brush, rubber, box, lasso and invert, the
 * outpaint frame, the click, the detector and the wand, the regions' select and boxes (MOSS's text boxes too), and Edit in
 * box's boxes. A tool is what it does with the pointer and what it draws over the picture; the layer (StageLayer) hands it the
 * pointer in the picture's own pixels, the toolbar shows it, its key picks it. Nothing here knows what the tool is for.
 */

/** The pointer as a tool gets it: in the picture's pixels (outside it below 0 or past its size), and how it is pressed. */
export interface LayerPointer {
  x: number;
  y: number;
  /** How hard a pen presses, 0 to 1; a mouse or a finger always 1. */
  pressure: number;
  pen: boolean;
  /** Shift: the other way (a click that takes away, a box held square). */
  shift: boolean;
  /** Alt: take away rather than add (a box, a lasso). */
  alt: boolean;
}

export interface LayerTool {
  id: string;
  /** The one key that picks it (a letter), said in its button's tip and beside the bar while it is in hand. */
  key: string;
  label: string;
  icon: LucideIcon;
  /** More than its label, for its tip. */
  tip?: string;
  /** How the pointer looks over the layer: the brush's rings (BrushCursor), a cross, or the arrow. */
  cursor: "brush" | "crosshair" | "default";
  /** A tool that acts once when picked (invert), rather than being held: it never becomes the active one. */
  act?(): void;
  down?(p: LayerPointer): void;
  move?(p: LayerPointer): void;
  up?(p: LayerPointer): void;
  /** The press was cut short (a second finger: a pinch, not a stroke): what it began is taken back. */
  cancel?(): void;
  /** What it draws over the picture now: a box being drawn, a lasso's line, the frame, the points clicked. */
  draw?(place: LayerPlace): ReactNode;
  /** Off, with why in its tip (a click to mask while the picture has nothing to find in). */
  disabled?: string;
}

/**
 * A shape a tool leaves on the layer and keeps, for more than a mask: a detector's face to click, with what it found.
 * `payload` is the user's own (what the shape is for).
 */
export interface LayerShape<P> {
  id: string;
  /** Where it is, in the picture's pixels. */
  box: Rect;
  label: string;
  payload: P;
}

/**
 * A group's caption on the toolbar (Mask, Box, Frame, View), over the tools that follow it. `tone` "box": they are drawn in
 * the edit box's blue when in hand, as the boxes they draw.
 */
export interface ToolGroup {
  group: string;
  tone?: "box";
}

/** The toolbar's list: tools, or a group's caption over those that follow it. */
export type ToolbarItem = LayerTool | ToolGroup;

export const isTool = (t: ToolbarItem): t is LayerTool => !("group" in t);

/** The tool a key picks, among those shown (a letter, either case; Ctrl, Alt and Meta are other keys' own). */
export function toolForKey(items: readonly ToolbarItem[], e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): LayerTool | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return undefined;
  const k = e.key.toLowerCase();
  return items.find((t): t is LayerTool => isTool(t) && !t.disabled && t.key.toLowerCase() === k);
}

/**
 * The Hand: a press moves the picture rather than drawing on it. For a finger or a pen, which have neither Space nor a
 * middle button; while it is the active tool, ZoomPicture is given `panMode` "hand".
 */
export const HAND_TOOL: LayerTool = { id: "hand", key: "H", label: "Move the picture", icon: Hand, cursor: "default", tip: "Drag to move the picture (or hold Space, or the middle button, with any tool)" };
