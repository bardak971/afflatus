import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { cx } from "../cx";
import { dialogOver, OVER } from "../Dialog";
import { typing } from "../Keys";
import type { LayerPlace } from "../viewer/ZoomPicture";
import { BrushCursor } from "./BrushCursor";
import { nextView } from "./maskView";
import { toolForKey, type LayerPointer, type LayerTool, type ToolbarItem } from "./tools";
import type { MaskLayer } from "./useMaskLayer";

/** A finger seen this soon after a pen is the hand resting on the screen, not a stroke. */
const PEN_RESTS_MS = 1500;
/** A touch this large (CSS pixels across, both ways) is a palm, not a fingertip. */
const PALM_PX = 36;

/**
 * The Stage's drawing layer: laid over the picture inside ZoomPicture's zoomed box (its `overlay`), it hands the pointer
 * to the tool in the picture's own pixels, and shows what the layer holds (the mask, a tool's shapes) and the brush.
 * A mouse, a pen (its pressure goes to the tool) or a finger; a finger while a pen is in use, or one as large as a palm,
 * is left out, and a second finger ends the stroke (a pinch is not paint). Presses that pan (Space, the middle button,
 * the Hand) are ZoomPicture's: the layer leaves them.
 */
export function StageLayer({ place, tool, mask, children }: {
  place: LayerPlace;
  tool: LayerTool | null;
  /** The mask, drawn under the tools' shapes, its brush shown as the cursor of a brush tool. */
  mask?: MaskLayer;
  children?: ReactNode;
}) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // the press going on: its pointer, and the tool it began with (put down when another is picked mid-drag)
  const active = useRef<{ id: number; touch: boolean; tool: LayerTool } | null>(null);
  const penSeen = useRef(0);
  // a press that closes what is open over the Stage (a popover, a menu, a list) only closes it (owner, card #274): whether
  // something was open is read as the press starts, before its own outside-click shuts it. Registered when the layer
  // mounts, so ahead of any popover opened over it since, whose capture listener then runs after this one
  const covered = useRef(false);
  useEffect(() => {
    const seen = () => {
      covered.current = Boolean(document.querySelector(OVER));
    };
    window.addEventListener("pointerdown", seen, true);
    return () => window.removeEventListener("pointerdown", seen, true);
  }, []);
  // the tool as it is now: a stroke goes on over several renders
  const now = useRef(tool);
  now.current = tool;

  const pointer = (e: { clientX: number; clientY: number; pressure: number; pointerType: string; shiftKey: boolean; altKey: boolean }): LayerPointer => ({
    ...place.toPicture(e.clientX, e.clientY),
    pressure: e.pointerType === "pen" ? e.pressure : 1,
    pen: e.pointerType === "pen",
    shift: e.shiftKey,
    alt: e.altKey,
  });
  const palm = (e: ReactPointerEvent) => e.pointerType === "touch" && (Date.now() - penSeen.current < PEN_RESTS_MS || (e.width > PALM_PX && e.height > PALM_PX));
  const end = (e: ReactPointerEvent, how: "up" | "cancel") => {
    if (active.current?.id !== e.pointerId) return;
    active.current = null;
    if (how === "up") now.current?.up?.(pointer(e));
    else now.current?.cancel?.();
  };

  // a tool put down halfway (another picked by its key during a drag) leaves nothing half drawn; the tool object itself is
  // new at each render, so this follows which tool it is
  const toolId = tool?.id;
  useEffect(() => () => {
    active.current?.tool.cancel?.();
    active.current = null;
  }, [toolId]);

  const brush = tool?.cursor === "brush" && mask && hover && !place.panning;
  return (
    <div
      data-stage-layer
      className={cx("absolute inset-0 touch-none", !place.panning && (tool?.cursor === "brush" ? "cursor-none" : tool?.cursor === "crosshair" && "cursor-crosshair"))}
      onPointerDown={(e) => {
        if (e.pointerType === "pen") penSeen.current = Date.now();
        // the middle button and Space pan (ZoomPicture's own); a palm or a resting hand is no press
        if (covered.current) {
          covered.current = false;
          e.preventDefault();
          return;
        }
        if (place.panning || e.button !== 0 || palm(e) || !tool?.down) return;
        if (active.current) {
          // a second finger: a pinch, not paint; the stroke the first one began is taken back
          if (active.current.touch && e.pointerType === "touch") {
            active.current.tool.cancel?.();
            active.current = null;
          }
          return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        active.current = { id: e.pointerId, touch: e.pointerType === "touch", tool };
        tool.down(pointer(e));
      }}
      onPointerMove={(e) => {
        if (e.pointerType === "pen") penSeen.current = Date.now();
        if (palm(e)) return;
        setHover(place.toPicture(e.clientX, e.clientY));
        if (active.current?.id !== e.pointerId) return;
        // a pen moves faster than the screen draws: each of its points between two frames, for a smooth line
        const points = e.pointerType === "pen" ? e.nativeEvent.getCoalescedEvents?.() ?? [] : [];
        if (points.length > 1) for (const p of points) now.current?.move?.(pointer({ ...p, pointerType: "pen" }));
        else now.current?.move?.(pointer(e));
      }}
      onPointerUp={(e) => end(e, "up")}
      onPointerCancel={(e) => end(e, "cancel")}
      onPointerLeave={() => setHover(null)}
    >
      {mask?.draw(place)}
      {children}
      {tool?.draw?.(place)}
      {brush && <BrushCursor place={place} at={hover} size={mask.brush.size} feather={mask.brush.feather} />}
    </div>
  );
}

/**
 * The layer's keys, while it is on screen: a tool's letter picks it (or does it, for invert), [ and ] the brush's size
 * (with Shift: its feather), M the mask's next view (Tint, Spotlight, B&W, Off), Ctrl+Z and Ctrl+Shift+Z (Ctrl+Y) undo and redo. Not while typing,
 * nor under a dialog opened over the layer (`root`: what the layer is in). [ and ] are also read by where they sit (a
 * French keyboard has them under AltGr), as every paint program does.
 */
export function useLayerKeys({ items, onPick, mask, root }: {
  items: readonly ToolbarItem[];
  onPick(id: string): void;
  mask?: MaskLayer;
  root?: RefObject<HTMLElement | null>;
}) {
  const now = useRef({ items, onPick, mask });
  now.current = { items, onPick, mask };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e) || dialogOver(root?.current)) return;
      const { items: list, onPick: pick, mask: m } = now.current;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (m && ctrl && ((k === "z" && e.shiftKey) || k === "y")) {
        e.preventDefault();
        return m.redo();
      }
      if (m && ctrl && k === "z") {
        e.preventDefault();
        return m.undo();
      }
      const smaller = e.key === "[" || e.key === "{" || e.code === "BracketLeft";
      const larger = e.key === "]" || e.key === "}" || e.code === "BracketRight";
      if (m && !ctrl && (smaller || larger)) {
        e.preventDefault();
        if (e.shiftKey) m.setBrush({ feather: m.brush.feather + (larger ? 4 : -4) });
        else m.setBrush({ size: larger ? Math.max(m.brush.size + 2, m.brush.size * 1.2) : Math.min(m.brush.size - 2, m.brush.size / 1.2) });
        return;
      }
      if (m && !ctrl && !e.altKey && k === "m") {
        e.preventDefault();
        return m.setView(nextView);
      }
      const t = toolForKey(list, e);
      if (!t) return;
      e.preventDefault();
      if (t.act) t.act();
      else pick(t.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);
}
