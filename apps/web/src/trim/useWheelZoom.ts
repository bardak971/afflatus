import { useEffect, useRef } from "react";
import type { Range } from "./range";

/**
 * The wheel on Trim's strips zooms around the moment under the mouse, by how far it turned (a mouse notch halves or
 * doubles; a trackpad's many small steps add up); the page under it does not scroll. Hands back where each strip puts
 * its element ("whole", "zoom"): the listeners are put on them again when zooming in or out, not on every zoom move.
 */
export function useWheelZoom(duration: number, zoom: Range | null, zoomTo: (win: Range | null) => void) {
  const wheelTargets = useRef<Record<string, HTMLDivElement | null>>({});
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const els = Object.entries(wheelTargets.current).filter((x): x is [string, HTMLDivElement] => Boolean(x[1]));
    const handlers = els.map(([kind, el]) => {
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const current = zoomRef.current ?? { startMs: 0, endMs: duration };
        const win = kind === "zoom" && zoomRef.current ? zoomRef.current : { startMs: 0, endMs: duration };
        const r = el.getBoundingClientRect();
        const ms = win.startMs + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (win.endMs - win.startMs);
        const factor = Math.min(2, Math.max(0.5, Math.exp(e.deltaY * 0.004)));
        const span = current.endMs - current.startMs;
        const nextSpan = Math.min(duration, span * factor);
        const share = Math.max(0, Math.min(1, (ms - current.startMs) / span));
        zoomTo({ startMs: ms - nextSpan * share, endMs: ms + nextSpan * (1 - share) });
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    });
    return () => handlers.forEach((off) => off());
  }, [duration, zoomTo, zoom === null]); // eslint-disable-line react-hooks/exhaustive-deps -- put back when zooming in or out, not on every zoom move
  return wheelTargets;
}
