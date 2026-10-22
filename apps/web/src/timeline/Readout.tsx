import { useClock, type Clock } from "./clock";
import { placeOf, stamp, type Slot } from "./model";

/** The transport's figures: where the playhead stands, how long the timeline is, which clip is under it. The only part of the bar that redraws with every tick. */
export function Readout({ clock, slots, cursor, total, source }: { clock: Clock; slots: Slot[]; cursor: number | null; total: number; /** The stage plays the source: the clock is in the track's own time, and the tag says where in the source. */ source?: { atMs: number; lengthMs: number } | null }) {
  const time = useClock(clock);
  const head = placeOf(slots, time);
  if (source) {
    const at = cursor ?? time;
    return (
      <>
        <span className="ml-1 shrink-0 font-mono whitespace-nowrap"><b className="font-semibold">{stamp(at)}</b> <span className="text-ink-3">/ {stamp(total)}</span></span>
        <span className="hidden h-[22px] shrink-0 items-center gap-1 rounded-md bg-accent-wash px-2 text-meta font-bold whitespace-nowrap text-accent lg:inline-flex" data-tip="The stage plays the source: where in it the playhead stands">
          Source · <span className="font-mono">{stamp(Math.max(0, Math.min(source.lengthMs, at - source.atMs)))} / {stamp(source.lengthMs)}</span>
        </span>
      </>
    );
  }
  return (
    <>
      <span className="ml-1 shrink-0 font-mono whitespace-nowrap"><b className="font-semibold">{stamp(cursor ?? head?.layoutMs ?? 0)}</b> <span className="text-ink-3">/ {stamp(total)}</span></span>
      {/* the clip under the playhead, as a tag: which one, and where in it */}
      {head && cursor === null && head.slot.clip.lengthMs > 0 && (
        <span className="hidden h-[22px] shrink-0 items-center gap-1 rounded-md bg-accent-wash px-2 text-meta font-bold whitespace-nowrap text-accent lg:inline-flex" data-tip="Which clip is under the playhead, and where in it">
          Clip {head.slot.index + 1} · <span className="font-mono">{stamp(Math.max(0, time - head.slot.clip.atMs))} / {stamp(head.slot.clip.lengthMs)}</span>
        </span>
      )}
    </>
  );
}
