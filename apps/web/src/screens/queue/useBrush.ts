import { useState } from "react";

/** A drag shorter than this is a click, not a window to look at. */
const BRUSH_LEAST = 6;

/** Where a drag went, in pixels across the element: [left, right], or null when it is too short to mean a window. */
export const brushSpan = (drag: { x0: number; x1: number } | null): [number, number] | null => {
  if (!drag) return null;
  const [a, b] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
  return b - a < BRUSH_LEAST ? null : [a, b];
};

type Pointer = { clientX: number; button?: number; currentTarget: Element };
const across = (e: Pointer) => e.clientX - e.currentTarget.getBoundingClientRect().left;

/**
 * A window of time dragged across a chart, as the charts of the render times have it (Chart.tsx and the
 * lanes): pressed, moved, let go. `end` gives the span dragged across, null for a click.
 */
export function useBrush(on = true) {
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  return {
    drag,
    start(e: Pointer): boolean {
      if (!on || e.button !== 0) return false;
      setDrag({ x0: across(e), x1: across(e) });
      return true;
    },
    move(e: Pointer) {
      if (drag) setDrag({ ...drag, x1: across(e) });
    },
    end(): [number, number] | null {
      const span = brushSpan(drag);
      setDrag(null);
      return span;
    },
    cancel: () => setDrag(null),
  };
}
