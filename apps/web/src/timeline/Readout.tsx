import { useClock, type Clock } from "./clock";
import { placeOf, stamp, type Slot } from "./model";

/** The transport's figures: where the playhead stands, how long the timeline is, which clip is under it. The only part of the bar that redraws with every tick. */
export function Readout({ clock, slots, cursor, total }: { clock: Clock; slots: Slot[]; cursor: number | null; total: number }) {
  const time = useClock(clock);
  const head = placeOf(slots, time);
  return (
    <>
      <span className="ml-1 font-mono"><b className="font-semibold">{stamp(cursor ?? head?.layoutMs ?? 0)}</b> <span className="text-ink-3">/ {stamp(total)}</span></span>
      {/* the clip under the playhead, as a tag: which one, and where in it */}
      {head && cursor === null && head.slot.clip.lengthMs > 0 && (
        <span className="hidden h-[22px] shrink-0 items-center gap-1 rounded-md bg-accent-wash px-2 text-[11.5px] font-bold whitespace-nowrap text-accent lg:inline-flex" data-tip="Which clip is under the playhead, and where in it">
          Clip {head.slot.index + 1} · <span className="font-mono">{stamp(Math.max(0, time - head.slot.clip.atMs))} / {stamp(head.slot.clip.lengthMs)}</span>
        </span>
      )}
    </>
  );
}
