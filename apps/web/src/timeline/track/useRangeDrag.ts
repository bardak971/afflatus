import type { MouseEvent as ReactMouseEvent } from "react";
import type { Clip, Timeline } from "../../api";
import type { Clock } from "../clock";
import { placeOf, type Slot, type TimeRange } from "../model";
import { useMotionMarks } from "./useMotionMarks";

/**
 * The range on the track: In and Out, swept on the ruler with Shift, or dragged by their brackets (TrackRuler, TrackClip);
 * what they snap to while dragged, cuts, the playhead and quiet moments (useMotionMarks: `snapRange`); where its band is
 * drawn; and its right-click, on the band or just beside it.
 */
export function useRangeDrag({ slots, clips, timeline, pps, clock, snapQuiet, range, xOf, onRangeMenu }: {
  slots: Slot[];
  clips: Clip[];
  timeline: Timeline;
  pps: number;
  clock: Clock;
  snapQuiet?: boolean;
  range: TimeRange | null;
  xOf(clientX: number): number;
  onRangeMenu?(e: ReactMouseEvent): void;
}) {
  const playEnd = clips.reduce((sum, c) => sum + c.lengthMs, 0);
  const { measureOf, motion, snapRange } = useMotionMarks({ slots, clips, timeline, playEnd, pps, clock, snapQuiet });
  const xAt = (ms: number) => placeOf(slots, ms)?.x ?? null;
  const band = (() => {
    if (!range) return null;
    const a = xAt(range.inMs);
    const b = xAt(range.outMs);
    return a === null || b === null ? null : { a: Math.min(a, b), b: Math.max(a, b) };
  })();
  const rangeMenuAt = (e: ReactMouseEvent) => {
    if (e.defaultPrevented || !band || !onRangeMenu) return;
    const x = xOf(e.clientX);
    if (x >= band.a - 10 && x <= band.b + 10) onRangeMenu(e);
  };
  return { playEnd, measureOf, motion, snapRange, band, rangeMenuAt };
}
