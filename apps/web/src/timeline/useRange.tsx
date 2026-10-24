import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useMutation } from "@tanstack/react-query";
import { FRAME_SLACK_MS } from "@afflatus/core";
import { Copy, Gauge, Play, RefreshCw, Repeat, Scissors, Split, X } from "lucide-react";
import { api, type Clip } from "../api";
import { groups, type MenuItem } from "../ContextMenu";
import type { Banner } from "../store";
import type { Clock } from "./clock";
import type { PlayerHandle } from "./Player";
import type { TimeRange } from "./model";
import { rangeRemoves } from "./removalWords";

/**
 * The range: In and Out on the clock of what plays, what is done with it, and the transport that knows
 * about it (Play plays the range, Loop goes back to In).
 */
export function useRange({ id, clips, durationMs, clock, player, playing, setPlaying, on }: {
  id: string;
  clips: Clip[];
  durationMs: number;
  clock: Clock;
  player: RefObject<PlayerHandle | null>;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  /** What the range's actions reach beyond the range: the editor's own state. */
  on: {
    /** The timeline and the queue, read again. */
    after(): void;
    /** A clip selected, its panel open. */
    select(clip: string): void;
    /** A line in the header, and what more there is to it (behind its "?"). */
    note(text: string, more?: string): void;
    say(b: Banner): void;
    /** The designer writing a clip put between two others. */
    writeBetween(v: { clip: string; force: boolean; arrive?: string }): void;
    /** What removing these clips does to a recording or the source, asked first (removalAsk): false, nothing is done. */
    askRemoval(ids: string[], range: true): Promise<boolean>;
  };
}) {
  // ---- the range: In and Out on the clock of what plays; what is done with it
  const [range, setRange] = useState<TimeRange | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [loopRange, setLoopRange] = useState(false);
  // In and Out snap to quiet moments of the clips; off with the magnet, remembered per browser
  const [snapQuiet, setSnapQuiet] = useState(() => {
    try {
      return localStorage.getItem("afflatus.timeline.snapQuiet") !== "off";
    } catch {
      return true;
    }
  });
  const toggleSnapQuiet = () => {
    setSnapQuiet((on) => {
      try {
        localStorage.setItem("afflatus.timeline.snapQuiet", on ? "off" : "on");
      } catch {
        // not remembered, nothing more
      }
      return !on;
    });
  };
  const loopRef = useRef(loopRange);
  loopRef.current = loopRange;
  /** Playing the range: it stops at Out (or goes back to In). */
  const playingRange = useRef(false);
  // a pause by any way (the picture clicked, a clip's end, a key) ends playing the range: a later play by the picture
  // stopped at Out, or went back to In, as if the range still played
  useEffect(() => {
    if (!playing) playingRange.current = false;
  }, [playing]);
  const emptyRange = Boolean(range && range.outMs - range.inMs < FRAME_SLACK_MS);
  // the range stays within what plays when the timeline changes under it
  useEffect(() => {
    setRange((r) => (r && r.outMs > durationMs ? (r.inMs >= durationMs ? null : { ...r, outMs: durationMs }) : r));
  }, [durationMs]);
  const totalRef = useRef(durationMs);
  totalRef.current = durationMs;
  const toggle = useCallback(() => {
    const r = rangeRef.current;
    const time = clock.get();
    if (playing) playingRange.current = false;
    else if (r && r.outMs - r.inMs >= FRAME_SLACK_MS) {
      // with a range, Play plays it: from the playhead when it stands inside, else from In; it stops at Out
      playingRange.current = true;
      if (time < r.inMs || time >= r.outMs - 15) player.current?.seek(r.inMs);
    } else if (totalRef.current && time >= totalRef.current - 30) player.current?.seek(0);
    setPlaying((p) => !p);
  }, [playing, clock, player, setPlaying]);
  /** Loop on or off; turning it on goes to In at once and plays the range round (playing or not, wherever the playhead was). */
  const toggleLoop = useCallback(() => {
    const r = rangeRef.current;
    const on = !loopRef.current;
    loopRef.current = on;
    setLoopRange(on);
    if (on && r && r.outMs - r.inMs >= FRAME_SLACK_MS) {
      playingRange.current = true;
      player.current?.seek(r.inMs);
      if (!playing) setPlaying(true);
    }
  }, [playing, player, setPlaying]);
  const toggleLoopNow = useRef(toggleLoop);
  toggleLoopNow.current = toggleLoop;
  /** Play from In; at Out it stops, or goes back to In when Loop is on. */
  const playRange = () => {
    if (!range || emptyRange) return;
    playingRange.current = true;
    player.current?.seek(range.inMs);
    setPlaying(true);
  };
  const rangeAct = useMutation({
    mutationFn: (ask: "split" | "remove" | "regenerate" | "loop" | "copy" | { slow: 2 | 4; inMs?: number; outMs?: number }) =>
      typeof ask === "string"
        ? api.timelineRange(id, { inMs: range!.inMs, outMs: range!.outMs, action: ask })
        : api.timelineRange(id, { inMs: ask.inMs ?? range!.inMs, outMs: ask.outMs ?? range!.outMs, action: "slow", factor: ask.slow }),
    onSuccess: (r, ask) => {
      on.after();
      if (typeof ask !== "string") {
        const parts = "clips" in r ? r.clips : [];
        if (parts[0]) on.select(parts[0]);
        const engine = "engine" in r ? r.engine : "ffmpeg";
        on.say({ id: `slow:${Date.now()}`, tone: "good", title: `Slow motion ×${ask.slow} in the queue`, text: `${parts.length > 1 ? `${parts.length} parts are clips of their own now; each slowed video` : "The part is a clip of its own now; the slowed video"} arrives as a take and plays, with its sound slowed. ${engine === "rife" ? "RIFE on the GPU." : "ffmpeg on the processor: slow, minutes for a few seconds."}`, href: "/queue", go: "Open queue" });
        return;
      }
      const action = ask;
      if (action === "regenerate" && "clip" in r && "context" in r) {
        on.select(r.clip);
        setRange(null);
        const { start, end } = r.context;
        const how =
          start === "clip" && end === "clip" ? "it extends the clip before and ends where the clip after begins, so the motion carries across"
          : start === "clip" ? (end === "frame" ? "it extends the clip before and ends on the frame at Out" : "it extends the clip before; nothing rendered plays after Out")
          : end === "clip" ? "it opens on the frame at In and ends where the clip after begins"
          : start === "none" ? "it ends on the frame at Out; nothing plays before In"
          : end === "none" ? "it opens on the frame at In; nothing rendered plays after Out, so only that frame is pinned"
          : "it is pinned to the frames at In and Out: the frames will match, the motion may not";
        // a range shorter than the model can make took in what followed it, so that nothing after moves
        const wider = "widenedMs" in r && r.widenedMs ? ` The range was shorter than the model can make, so it now takes in ${(r.widenedMs / 1000).toFixed(1)} s more of the clips around it: the rest of the timeline stays where it was.` : "";
        const longer = "longerMs" in r && r.longerMs ? ` The clips around it are too short to take more from: the new clip comes out ${(r.longerMs / 1000).toFixed(1)} s longer than the range, and what follows moves by as much.` : "";
        on.note("New clip selected: change what happens in it, then render it.", `${how[0]!.toUpperCase()}${how.slice(1)}.${wider}${longer} Undo takes the range back.`);
        // with a clip after to arrive at, the designer writes the stretch; without a language model nothing happens
        if (end !== "none") on.writeBetween({ clip: r.clip, force: false });
      } else if (action === "loop" && "clip" in r && "context" in r) {
        on.select(r.clip);
        on.note("Loop clip selected, after Out: keep it short, then render it.", `${r.context.start === "clip" ? "It extends the clip at Out" : "It opens on the frame at Out"} and ends on the frame at In, so the range plays round. Undo takes it out.`);
        // the designer writes the return towards the clip under In
        on.writeBetween({ clip: r.clip, force: false, arrive: r.arrive });
      } else if (action === "remove") setRange(null);
      else if (action === "copy") on.say({ id: `copy:${Date.now()}`, tone: "good", title: "Copying the range to your library", text: "One video of that part of the timeline, without the music. It runs in the queue.", href: "/queue", go: "Open queue" });
    },
  });
  // a clip of a recording or the source it takes off whole cuts its part out of it, as a clip removed does: said first
  const removeRange = async () => {
    if (!range || !(await on.askRemoval(rangeRemoves(clips, range.inMs, range.outMs), true))) return;
    rangeAct.mutate("remove");
  };
  /** What can be done with the range: the bar under the video and the right-click on the band show the same list. */
  const rangeItems = (): MenuItem[] => {
    if (!range) return [];
    const busy = rangeAct.isPending;
    // slow motion needs a video under the range (each clip it covers is slowed on its own; stills are held longer)
    const withinOne = clips.some((c) => c.kind === "video" && c.take && c.atMs < range.outMs && c.atMs + c.lengthMs > range.inMs);
    // why a row is off, said on it: a range of no length (In and Out at one moment) is widened by dragging either end
    const empty = emptyRange ? "In and Out are the same moment" : undefined;
    const why = empty ?? (busy ? "busy…" : undefined);
    const slowWhy = why ?? (withinOne ? undefined : "nothing in the range plays a video");
    return groups(
      [
        { label: "Play range", key: "Space", icon: <Play size={14} />, disabled: emptyRange, note: empty, run: playRange },
        { label: "Loop the range", key: "L", icon: <Repeat size={14} />, checked: loopRange, disabled: emptyRange, note: empty ?? "back to In at Out", run: () => toggleLoop() },
      ],
      [
        { label: emptyRange ? "Insert a clip here" : "Regenerate range", icon: <RefreshCw size={14} />, disabled: busy, note: busy ? "busy…" : emptyRange ? "a clip between the two, pinned to their frames" : "a new clip pinned to the frames at In and Out; it replaces what is between", run: () => rangeAct.mutate("regenerate") },
        { label: "Loop back to In", icon: <Repeat size={14} />, disabled: emptyRange || busy, note: why ?? "a short new clip after Out that returns to the frame at In: the range plays round", run: () => rangeAct.mutate("loop") },
        { label: "Copy to library", icon: <Copy size={14} />, disabled: emptyRange || busy, note: why ?? "one video of this part, through the queue", run: () => rangeAct.mutate("copy") },
      ],
      [
        { label: "Split at In and Out", icon: <Split size={14} />, disabled: emptyRange || busy, note: why ?? "the clips under them become two", run: () => rangeAct.mutate("split") },
        { label: "Slow motion ×2", icon: <Gauge size={14} />, disabled: Boolean(slowWhy), note: slowWhy ?? "each part becomes a clip of its own and gets the slowed video as a take, sound slowed too; stills are held longer", run: () => rangeAct.mutate({ slow: 2 }) },
        { label: "Slow motion ×4", icon: <Gauge size={14} />, disabled: Boolean(slowWhy), note: slowWhy ?? "a quarter speed", run: () => rangeAct.mutate({ slow: 4 }) },
      ],
      [{ label: "Clear the range", key: "Esc", icon: <X size={14} />, run: () => setRange(null) }],
      [{ label: "Remove range", icon: <Scissors size={14} />, danger: true, disabled: emptyRange || busy, note: why ?? "the clips after close the gap; Undo brings it back", run: () => void removeRange() }],
    );
  };
  return { range, setRange, rangeRef, loopRange, loopRef, snapQuiet, toggleSnapQuiet, playingRange, emptyRange, totalRef, toggle, toggleLoop, toggleLoopNow, playRange, rangeAct, rangeItems };
}
