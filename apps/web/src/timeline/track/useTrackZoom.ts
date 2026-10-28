import { useEffect, useRef, type RefObject } from "react";
import { AGENT_MS, useTimelineEdits } from "../../agentEdits";
import type { Clock } from "../clock";
import { PAD, placeOf, ZOOM, type Slot } from "../model";
import { STRIP } from "./EndColumn";
import { keptViewOf, restoredView } from "./KeptZoom";

/** What the editor's keys reach on the track: a zoom step around the playhead, and Fit all. */
export interface TrackKeys {
  zoom(by: -1 | 1): void;
  fit(): void;
  /** The track scrolled to have a moment (in its own time) in its middle, the zoom kept: a recording opened there. */
  centre(ms: number): void;
}

/**
 * The track's zoom: Ctrl + wheel around the pointer (a plain wheel scrolls it sideways), a step around the playhead (the
 * editor's - and =, filled into `keys`), Fit all (Shift+Z). Arriving, the view kept for the timeline is brought back
 * (KeptZoom, card #140), else the whole timeline is fitted; it is fitted again when a clip is added (not split, nor brought
 * back by Undo; nor added by an MCP token while the zoom is the user's); a track showing the whole of it keeps doing so at
 * any width, until it is zoomed by hand.
 */
export function useTrackZoom({ scroller, pps, onZoom, slots, totalMs, fitMs, clock, cursorMs, timelineId, keys }: {
  scroller: RefObject<HTMLDivElement | null>;
  pps: number;
  onZoom(pps: number): void;
  slots: Slot[];
  totalMs: number;
  /** What Fit all brings into view: the clips, and the source with the windows still to make when they reach further. */
  fitMs: number;
  clock: Clock;
  cursorMs: number | null;
  timelineId: string;
  keys?: RefObject<TrackKeys | null>;
}) {
  // the whole timeline is in view because it was fitted (on arriving, Fit all, a clip added), not zoomed by hand since:
  // then a change of the track's width (the window, the column dragged or folded) fits it again
  const whole = useRef(false);
  /** A zoom asked by hand: what it shows is the person's from then on, kept through a change of width. */
  const zoomTo = (next: number) => {
    whole.current = false;
    onZoom(next);
  };
  // Ctrl + wheel zooms around the pointer; a plain wheel scrolls the track sideways (a mouse has no sideways wheel)
  const ppsNow = useRef(pps);
  ppsNow.current = pps;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const ms = ((px + el.scrollLeft - PAD) / ppsNow.current) * 1000;
        const next = Math.max(ZOOM.least, Math.min(ZOOM.most, ppsNow.current * Math.exp(-e.deltaY * 0.0015)));
        whole.current = false;
        onZoom(next);
        // the moment under the pointer stays under it
        requestAnimationFrame(() => { el.scrollLeft = Math.max(0, PAD + (ms / 1000) * next - px); });
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onZoom, scroller]);

  // the clips take the track but for the end column's slim strip after them (endColumnAt shows the strip where the full
  // column does not fit): room for the full 344 px column left the clips under half the track, none beside a wide inspector
  const fitAll = () => {
    const room = (scroller.current?.clientWidth ?? 800) - STRIP - PAD * 3;
    if (fitMs <= 0) return;
    whole.current = true;
    onZoom(Math.max(ZOOM.least, Math.min(ZOOM.most, room / (fitMs / 1000))));
    // from its start: a track scrolled before kept its place, the first clips off its left side with the whole fitting
    // (and the recording's stage, which shows what the track shows, with them)
    requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollLeft = 0;
    });
  };
  /** One zoom step out (-1) or in (1) around the playhead: it stays where it is on screen (brought to the middle when it was out of view). */
  const zoomAtHead = (by: -1 | 1) => {
    const el = scroller.current;
    const next = Math.max(ZOOM.least, Math.min(ZOOM.most, by > 0 ? pps * ZOOM.step : pps / ZOOM.step));
    if (!el || next === pps) return;
    whole.current = false;
    const layoutMs = cursorMs !== null ? Math.min(cursorMs, totalMs) : placeOf(slots, clock.get())?.layoutMs ?? 0;
    const shown = PAD + (layoutMs / 1000) * pps - el.scrollLeft;
    const px = shown >= 0 && shown <= el.clientWidth ? shown : el.clientWidth / 2;
    onZoom(next);
    requestAnimationFrame(() => { el.scrollLeft = Math.max(0, PAD + (layoutMs / 1000) * next - px); });
  };
  /** A moment (in the track's own time) brought to the middle of the view, the zoom kept. */
  const centre = (ms: number) => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, PAD + (ms / 1000) * ppsNow.current - el.clientWidth / 2);
  };
  if (keys) keys.current = { zoom: zoomAtHead, fit: fitAll, centre };
  // arriving on a timeline: the view it was left with (its zoom and scroll, made to fit what it is now), else the whole of
  // it; zooming after that is the person's
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (fitMs <= 0 || fittedFor.current === timelineId) return;
    // marked done only once it has run: a frame cancelled (the length settling a render later) asks again
    const id = requestAnimationFrame(() => {
      fittedFor.current = timelineId;
      const kept = keptViewOf(timelineId);
      if (!kept || kept.whole) return fitAll();
      const view = restoredView(kept, fitMs, scroller.current?.clientWidth ?? 800);
      whole.current = false;
      onZoom(view.pps);
      // a frame later, once the track is drawn at that zoom (wide enough to scroll that far)
      requestAnimationFrame(() => {
        if (scroller.current) scroller.current.scrollLeft = Math.max(0, PAD + (view.fromMs / 1000) * view.pps);
      });
    });
    return () => cancelAnimationFrame(id);
    // once per timeline, when its length is known
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per timeline, when its length is known
  }, [timelineId, fitMs]);
  // a clip added (New clip, a drop, a continuation): the whole timeline in view again, the new clip with it
  // (kept asked for until it has run: the new clip's length may settle a render later)
  // the new clip's panel opens beside the track as it is added and narrows it: a fit just made is made again for the new
  // width; and a track showing the whole timeline keeps showing all of it at any width (useRef `whole`)
  const fittedAt = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let width = el.clientWidth;
    const seen = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (whole.current || performance.now() - fittedAt.current < 1500) fitAll();
    });
    seen.observe(el);
    return () => seen.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- watched again only when the length changes; fitAll reads the latest through refs
  }, [fitMs]);
  // a clip added is one never on this track before that makes the clips longer: a split (S, Ctrl+B, at In / Out) makes a
  // new clip in the same length, an Undo or Redo brings back clips already seen; the zoom made to cut on a frame is kept
  const ids = slots.map((s) => s.clip.id).join(" ");
  const clipsMs = slots.length ? slots.at(-1)!.startMs + slots.at(-1)!.lengthMs : 0;
  const seen = useRef<{ timeline: string; ids: Set<string>; ms: number } | null>(null);
  const fitAsked = useRef(false);
  useEffect(() => {
    const now = ids ? ids.split(" ") : [];
    const was = seen.current;
    if (!was || was.timeline !== timelineId) seen.current = { timeline: timelineId, ids: new Set(now), ms: clipsMs };
    else {
      // one an MCP token added while the user zoomed by hand leaves their zoom as it is: they did not add it, and may be
      // working elsewhere on the track (a track showing the whole timeline goes on showing all of it)
      const agent = Date.now() - (useTimelineEdits.getState().going[timelineId] ?? -Infinity) < AGENT_MS;
      if (clipsMs > was.ms && now.some((id) => !was.ids.has(id)) && (whole.current || !agent)) fitAsked.current = true;
      for (const id of now) was.ids.add(id);
      was.ms = clipsMs;
    }
    if (!fitAsked.current || fitMs <= 0) return;
    const id = requestAnimationFrame(() => {
      fitAsked.current = false;
      fitAll();
      fittedAt.current = performance.now();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fitted when clips come or the length changes, not when fitAll is made anew
  }, [ids, clipsMs, fitMs, timelineId]);
  return { zoomTo, fitAll, kept: { whole: () => whole.current, ready: () => fittedFor.current === timelineId } };
}
