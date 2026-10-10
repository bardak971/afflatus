import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { leavingNow } from "../../assetChange";
import { leaveCopy } from "../../leave";
import { cx } from "../../ui";
import { motionAllowed } from "../../useFlip";
import { justify } from "../library/justify";

/** The height a row aims for, by the display's size; the gap between tiles. */
export const ROW_HEIGHT = { S: 140, M: 210, L: 310 } as const;
const GAP = 8;
/** How long the glide is kept on after a change of the list (the move itself is --t-panel, shorter). */
const GLIDE_MS = 400;

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
export function JustifiedRows({ places, rowHeight, className, under = 0, rows: most, pages }: {
  places: Placed[];
  rowHeight: number;
  className?: string;
  /**
   * Which pages of the list are held (the first one's start): it changes when a page is let go above, past the cap, or
   * read again there. That change is laid out at once, not glided: the scroll keeps the user's place over it (useKeepPlace).
   */
  pages?: string;
  /** Room under every tile, in pixels, for a line its render draws there (the media shelf's captions); the shapes are the tiles' own. */
  under?: number;
  /** Only this many rows are drawn, the places past them left out (the loading placeholders fill a screen, no more). */
  rows?: number;
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
    const rows = justify(places.map((p) => p.aspect), width, rowHeight, GAP).slice(0, most);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- places is worked out from shapes, listed instead
  }, [shapes, width, rowHeight, under, most]);
  // the same tiles laid out again because the list changed (one binned or moved out, a new render first), at the same
  // width: each glides to its new place for a moment instead of every row jumping at once, so the eye can follow where
  // things went. A resize or another size lays out at once, as before.
  // decided during the drawing itself, so that the new places are drawn already with the glide on (set after, they would jump)
  const [seen, setSeen] = useState({ shapes, width, rowHeight, pages });
  const [gliding, setGliding] = useState(false);
  if (seen.shapes !== shapes || seen.width !== width || seen.rowHeight !== rowHeight || seen.pages !== pages) {
    setSeen({ shapes, width, rowHeight, pages });
    setGliding(seen.shapes !== shapes && Boolean(seen.shapes) && seen.width === width && width > 0 && seen.rowHeight === rowHeight && seen.pages === pages && motionAllowed());
  }
  useEffect(() => {
    if (!gliding) return;
    const t = setTimeout(() => setGliding(false), GLIDE_MS);
    return () => clearTimeout(t);
  }, [gliding, shapes]);
  // one box, every tile placed in it: a tile keeps its element when a new item pushes it to another row (no image read again)
  return (
    <div ref={box} className={cx("relative min-w-0", className)} style={{ height: laid.height }}>
      {places.map((p, i) => {
        const at = laid.at[i];
        return at ? <PlaceBox key={p.key} id={p.key} at={at} glide={gliding}>{p.render()}</PlaceBox> : null;
      })}
    </div>
  );
}

/**
 * One tile's place. An item that leaves the list on purpose (moved, binned: assetChange.tsx) fades out where it was rather
 * than vanish; a list changed for another reason (another folder, a search) is not played out. `data-item-id`: where a
 * refused change shakes the item back.
 */
function PlaceBox({ id, at, glide, children }: { id: string; at: CSSProperties; /** Laid out again for a change of the list: it glides to its new place. */ glide?: boolean; children: ReactNode }) {
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    return () => {
      if (leavingNow.has(id)) leaveCopy(el, "m-out");
    };
  }, [id]);
  return <div ref={ref} data-item-id={id} className={cx("absolute", glide && "transition-[left,top,width,height] duration-(--t-panel) ease-(--ease-snap)")} style={at}>{children}</div>;
}

/**
 * The user's place in a grid kept over a change of its pages. Past the cap (data.ts useAssets) a page read below lets
 * the top one go, and one read above lets the bottom one go: the tiles are placed absolutely, so the browser's own
 * scroll anchoring cannot follow them, and the tile in view jumped by a page's height (which put the sentinel in view
 * again, and a page or three were read and skipped). The first tile in view is noted as the grid scrolls; when `pages`
 * changes, the scroll moves by as much as that tile did, so it stays where it was on the screen. `items`: the list
 * shown, noted again once a change of it has glided into place.
 */
