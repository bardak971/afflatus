import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Clip } from "../api";
import type { Clock } from "./clock";
import type { PlayerHandle } from "./Player";
import type { TimeRange } from "./Track";

/**
 * The timeline editor's playhead and how loud it plays: the moment the player reports (a range played alone stops or
 * loops at its Out), where the playhead was put by hand on the track, one frame of the clip under it, and this browser's
 * volume and mute.
 */
export function usePlayhead({ clock, clips, player, rangeRef, loopRef, playingRange, setPlaying }: {
  clock: Clock;
  clips: Clip[];
  player: RefObject<PlayerHandle | null>;
  rangeRef: RefObject<TimeRange | null>;
  /** The range loops, and it is the range that plays (not the whole video). */
  loopRef: RefObject<boolean>;
  playingRange: RefObject<boolean>;
  setPlaying(playing: boolean): void;
}) {
  /** How loud the player plays here (0 to 1) and whether it is muted: this browser's, over the timeline's own mix. */
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(localStorage.getItem("afflatus.player.volume"));
      return Number.isFinite(v) && localStorage.getItem("afflatus.player.volume") !== null ? Math.max(0, Math.min(1, v)) : 1;
    } catch {
      return 1;
    }
  });
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem("afflatus.player.volume", String(volume));
    } catch {
      /* a private window: not kept */
    }
  }, [volume]);
  /** The volume moved by hand: it is heard again. */
  const onVolume = (v: number) => {
    setVolume(v);
    setMuted(false);
  };
  /** Mute, or unmute; at no volume, unmuting brings it back whole. */
  const onMute = () => {
    if (volume === 0) {
      setVolume(1);
      setMuted(false);
    } else setMuted((x) => !x);
  };
  /** Where the playhead was put by hand on the track (it can stand on a clip that is not rendered yet); null while it follows what plays. */
  const [cursor, setCursor] = useState<number | null>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const onTime = useCallback((ms: number) => {
    clock.set(ms);
    // (set only when it stands somewhere: fifteen times a second, a no-op set still costs a render)
    if (cursorRef.current !== null) setCursor(null);
    const r = rangeRef.current;
    if (playingRange.current && r && ms >= r.outMs - 15) {
      if (loopRef.current && r.outMs - r.inMs >= 40) player.current?.seek(r.inMs);
      else {
        playingRange.current = false;
        setPlaying(false);
      }
    }
  }, [clock, rangeRef, playingRange, loopRef, player, setPlaying]);
  /** One frame of the clip under the playhead, in ms (24 a second when it is not known). */
  const frameMs = () => {
    const time = clock.get();
    const c = clips.find((x) => x.lengthMs > 0 && time >= x.atMs && time < x.atMs + x.lengthMs);
    return 1000 / Math.max(1, c?.take?.asset.fps ?? 24);
  };
  return { volume, muted, onVolume, onMute, cursor, setCursor, onTime, frameMs };
}
