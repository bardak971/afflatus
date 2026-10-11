import { useEffect, useRef, type RefObject } from "react";
import type { Range } from "./range";

/**
 * Trim's playhead follows the video, frame by frame where the browser can say so (`setAt`), and goes back to In when a
 * loop reaches Out. One loop for as long as Trim is open, reading the loop and the range as they stand: a loop started
 * again at each change of them (or at each play, while the paused one's callback was still waiting) ran beside the old
 * ones, which jumped back to an old In and went on after Trim closed. It stops on pause, the frame-rate fallback too.
 */
export function useFrameLoop(player: RefObject<HTMLVideoElement | null>, looping: boolean, range: Range, on: { setAt(ms: number): void; setPlaying(playing: boolean): void }) {
  const live = useRef({ looping, range });
  live.current = { looping, range };
  // the setters are React's own: the same functions for as long as Trim is open
  const { setAt, setPlaying } = on;
  useEffect(() => {
    const v = player.current;
    if (!v) return;
    const frames = "requestVideoFrameCallback" in v ? (v as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number; cancelVideoFrameCallback(h: number): void }) : null;
    let handle: number | null = null;
    const stop = () => {
      if (handle === null) return;
      if (frames) frames.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      handle = null;
    };
    const tick = () => {
      handle = null;
      setAt(v.currentTime * 1000);
      // the loop: back to in when out is reached
      const { looping, range } = live.current;
      if (looping && v.currentTime * 1000 >= range.endMs - 1) v.currentTime = range.startMs / 1000;
      if (!v.paused) handle = frames ? frames.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    const onPlay = () => { setPlaying(true); stop(); tick(); };
    const onPause = () => { setPlaying(false); stop(); setAt(v.currentTime * 1000); };
    const onSeeked = () => setAt(v.currentTime * 1000);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    if (!v.paused) onPlay();
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      stop();
    };
  }, [player]); // eslint-disable-line react-hooks/exhaustive-deps -- setAt and setPlaying are state setters, the same for Trim's whole life
}
