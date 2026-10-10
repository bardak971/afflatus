import { useRef, type RefObject } from "react";
import type { Clip, Take } from "../api";
import type { Clock } from "./clock";
import { splitPoint, stamp, type Slot } from "./model";
import type { PlayerHandle } from "./Player";
import type { HeaderNote } from "./useHeaderNote";
import type { useTimelineMutations } from "./useTimelineMutations";

type Mutations = ReturnType<typeof useTimelineMutations>;

/**
 * What the timeline editor does at the playhead, from the keys, the bar and the clip's menu alike: go to the clip before or
 * after, split the clip under it, play the selected clip's take before or after. What happened (or why not) is said in the
 * header's note.
 */
export function useClipSteps({ clips, slots, clock, player, cursor, split, patch, select, setNote, setSaid, setPreview }: {
  clips: Clip[];
  slots: Slot[];
  clock: Clock;
  player: RefObject<PlayerHandle | null>;
  /** Where the playhead was put by hand on the track; null while it follows what plays. */
  cursor: number | null;
  split: Mutations["split"];
  patch: Mutations["patch"];
  select(clip: string | null): void;
  setNote(text: string | null, more?: string): void;
  setSaid(note: HeaderNote | null): void;
  setPreview(take: Take | null): void;
}) {
  const clipsNow = useRef(clips);
  clipsNow.current = clips;
  const jump = (by: -1 | 1) => {
    const time = clock.get();
    const playable = clips.filter((c) => c.lengthMs > 0);
    const here = playable.findIndex((c) => time >= c.atMs && time < c.atMs + c.lengthMs);
    // back: to the start of this clip, or of the one before when already there
    const target = by === 1 ? playable[here + 1] : time - (playable[here]?.atMs ?? 0) > 400 ? playable[here] : playable[Math.max(0, here - 1)];
    if (!target) return;
    player.current?.seek(target.atMs);
    select(target.id);
  };

  /** A clip split at this moment of its video, said in the header once made ("Split clip 3 at 0:12.4", Undo beside it). */
  const splitAt = (clip: Clip, atMs: number) => {
    const n = clipsNow.current.findIndex((x) => x.id === clip.id) + 1;
    const when = stamp(clock.get());
    split.mutate({ clip: clip.id, atMs }, { onSuccess: () => setSaid({ text: `Split clip ${n} at ${when}`, undo: true }) });
  };
  /**
   * S and Ctrl+B: the clip under the playhead split there; with `only` (the bar, for the selected clip) when it is that clip.
   * Only inside what a clip plays, never on a cut: else the note says why and nothing changes.
   */
  const splitHere = (only?: string | null) => {
    if (split.isPending) return;
    const here = player.current?.where();
    // the playhead put by hand on a clip with nothing rendered stands there, not on the clip the player shows
    const by = cursor;
    const slot = by !== null ? slots.find((x) => by >= x.startMs && by < x.startMs + x.lengthMs) : undefined;
    const c = clips.find((x) => x.id === (slot?.planned ? slot.clip.id : here?.clip.id));
    if (!c) return setNote("No clip under the playhead");
    const n = clips.indexOf(c) + 1;
    if (only && only !== c.id) return setNote(`The playhead is not on clip ${clips.findIndex((x) => x.id === only) + 1}`);
    const cut = splitPoint(c, here && here.clip.id === c.id ? here.assetMs : -1);
    if ("why" in cut) return setNote(`Clip ${n} not split: ${cut.why}`);
    splitAt(c, cut.at);
  };
  // the take last asked from the keys, until the timeline read again plays it: a second press goes on from there
  const askedTake = useRef<{ clip: string; take: string; at: number } | null>(null);
  /** The selected clip plays its take before or after, as a click on it in the clip panel; at either end it stays, and says so. */
  const stepTake = (clipId: string | null, by: -1 | 1) => {
    const c = clips.find((x) => x.id === clipId);
    if (!c) return setNote("No clip selected");
    const n = clips.indexOf(c) + 1;
    const a = askedTake.current;
    const playing = a && a.clip === c.id && performance.now() - a.at < 3000 && c.takes.some((x) => x.id === a.take) ? a.take : c.take?.id;
    const i = c.takes.findIndex((x) => x.id === playing);
    if (c.takes.length < 2 || i < 0) return setNote(c.takes.length ? `Clip ${n} has one take` : `Clip ${n} has no take yet`);
    const to = c.takes[i + by];
    if (!to) return setNote(`Clip ${n} plays its ${by < 0 ? "first" : "last"} take already`);
    askedTake.current = { clip: c.id, take: to.id, at: performance.now() };
    setPreview(null);
    patch.mutate({ clip: c.id, patch: { take: to.id } });
    setNote(`Clip ${n} plays take ${i + by + 1} of ${c.takes.length}`);
  };

  return { jump, splitAt, splitHere, stepTake };
}
