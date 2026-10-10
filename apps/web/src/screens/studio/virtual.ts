import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type FocusEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { scrollBoxOf } from "../../LoadMore";
import type { Row } from "../library/justify";

/**
 * A long list drawn only where it is seen: the library's grid holds every page read (thousands of items), and only the
 * rows in the view of the box it scrolls in, with a margin, are drawn. Each row's place is worked out beforehand
 * (justify.ts for the grid, the shapes for the stage's column), so the list keeps its whole height and nothing moves
 * as rows come and go. The arithmetic is pure, and tested; the hooks below read the scroll.
 */

/** A row's place in its list, in pixels from the list's top. */
export interface Band {
  top: number;
  bottom: number;
}
/** The rows drawn: [first, end). */
export interface Span {
  first: number;
  end: number;
}

/** A tile's box in the grid. */
export interface At {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Justified rows placed one under the other: each tile's box (in the list's order), each row's band, and the height
 * of the whole. `under`: room under every tile for a line of its own.
 */
export function placeRows(rows: Row[], under: number, gap: number): { at: At[]; bands: Band[]; height: number } {
  const at: At[] = [];
  const bands: Band[] = [];
  let top = 0;
  for (const r of rows) {
    let left = 0;
    const height = r.height + under;
    for (const w of r.widths) {
      at.push({ left, top, width: w, height });
      left += w + gap;
    }
    bands.push({ top, bottom: top + height });
    top += height + gap;
  }
  return { at, bands, height: Math.max(0, top - gap) };
}

/** A section of the grid as it is laid out: where it starts and how high it is, its items [first, end) of the whole list. */
export interface GroupPlace {
  top: number;
  height: number;
  first: number;
  end: number;
  /** Where its tiles start, under its heading. */
  body: number;
}
/** Sections of justified rows, laid out together: one list of bands (headings and rows) for the whole grid. */
export interface GroupsLaid {
  /** Each tile's box, from the top of its section's body. */
  at: At[];
  groups: GroupPlace[];
  bands: Band[];
  /** What each band is: a row's items [first, end), and its section; a heading has no items. */
  bandOf: Array<{ group: number; first: number; end: number }>;
  height: number;
}

/**
 * Sections of tiles (the grid by day, by draft, by timeline; or one, with no heading) laid out one under the other:
 * each its heading of `head` pixels, `headGap` under it, and its justified rows; `groupGap` above every section with a
 * heading. `rows`: the rows of each section, from justify.ts.
 */
export function layGroups(groups: Array<{ rows: Row[]; head: number }>, o: { gap: number; under?: number; headGap: number; groupGap: number }): GroupsLaid {
  const at: At[] = [];
  const places: GroupPlace[] = [];
  const bands: Band[] = [];
  const bandOf: GroupsLaid["bandOf"] = [];
  let top = 0;
  let item = 0;
  groups.forEach((g, n) => {
    if (g.head) top += o.groupGap;
    const start = top;
    const first = item;
    if (g.head) {
      bands.push({ top, bottom: top + g.head });
      bandOf.push({ group: n, first: item, end: item });
    }
    const body = g.head ? g.head + o.headGap : 0;
    const laid = placeRows(g.rows, o.under ?? 0, o.gap);
    at.push(...laid.at);
    g.rows.forEach((r, k) => {
      bands.push({ top: start + body + laid.bands[k]!.top, bottom: start + body + laid.bands[k]!.bottom });
      bandOf.push({ group: n, first: item + r.start, end: item + r.end });
    });
    item += g.rows.length ? g.rows[g.rows.length - 1]!.end : 0;
    const height = body + laid.height;
    places.push({ top: start, height, first, end: item, body });
    top = start + height;
  });
  return { at, groups: places, bands, bandOf, height: top };
}

/**
 * What to draw of sections laid out together: the sections that have a band in the span, or an item held, each with
 * its items in view (and those held), in the list's order.
 */
export function drawnGroups(laid: Pick<GroupsLaid, "bandOf" | "groups">, span: Span, held: number[]): Array<{ group: number; items: number[] }> {
  const by = new Map<number, number[]>();
  const add = (group: number, i?: number) => {
    let list = by.get(group);
    if (!list) by.set(group, (list = []));
    if (i !== undefined) list.push(i);
  };
  for (let b = span.first; b < span.end; b++) {
    const band = laid.bandOf[b];
    if (!band) continue;
    add(band.group);
    for (let i = band.first; i < band.end; i++) add(band.group, i);
  }
  for (const i of held) {
    const group = laid.groups.findIndex((g) => i >= g.first && i < g.end);
    if (group >= 0) add(group, i);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([group, items]) => ({ group, items: [...new Set(items)].sort((a, b) => a - b) }));
}

/** Rows of the given heights one under the other, `gap` between them (the stage's column). */
export function stackBands(heights: number[], gap: number): Band[] {
  const bands: Band[] = [];
  let top = 0;
  for (const h of heights) {
    bands.push({ top, bottom: top + h });
    top += h + gap;
  }
  return bands;
}

/** The rows that meet [from, to): binary searches, the bands being in order. Empty when none does. */
export function meeting(bands: Band[], from: number, to: number): Span {
  let lo = 0;
  let hi = bands.length;
  // the first band whose bottom is below `from`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bands[mid]!.bottom <= from) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  hi = bands.length;
  // the first band whose top is at `to` or past it
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bands[mid]!.top < to) lo = mid + 1;
    else hi = mid;
  }
  return { first, end: Math.max(first, lo) };
}

/**
 * The rows to draw for a view [top, bottom) of the list, given those drawn now. They are kept while they still cover
 * the view and half the margin each way, and reach no further than twice the margin, so a slow scroll draws again only
 * every half margin, not at each row; past that, the view and the whole margin each way. `margin`: how far beyond the view rows are drawn (a screen, usually),
 * so a quick scroll does not show an empty place before the rows come.
 */
