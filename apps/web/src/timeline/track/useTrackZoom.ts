import { useEffect, useRef, type RefObject } from "react";
import type { Clock } from "../clock";
import { NEW_CLIP, PAD, placeOf, ZOOM, type Slot } from "../model";

/** What the editor's keys reach on the track: a zoom step around the playhead, and Fit all. */
export interface TrackKeys {
  zoom(by: -1 | 1): void;
  fit(): void;
}

/**
 * The track's zoom: Ctrl + wheel around the pointer (a plain wheel scrolls it sideways), a step around the playhead (the
 * editor's - and =, filled into `keys`), Fit all (Shift+Z). The whole timeline is fitted on arriving and when a clip is
 * added; a track showing the whole of it keeps doing so at any width, until it is zoomed by hand.
 */
export function useTrackZoom({ scroller, pps, onZoom, slots, totalMs, clock, cursorMs, timelineId, clipCount, keys }: {
  scroller: RefObject<HTMLDivElement | null>;
  pps: number;
  onZoom(pps: number): void;
  slots: Slot[];
  totalMs: number;
  clock: Clock;
  cursorMs: number | null;
  timelineId: string;
  clipCount: number;
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

  const fitAll = () => {
    const room = (scroller.current?.clientWidth ?? 800) - NEW_CLIP - PAD * 3 - 40;
    if (totalMs <= 0) return;
    whole.current = true;
    onZoom(Math.max(ZOOM.least, Math.min(ZOOM.most, room / (totalMs / 1000))));
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
  if (keys) keys.current = { zoom: zoomAtHead, fit: fitAll };
  // arriving on a timeline, the whole of it is in view; zooming after that is the person's
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (totalMs <= 0 || fittedFor.current === timelineId) return;
    // marked done only once it has run: a frame cancelled (the length settling a render later) asks again
    const id = requestAnimationFrame(() => {
      fittedFor.current = timelineId;
      fitAll();
    });
    return () => cancelAnimationFrame(id);
    // once per timeline, when its length is known
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per timeline, when its length is known
  }, [timelineId, totalMs]);
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
  }, [totalMs]);
  const counted = useRef(clipCount);
  const fitAsked = useRef(false);
  useEffect(() => {
    if (clipCount > counted.current) fitAsked.current = true;
    counted.current = clipCount;
    if (!fitAsked.current || totalMs <= 0) return;
    const id = requestAnimationFrame(() => {
      fitAsked.current = false;
      fitAll();
      fittedAt.current = performance.now();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fitted when clips come or go or the length changes, not when fitAll is made anew
  }, [clipCount, totalMs]);
  return { zoomTo, fitAll };
}
