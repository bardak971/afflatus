import { useClock, type Clock } from "../clock";
import { PAD, placeOf, type Slot } from "../model";
import { HEIGHT } from "./rows";

/** The playhead: where what plays stands, or where it was put by hand. The one part of the track that redraws on every tick. */
export function Playhead({ clock, slots, cursorMs, totalMs, pps, free }: {
  clock: Clock;
  slots: Slot[];
  /** Where the playhead was put by hand, in the track's own time: it can stand on a clip that is not rendered yet. null = it follows what plays. */
  cursorMs: number | null;
  totalMs: number;
  pps: number;
  /** The clock is in the track's own time (the stage plays the source lane, not the clips). */
  free?: boolean;
}) {
  const time = useClock(clock);
  const playing = free ? { x: PAD + (Math.min(time, totalMs) / 1000) * pps } : placeOf(slots, time);
  const head = cursorMs !== null ? { x: PAD + (Math.min(cursorMs, totalMs) / 1000) * pps } : playing;
  if (!head) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute top-0 z-20" style={{ left: head.x - 1, height: HEIGHT - 4 }}>
      <div className="h-full w-0.5 bg-ink-strong" />
      <div className="absolute -top-px -left-[5px] h-2.5 w-3 rounded-b bg-ink-strong" />
    </div>
  );
}
