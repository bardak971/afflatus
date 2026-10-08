import { useClock, type Clock } from "./clock";
import { placeOf, stamp, type Slot } from "./model";

/** The transport's figures: where the playhead stands, how long the timeline is, which clip is under it. The only part of the bar that redraws with every tick. */
export function Readout({ clock, slots, cursor, total }: { clock: Clock; slots: Slot[]; cursor: number | null; total: number }) {
  const time = useClock(clock);
  const head = placeOf(slots, time);
  return (
    <>
      <span className="ml-1 font-mono">{stamp(cursor ?? head?.layoutMs ?? 0)} <span className="text-ink-3">/ {stamp(total)}</span></span>
      {head && cursor === null && head.slot.clip.lengthMs > 0 && (
        <span className="hidden text-xs text-ink-2 lg:inline" data-tip="Which clip is under the playhead, and where in it">
          clip {head.slot.index + 1} · <span className="font-mono">{stamp(Math.max(0, time - head.slot.clip.atMs))}</span> of <span className="font-mono">{stamp(head.slot.clip.lengthMs)}</span>
        </span>
      )}
    </>
  );
}
