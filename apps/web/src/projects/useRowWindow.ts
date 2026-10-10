import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { rowOffsets, rowWindow, type Row } from "./tree";

/** Rows drawn above and below those in sight: a long list draws only these (a folder of thousands of items stays quick). */
const OVERSCAN = 10;

/**
 * The Projects panel's list drawn in a window: only the rows in sight (and a few more) are drawn, the others stand as gaps
 * as tall as they are. The row the keys are on is brought into sight inside the list, clear of the column heads (`head`)
 * and of the Bin at its foot (`footHeight`).
 */
export function useRowWindow({ list, rows, focused, footHeight, opened }: {
  list: RefObject<HTMLDivElement | null>;
  rows: Row[];
  /** The row the keys are on. */
  focused: string | null;
  /** How much of the list's foot the Bin covers. */
  footHeight: number;
  /** The panel is placed (its list drawn). */
  opened: boolean;
}) {
  // the part of the list in sight, from its first row's top: a long list draws only the rows there
  const head = useRef<HTMLDivElement>(null);
  const firstGap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 1200 });
  const measure = () => {
    const el = list.current;
    if (!el) return;
    const top = el.scrollTop - (firstGap.current?.offsetTop ?? 0);
    const height = el.clientHeight;
    setView((v) => (v.top === top && v.height === height ? v : { top, height }));
  };
  // the list drawn in a window: where each row sits
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const offsets = useMemo(() => rowOffsets(rows), [rows]);
  // the list's size followed: more rows drawn when it grows
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  // the row the keys are on brought into sight inside the list (never the page), clear of the column heads and of the Bin at its foot
  useLayoutEffect(() => {
    const el = list.current;
    const i = focused ? indexOf.get(focused) : undefined;
    if (!el || i === undefined || rows[i]!.kind === "bin") return;
    const start = firstGap.current?.offsetTop ?? 0;
    const above = head.current?.offsetHeight ?? 0;
    const top = start + offsets[i]!;
    const bottom = start + offsets[i + 1]!;
    // the first row: the list from its very top, as it opens
    if (top < el.scrollTop + above) el.scrollTop = i === 0 ? 0 : top - above;
    else if (bottom > el.scrollTop + el.clientHeight - footHeight) el.scrollTop = bottom - el.clientHeight + footHeight;
    measure();
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The rows drawn: those in sight and a few more, and the rows to keep drawn whatever the scroll (by key); gaps for the rest. */
  const drawn = (keep: (string | null | undefined)[]) =>
    rowWindow(offsets, view.top, view.height, OVERSCAN, keep.map((k) => (k ? indexOf.get(k) ?? -1 : -1))).flatMap((p): ({ gap: number } | { r: Row; i: number })[] => ("gap" in p ? [p] : rows.slice(p.from, p.to).map((r, k) => ({ r, i: p.from + k }))));
  return { head, firstGap, measure, drawn };
}
