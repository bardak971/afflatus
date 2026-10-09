import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "../../ui";
import { justify } from "../library/justify";

/** The height a row aims for, by the display's size; the gap between tiles. */
export const ROW_HEIGHT = { S: 140, M: 210, L: 310 } as const;
const GAP = 8;

/** One place in the rows: a tile at a shape (width over height), drawn when its row is. */
export interface Placed {
  key: string;
  aspect: number;
  render(): ReactNode;
}

/**
 * Tiles in justified rows (justify.ts): each at its item's own shape, every row as high as the others and
 * as wide as the grid; the last row, not full, at the target height. In the list's order, row after row,
 * so Tab and the screen readers go through them as before.
 */
export function JustifiedRows({ places, rowHeight, className, under = 0 }: {
  places: Placed[];
  rowHeight: number;
  className?: string;
  /** Room under every tile, in pixels, for a line its render draws there (the media shelf's captions); the shapes are the tiles' own. */
  under?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const seen = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const shapes = places.map((p) => p.aspect).join();
  // where each tile goes: worked out again only when the shapes, the width or the size change
  const laid = useMemo(() => {
    const rows = justify(places.map((p) => p.aspect), width, rowHeight, GAP);
    const at: Array<{ left: number; top: number; width: number; height: number }> = [];
    let top = 0;
    for (const r of rows) {
      let left = 0;
      for (const w of r.widths) {
        at.push({ left, top, width: w, height: r.height + under });
        left += w + GAP;
      }
      top += r.height + under + GAP;
    }
    return { at, height: Math.max(0, top - GAP) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, width, rowHeight, under]);
  // one box, every tile placed in it: a tile keeps its element when a new item pushes it to another row (no image read again)
  return (
    <div ref={box} className={cx("relative min-w-0", className)} style={{ height: laid.height }}>
      {places.map((p, i) => {
        const at = laid.at[i];
        return at ? <div key={p.key} className="absolute" style={at}>{p.render()}</div> : null;
      })}
    </div>
  );
}