export function nextSpan(now: Span | null, bands: Band[], top: number, bottom: number, margin: number): Span {
  const need = meeting(bands, top - margin / 2, bottom + margin / 2);
  // and no further than twice the margin: rows scrolled far away are let go, a list scrolled past entirely draws none
  const most = meeting(bands, top - 2 * margin, bottom + 2 * margin);
  const empty = now !== null && now.first === now.end;
  const covers = now !== null && now.first <= need.first && now.end >= need.end && (empty || (now.first >= most.first && now.end <= most.end));
  if (now && covers && now.end <= bands.length) return now;
  return meeting(bands, top - margin, bottom + margin);
}

/** The indices to draw: those of the rows of the span, and the ones held (focused, dragged) wherever they are, in order. */
export function drawnIndices(rows: Array<Pick<Row, "start" | "end">>, span: Span, held: number[]): number[] {
  const out: number[] = [];
  // no row in view (a section scrolled past): only what is held
  const first = span.first < span.end ? rows[span.first]?.start ?? 0 : 0;
  const end = span.first < span.end ? rows[span.end - 1]?.end ?? 0 : 0;
  for (const i of held) if (i >= 0 && i < first) out.push(i);
  for (let i = first; i < end; i++) out.push(i);
  for (const i of held) if (i >= end) out.push(i);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** A list drawn in part, as the scroll of its box sees it: what it would draw now, and how to draw it. */
interface Watcher {
  next(): Span | null;
  set(span: Span): void;
}
/** The lists drawn in part, by the box they scroll in (null: the page): one listener for each box, however many lists. */
const watching = new Map<HTMLElement | null, Set<Watcher>>();
const stops = new WeakMap<Set<Watcher>, () => void>();
function watch(scroller: HTMLElement | null, w: Watcher): () => void {
  let all = watching.get(scroller);
  if (!all) {
    const lists = new Set<Watcher>();
    all = lists;
    watching.set(scroller, lists);
    // every list's place read first, then the ones that change drawn in one go, in the scroll's own frame (flushSync):
    // a quick scroll never shows the place empty, and the grid by day (hundreds of lists) is laid out once a scroll
    const onScroll = () => {
      const changes: Array<[Watcher, Span]> = [];
      for (const l of lists) {
        const n = l.next();
        if (n) changes.push([l, n]);
      }
      if (changes.length) flushSync(() => changes.forEach(([l, n]) => l.set(n)));
    };
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    const seen = new ResizeObserver(() => lists.forEach((l) => { const n = l.next(); if (n) l.set(n); }));
    if (scroller) seen.observe(scroller);
    stops.set(lists, () => {
      target.removeEventListener("scroll", onScroll);
      seen.disconnect();
    });
  }
  all.add(w);
  return () => {
    all.delete(w);
    if (all.size) return;
    stops.get(all)?.();
    stops.delete(all);
    watching.delete(scroller);
  };
}
/**
 * The rows of `bands` (from the top of `box`) that are to be drawn, kept up with the scroll of the box the list is in
 * and with its size. Read again after every draw too: a list above it (a section, the bin's strip) may have grown.
 */
export function useSpan(box: RefObject<HTMLElement | null>, bands: Band[]): Span {
  const [span, setSpan] = useState<Span>({ first: 0, end: 0 });
  const now = useRef<Span | null>(null);
  const latest = useRef(bands);
  latest.current = bands;
  // the box it scrolls in, found once: looking it up reads the styles of every box up the page
  const scroller = useRef<HTMLElement | null | undefined>(undefined);
  /** What to draw now, or null when it is what is drawn. Reads the places only, so that many lists are read before one is drawn. */
  const next = useCallback((): Span | null => {
    const el = box.current;
    if (!el) return null;
    if (scroller.current === undefined) scroller.current = scrollBoxOf(el);
    const view = scroller.current;
    const viewTop = view ? view.getBoundingClientRect().top : 0;
    const viewHeight = view ? view.clientHeight : window.innerHeight;
    const top = viewTop - el.getBoundingClientRect().top;
    const n = nextSpan(now.current, latest.current, top, top + viewHeight, Math.max(400, viewHeight));
    if (now.current && n.first === now.current.first && n.end === now.current.end) return null;
    return n;
  }, [box]);
  const set = useCallback((n: Span) => {
    now.current = n;
    setSpan(n);
  }, []);
  // after every draw: the bands may have changed, or what is above the list
  useLayoutEffect(() => {
    const n = next();
    if (n) set(n);
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (scroller.current === undefined) scroller.current = scrollBoxOf(el);
    return watch(scroller.current, { next, set });
  }, [box, next, set]);
  return span;
}

/**
 * The item focused or dragged in a list drawn in part: it stays drawn while it is out of the view, so Tab goes on from
 * it, and a drag scrolled away from where it started still ends where it began (its element gone, the drag's end
 * would never come). Hand the handlers to the list's box; the items carry `data-item-id`.
 */
export function useHeld() {
  const [focused, setFocused] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const idOf = (t: EventTarget | null) => ((t as HTMLElement | null)?.closest?.("[data-item-id]") as HTMLElement | null)?.dataset.itemId ?? null;
  const handlers = {
    onFocus: (e: FocusEvent) => setFocused(idOf(e.target)),
    onBlur: (e: FocusEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
    },
    onDragStart: (e: DragEvent) => setDragged(idOf(e.target)),
    onDragEnd: () => setDragged(null),
  };
  const held = [focused, dragged].filter((x): x is string => x !== null);
  return { held, handlers };
}
