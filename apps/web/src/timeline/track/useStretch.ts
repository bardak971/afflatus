import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip } from "../../api";
import { roomOf, type ShownPatch, type Slot } from "../model";
import type { Stretch } from "./TrackClip";

/**
 * A clip's edges on the track: dragged to shorten it (or to give back what was cut), a still's to change its duration.
 * While an edge is dragged, `stretch` is the length it has for now (the track is laid out with it); let go, the clip is
 * trimmed by what is seen (`onTrim`).
 */
export function useStretch({ clips, pps, onTrim }: { clips: Clip[]; pps: number; onTrim(clip: Clip, patch: ShownPatch): void }) {
  /** An edge being dragged: the clip, which edge, and the length it has for now. */
  const [stretch, setStretch] = useState<Stretch | null>(null);
  const pull = useRef<{ x: number; base: number; least: number; most: number } | null>(null);

  const startPull = (e: ReactPointerEvent, s: Slot, side: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const c = s.clip;
    // what is seen can reach back to the first frame it does not share with the clip before, and on to the last one it does not share with the clip after
    const t = c.take;
    const most = c.kind === "still" ? 60_000 : Math.max(c.lengthMs, c.lengthMs + (side === "start" ? t!.startMs - t!.headMs : t!.headMs + roomOf(t!) - t!.endMs));
    pull.current = { x: e.clientX, base: c.lengthMs, least: Math.min(c.lengthMs, 400), most };
    e.currentTarget.setPointerCapture(e.pointerId);
    setStretch({ clip: c.id, side, lengthMs: c.lengthMs });
  };
  const movePull = (e: ReactPointerEvent) => {
    const p = pull.current;
    if (!p || !stretch) return;
    const moved = ((e.clientX - p.x) / pps) * 1000;
    const length = Math.round(Math.max(p.least, Math.min(p.most, p.base + (stretch.side === "end" ? moved : -moved))) / 100) * 100;
    if (length !== stretch.lengthMs) setStretch({ ...stretch, lengthMs: Math.max(p.least, Math.min(p.most, length)) });
  };
  const endPull = () => {
    const p = pull.current;
    pull.current = null;
    if (!p || !stretch) return setStretch(null);
    const c = clips.find((x) => x.id === stretch.clip);
    const cut = p.base - stretch.lengthMs;
    if (c && cut !== 0) {
      if (c.kind === "still") onTrim(c, { stillMs: stretch.lengthMs });
      // asked by what is seen: the server works out the trims, so that the cut lands on the frame that was seen there
      else if (stretch.side === "start") onTrim(c, { shownFromMs: Math.max(0, c.take!.startMs + cut) });
      else onTrim(c, { shownToMs: Math.max(0, c.take!.endMs - cut) });
    }
    setStretch(null);
  };
  return { stretch, startPull, movePull, endPull };
}