export function useKeepPlace(box: RefObject<HTMLElement | null>, pages: string, items: unknown): void {
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const note = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    anchor.current = null;
    for (const tile of el.querySelectorAll<HTMLElement>("[data-item-id]")) {
      const r = tile.getBoundingClientRect();
      if (r.bottom > top) {
        anchor.current = { id: tile.dataset.itemId!, top: r.top - top };
        return;
      }
    }
  }, [box]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // once a frame at most, while it scrolls
    let frame = 0;
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; note(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [box, note]);
  useEffect(() => {
    const t = setTimeout(note, GLIDE_MS);
    return () => clearTimeout(t);
  }, [items, note]);
  const was = useRef(pages);
  useLayoutEffect(() => {
    if (was.current === pages) return;
    was.current = pages;
    const el = box.current;
    const at = anchor.current;
    const tile = el && at ? el.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(at.id)}"]`) : null;
    if (el && at && tile) el.scrollTop += tile.getBoundingClientRect().top - el.getBoundingClientRect().top - at.top;
    note();
  }, [box, pages, note]);
}

/**
 * The shapes the grid had the last time each list was shown (by the list's key), kept in this browser: the placeholders
 * of the next visit take them, so the real tiles land in the same rows instead of the whole grid moving once. Best
 * effort: without storage it falls back to the usual mix.
 */
const SHAPES_KEY = "afflatus.grid-shapes";
export function rememberShapes(list: string, shapes: number[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(SHAPES_KEY) ?? "{}") as Record<string, number[]>;
    const rounded = shapes.slice(0, 120).map((x) => Math.round(x * 100) / 100);
    if (JSON.stringify(all[list]) === JSON.stringify(rounded)) return;
    delete all[list];
    // the last dozen lists are enough: the oldest go first
    const kept = Object.entries(all).slice(-11);
    localStorage.setItem(SHAPES_KEY, JSON.stringify(Object.fromEntries([...kept, [list, rounded]])));
  } catch {
    /* no storage here: the placeholders keep the usual mix */
  }
}
function recalledShapes(list: string | undefined): number[] | null {
  if (!list) return null;
  try {
    const shapes = (JSON.parse(localStorage.getItem(SHAPES_KEY) ?? "{}") as Record<string, number[]>)[list];
    return shapes?.length ? shapes : null;
  } catch {
    return null;
  }
}

/** The shapes the loading placeholders take, in turn: a library's usual mix of landscape, portrait and square. */
const PLACEHOLDER_SHAPES = [1.5, 0.75, 1, 16 / 9, 2 / 3, 4 / 3, 0.8, 1.5, 1, 0.75, 16 / 9, 1];
/** Enough placeholders for the widest screen at the smallest size: the rows cut them to a screen's height. */
const PLACEHOLDER_COUNT = 160;

/**
 * The grid while its first page is on its way: placeholder tiles in justified rows at the display's size, a screen high,
 * each with the loading shine. The real tiles take the same rows at the same height when the page lands, so the grid
 * fills in rather than jumps.
 */
export function PlaceholderRows({ rowHeight, list }: { rowHeight: number; /** The list's key: its shapes from the last visit, when known (rememberShapes). */ list?: string }) {
  const places = useMemo<Placed[]>(
    () => (recalledShapes(list) ?? Array.from({ length: PLACEHOLDER_COUNT }, (_, i) => PLACEHOLDER_SHAPES[i % PLACEHOLDER_SHAPES.length]!)).map((aspect, i) => ({
      key: `placeholder-${i}`,
      aspect,
      // rounded as a tile is: the kit's placeholder has smaller corners of its own, which a plain utility does not outweigh
      render: () => <div className="m-skeleton h-full rounded-xl!" />,
    })),
    [list],
  );
  const rows = Math.max(1, Math.ceil((typeof window === "undefined" ? 900 : window.innerHeight) / (rowHeight + GAP)));
  return (
    <div aria-busy="true" aria-label="Loading the library">
      <JustifiedRows places={places} rowHeight={rowHeight} rows={rows} />
    </div>
  );
}
