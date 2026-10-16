import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip } from "../../api";
import { roomOf, type ShownPatch, type Slot } from "../model";
import type { Stretch } from "./TrackClip";

/**
 * How far a clip's edge can be dragged: down to 0.4 s (or what it has, when shorter), and up to what its take holds
 * past what is seen on that side, the frames it shares with its neighbour left out; a still up to a minute.
 */
export function pullRoom(c: Clip, side: "start" | "end"): { least: number; most: number } {
  // what is seen can reach back to the first frame it does not share with the clip before, and on to the last one it does not share with the clip after
  const t = c.take;
  const most = c.kind === "still" ? 60_000 : Math.max(c.lengthMs, c.lengthMs + (side === "start" ? t!.startMs - t!.headMs : t!.headMs + roomOf(t!) - t!.endMs));
  return { least: Math.min(c.lengthMs, 400), most };
}

/** The length an edge dragged by `movedMs` gives (right is later), on tenths of a second, within the room it has. */
export function pulledLength(room: { base: number; least: number; most: number }, side: "start" | "end", movedMs: number): number {
  const length = Math.round(Math.max(room.least, Math.min(room.most, room.base + (side === "end" ? movedMs : -movedMs))) / 100) * 100;
  return Math.max(room.least, Math.min(room.most, length));
}

/** The trim a drag let go at `lengthMs` asks of the clip (by what is seen), or null when it is as it was. */
export function trimOf(c: Clip, side: "start" | "end", base: number, lengthMs: number): ShownPatch | null {
  const cut = base - lengthMs;
  if (cut === 0) return null;
  if (c.kind === "still") return { stillMs: lengthMs };
  // asked by what is seen: the server works out the trims, so that the cut lands on the frame that was seen there
  return side === "start" ? { shownFromMs: Math.max(0, c.take!.startMs + cut) } : { shownToMs: Math.max(0, c.take!.endMs - cut) };
}

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
    pull.current = { x: e.clientX, base: c.lengthMs, ...pullRoom(c, side) };
    e.currentTarget.setPointerCapture(e.pointerId);
    setStretch({ clip: c.id, side, lengthMs: c.lengthMs });
  };
  const movePull = (e: ReactPointerEvent) => {
    const p = pull.current;
    if (!p || !stretch) return;
    const length = pulledLength(p, stretch.side, ((e.clientX - p.x) / pps) * 1000);
    if (length !== stretch.lengthMs) setStretch({ ...stretch, lengthMs: length });
  };
  const endPull = () => {
    const p = pull.current;
    pull.current = null;
    if (!p || !stretch) return setStretch(null);
    const c = clips.find((x) => x.id === stretch.clip);
    const trim = c && trimOf(c, stretch.side, p.base, stretch.lengthMs);
    if (c && trim) onTrim(c, trim);
    setStretch(null);
  };
  return { stretch, startPull, movePull, endPull };
}
