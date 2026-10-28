import { useEffect, useRef, useState, type RefObject } from "react";
import { useDebounced } from "../../hooks";
import { PAD, ZOOM } from "../model";

/**
 * A timeline's zoom and scroll, kept in this browser (card #140): the owner left a long timeline zoomed in on its middle,
 * came back, and found it fitted whole again. `fromMs` is the moment at the track's left edge (in its own time, below 0
 * when scrolled to its very start, where the room before the first clip shows); `whole`: Fit all was the last word, and
 * the timeline is fitted again on return, whatever its length by then.
 */
export interface KeptView {
  pps: number;
  fromMs: number;
  whole: boolean;
}

const KEY = "afflatus.track.zoom";
/** How many timelines are remembered: the ones looked at last. */
const MOST = 50;

type Kept = Record<string, KeptView & { at: number }>;
const readAll = (): Kept => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Kept) : {};
  } catch {
    return {};
  }
};

/** The view kept for a timeline, if any (and sound). */
export function keptViewOf(timeline: string): KeptView | null {
  const v = readAll()[timeline];
  return v && Number.isFinite(v.pps) && v.pps > 0 && Number.isFinite(v.fromMs) ? { pps: v.pps, fromMs: v.fromMs, whole: Boolean(v.whole) } : null;
}

export function keepView(timeline: string, view: KeptView) {
  const all = readAll();
  all[timeline] = { ...view, at: Date.now() };
  const ids = Object.keys(all).sort((a, b) => all[b]!.at - all[a]!.at);
  for (const id of ids.slice(MOST)) delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* a private window, or the storage full: not kept */
  }
}

/**
 * A kept view brought back on a timeline that may have changed since: its zoom within the track's bounds, and its left edge
 * no further than leaves the timeline's end (`fitMs`) at the view's right (a timeline made shorter is not shown past its
 * end), nor before the track's own start.
 */
export function restoredView(kept: KeptView, fitMs: number, widthPx: number): { pps: number; fromMs: number } {
  const pps = Math.max(ZOOM.least, Math.min(ZOOM.most, kept.pps));
  const startMs = (-PAD / pps) * 1000;
  const lastMs = fitMs - (Math.max(0, widthPx - PAD * 2) / pps) * 1000;
  return { pps, fromMs: Math.max(startMs, Math.min(Math.max(startMs, lastMs), kept.fromMs)) };
}

/**
 * Keeps the track's view as it is scrolled and zoomed, written once it has stood still a moment (useDebounced) and as the
 * track goes, never on each frame of a scroll: a scroll only sets this small part's state. Draws nothing. Not before the
 * view kept for the timeline is brought back (`ready`): the zoom the track starts at would be written over it.
 */
export function KeptZoom({ scroller, pps, timeline, whole, ready }: {
  scroller: RefObject<HTMLDivElement | null>;
  pps: number;
  timeline: string;
  /** Fit all was the last word (useTrackZoom's). */
  whole(): boolean;
  /** The view kept for `timeline` has been brought back (or there was none). */
  ready(): boolean;
}) {
  const [now, setNow] = useState<{ timeline: string; view: KeptView } | null>(null);
  // the view read last, for the track going before it settles (read at the scroll, not at the drawing that follows it)
  const last = useRef(now);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => {
      if (!ready() || el.clientWidth <= 0) return;
      const view = { pps, fromMs: Math.round(((el.scrollLeft - PAD) / pps) * 1000), whole: whole() };
      last.current = { timeline, view };
      setNow((was) => (was && was.timeline === timeline && was.view.pps === view.pps && was.view.fromMs === view.fromMs && was.view.whole === view.whole ? was : { timeline, view }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    return () => el.removeEventListener("scroll", read);
    // whole and ready are read when the track scrolls or zooms
  }, [scroller, pps, timeline]); // eslint-disable-line react-hooks/exhaustive-deps -- whole and ready are read when the track scrolls or zooms
  const settled = useDebounced(now, 600, true, null);
  useEffect(() => {
    if (settled) keepView(settled.timeline, settled.view);
  }, [settled]);
  // the page left before it settled: what it showed last is kept all the same
  useEffect(() => () => {
    if (last.current) keepView(last.current.timeline, last.current.view);
  }, []);
  return null;
}
