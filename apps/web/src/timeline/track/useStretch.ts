import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip } from "../../api";
import { motionAllowed } from "../../useFlip";
import { roomOf, type ShownPatch, type Slot } from "../model";
import { edgeGive, resisted } from "./spring";
import type { Stretch } from "./TrackClip";
import { useSpringBack } from "./useSpringBack";

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

/**
 * The length drawn while an edge is dragged `movedMs`: the length it gives (`pulledLength`), and past its least or its most
 * what the pointer asks beyond them, with resistance (spring.ts `resisted`, at most `givePx` more); in ms.
 */
export function drawnLength(room: { base: number; least: number; most: number }, side: "start" | "end", movedMs: number, pps: number, givePx: number, give = true): number {
  const length = pulledLength(room, side, movedMs);
  const asked = room.base + (side === "end" ? movedMs : -movedMs);
  const px = (ms: number) => (ms / 1000) * pps;
  const over = resisted(px(asked), px(room.least), px(room.most), givePx, give) - px(Math.max(room.least, Math.min(room.most, asked)));
  return length + (over / pps) * 1000;
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
 * While an edge is dragged, `stretch` is the length drawn for now (the track is laid out with it); let go, the clip is
 * trimmed by what is seen (`onTrim`). Past its least or its most, the edge follows the pointer with resistance and, let go
 * of, springs back to the limit (useSpringBack); the trim asked is the limit's, as it always was. Under reduced motion it
 * stops at the limit.
 */
export function useStretch({ clips, pps, onTrim }: { clips: Clip[]; pps: number; onTrim(clip: Clip, patch: ShownPatch): void }) {
  /** An edge being dragged: the clip, which edge, the length it gives, and the length drawn (past a limit, more). */
  const [stretch, setStretch] = useState<(Stretch & { drawnMs: number }) | null>(null);
  const pull = useRef<{ x: number; base: number; least: number; most: number; give: number } | null>(null);
  const back = useSpringBack();

  const startPull = (e: ReactPointerEvent, s: Slot, side: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const c = s.clip;
    back.stop();
    pull.current = { x: e.clientX, base: c.lengthMs, ...pullRoom(c, side), give: edgeGive(s.width) };
    e.currentTarget.setPointerCapture(e.pointerId);
    setStretch({ clip: c.id, side, lengthMs: c.lengthMs, drawnMs: c.lengthMs });
  };
  const movePull = (e: ReactPointerEvent) => {
    const p = pull.current;
    if (!p || !stretch) return;
    const moved = ((e.clientX - p.x) / pps) * 1000;
    const length = pulledLength(p, stretch.side, moved);
    const drawnMs = drawnLength(p, stretch.side, moved, pps, p.give, motionAllowed());
    back.seen((drawnMs / 1000) * pps);
    if (length !== stretch.lengthMs || drawnMs !== stretch.drawnMs) setStretch({ ...stretch, lengthMs: length, drawnMs });
  };
  const endPull = () => {
    const p = pull.current;
    pull.current = null;
    if (!p || !stretch) return setStretch(null);
    const c = clips.find((x) => x.id === stretch.clip);
    const trim = c && trimOf(c, stretch.side, p.base, stretch.lengthMs);
    if (c && trim) onTrim(c, trim);
    // let go past a limit: drawn on, springing back to it, the trim sent meanwhile; else gone at once, as before
    if (stretch.drawnMs === stretch.lengthMs) return setStretch(null);
    back.jump((stretch.drawnMs / 1000) * pps, (stretch.lengthMs / 1000) * pps, "edge");
    setStretch({ ...stretch, drawnMs: stretch.lengthMs, settling: true });
  };
  // sprung back (or no spring under reduced motion): the edge's drawing let go of
  const resting = back.left.tag === null;
  useEffect(() => {
    if (stretch?.settling && resting) setStretch(null);
  }, [stretch, resting]);
  const shown = useMemo<Stretch | null>(() => stretch && { clip: stretch.clip, side: stretch.side, lengthMs: stretch.drawnMs + (back.left.px / pps) * 1000, ...(stretch.settling ? { settling: true } : {}) }, [stretch, back.left.px, pps]);
  return { stretch: shown, startPull, movePull, endPull };
}
