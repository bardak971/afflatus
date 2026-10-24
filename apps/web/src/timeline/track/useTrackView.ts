import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { PAD } from "../model";

/** The stretch of the timeline the track shows, in the track's layout time (ms): what its scroll and zoom bring into view. */
export interface TrackView {
  fromMs: number;
  toMs: number;
}

/**
 * Where the track's view is kept: not the editor's state, so that a scroll redraws only what follows it (the recording's
 * stage), not the whole editor, as the clock is kept for the playhead.
 */
export interface ViewStore {
  get(): TrackView | null;
  set(view: TrackView): void;
  subscribe(listener: () => void): () => void;
}

export function newViewStore(): ViewStore {
  let view: TrackView | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => view,
    set(next) {
      view = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The track's view as it is now, drawn again when it changes. */
export const useViewOf = (store: ViewStore | undefined): TrackView | null =>
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.get ?? noView);
const noSubscribe = () => () => {};
const noView = () => null;

/**
 * Says the stretch the track shows whenever its scroll, its zoom or its width changes (at most once a frame), for the
 * recording's stage to show the same stretch of the recording.
 */
export function useTrackView(scroller: RefObject<HTMLDivElement | null>, pps: number, onView?: (view: TrackView) => void) {
  const said = useRef<TrackView | null>(null);
  const sayNow = useRef(onView);
  sayNow.current = onView;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !sayNow.current) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      // not laid out yet (no width): it shows nothing to follow, and the stage keeps showing the whole recording
      if (el.clientWidth <= 0) return;
      const view = { fromMs: Math.round(((el.scrollLeft - PAD) / pps) * 1000), toMs: Math.round(((el.scrollLeft + el.clientWidth - PAD) / pps) * 1000) };
      const before = said.current;
      if (before && before.fromMs === view.fromMs && before.toMs === view.toMs) return;
      said.current = view;
      sayNow.current?.(view);
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    said.current = null;
    read();
    el.addEventListener("scroll", soon, { passive: true });
    const seen = new ResizeObserver(soon);
    seen.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", soon);
      seen.disconnect();
    };
    // read again as a recording opens on the stage (`onView` given): the stretch shown may not have moved since
  }, [scroller, pps, Boolean(onView)]); // eslint-disable-line react-hooks/exhaustive-deps -- onView is read through a ref
}
