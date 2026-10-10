import { useEffect, useRef, useState } from "react";
import { fileUrl, thumbUrl } from "./api";
import { useHoverPlay } from "./store";
import { Thumb } from "./Thumb";

/** The fewest milliseconds between two seeks while the pointer scrubs: a seek waits for the one before anyway. */
const SEEK_EVERY_MS = 60;

/**
 * A media element sent where the pointer is along its tile (`at`, 0 to 1), cheaply: one seek at a time,
 * no more often than SEEK_EVERY_MS; the place asked for while a seek runs is gone to when it ends.
 */
function useScrub(el: React.RefObject<HTMLMediaElement | null>, at: number | null | undefined, on: boolean) {
  const want = useRef<number | null>(null);
  const last = useRef(0);
  const timer = useRef<number | null>(null);
  const go = () => {
    const m = el.current;
    if (!m || want.current === null || !Number.isFinite(m.duration) || !m.duration) return;
    if (m.seeking) return; // the `seeked` that ends it comes back here
    const wait = SEEK_EVERY_MS - (performance.now() - last.current);
    if (wait > 0) {
      if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; go(); }, wait);
      return;
    }
    const t = Math.min(m.duration - 0.05, Math.max(0, want.current * m.duration));
    if (Math.abs(m.currentTime - t) > 0.04) {
      last.current = performance.now();
      m.currentTime = t;
    }
  };
  useEffect(() => {
    want.current = at ?? null;
    if (on) go();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- go reads the latest values through refs; it is new at every render
  }, [at, on]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  // for the element: a seek ended, or its length became known
  return go;
}

/**
 * A sound that plays while the mouse rests on its tile, from where the pointer is along it (`at`), and
 * follows the pointer as it moves; it stops when the mouse leaves. Draws nothing but the element: the tile
 * draws the card (its waveform). Off when sounds on hover are turned off in Settings → Appearance.
 */
export function HoverAudio({ asset, at, delay = 250, onPlaying, onTime }: {
  asset: string;
  /** The pointer's place along the tile, 0 to 1; null: the pointer is not on it. */
  at: number | null;
  delay?: number;
  onPlaying?(playing: boolean): void;
  /** Where it is as it plays, 0 to 1. */
  onTime?(at: number): void;
}) {
  const allowed = useHoverPlay((s) => s.sound);
  const [playing, setPlaying] = useState(false);
  const el = useRef<HTMLAudioElement>(null);
  const hovering = at !== null;
  useEffect(() => {
    if (!allowed || !hovering) return;
    const t = window.setTimeout(() => setPlaying(true), delay);
    return () => {
      window.clearTimeout(t);
      setPlaying(false);
    };
  }, [allowed, hovering, delay]);
  useEffect(() => onPlaying?.(playing), [playing]); // eslint-disable-line react-hooks/exhaustive-deps -- the parent's callback is told when playing changes, not when it is passed anew
  const seek = useScrub(el, at, playing);
  if (!playing) return null;
  return (
    <audio
      ref={el}
      src={fileUrl(asset)}
      preload="auto"
      onLoadedMetadata={(e) => {
        seek();
        e.currentTarget.play().catch(() => setPlaying(false));
      }}
      onSeeked={seek}
      onTimeUpdate={(e) => onTime?.(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
      onEnded={() => setPlaying(false)}
    />
  );
}

/**
 * A preview frame that plays as a video, with its sound, while the mouse rests on it. Clips that open on
 * the same picture look alike as frames; they tell apart as they play. The sound plays when the browser
 * allows it (after any click on the page); otherwise the video plays silent. Given `at`, the pointer's
 * place along the tile, it scrubs: the video goes where the pointer is and plays on from there. Fills its
 * box: put it in a box with `relative` and a size (an aspect ratio).
 */
export function HoverVideo({ asset, video, alt = "", delay = 250, at, shaped, onNoFrame, onPlaying }: {
  asset: string;
  /** Its box has the item's own shape (the library's justified grid): the smaller thumbnail may stand in (Thumb). */
  shaped?: boolean;
  /** It is a video: it plays on hover. An image only shows. */
  video: boolean;
  alt?: string;
  /** Milliseconds the mouse rests before the video starts: a sweep across tiles starts nothing. */
  delay?: number;
  /** The pointer's place along the tile, 0 to 1, for a tile that scrubs (its own pointer events then start it); null: off it. */
  at?: number | null;
  /** The preview frame could not be shown (a video the server could not read a frame from). */
  onNoFrame?(): void;
  /** It started or stopped playing; muted: without its sound. */
  onPlaying?(playing: boolean, muted: boolean): void;
}) {
  // Settings → Appearance: whether a video plays on hover, and with its sound
  const hover = useHoverPlay();
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  const el = useRef<HTMLVideoElement>(null);
  const scrubs = at !== undefined;
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPlaying(false);
  };
  useEffect(() => stop, []);
  // a tile that scrubs says where the pointer is: on it, it starts after the delay; off it, it stops
  const over = scrubs && at !== null;
  useEffect(() => {
    if (!scrubs || !video || !hover.video) return;
    if (!over) return stop();
    timer.current = window.setTimeout(() => setPlaying(true), delay);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrubs is part of over; stop and setPlaying are new at every render and read refs
  }, [over, video, hover.video, delay]);
  const report = useRef(onPlaying);
  report.current = onPlaying;
  useEffect(() => {
    const v = el.current;
    if (!playing || !v) {
      report.current?.(false, true);
      return;
    }
    // a play that starts after the pointer has left says nothing: it stopped already
    let gone = false;
    v.muted = !hover.sound;
    v.play().then(() => !gone && report.current?.(true, v.muted)).catch(() => {
      // no sound allowed yet: it plays silent rather than not at all
      v.muted = true;
      v.play().then(() => !gone && report.current?.(true, true)).catch(() => {});
    });
    return () => {
      gone = true;
    };
  }, [playing, hover.sound]);
  const seek = useScrub(el, at, playing);
  return (
    // on a raised box: the frame fades in over it as it arrives (Thumb), the tile never stands empty
    <span
      className="absolute inset-0 block bg-raised"
      onPointerEnter={(e) => {
        if (scrubs || !video || !hover.video || e.pointerType !== "mouse") return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPlaying(true), delay);
      }}
      onPointerLeave={scrubs ? undefined : stop}
    >
      <Thumb src={thumbUrl(asset)} large={!shaped} alt={alt} loading="lazy" decoding="async" draggable={false} onError={onNoFrame} className="h-full w-full object-cover" />
      {playing && <video ref={el} src={fileUrl(asset)} loop playsInline preload="auto" aria-label="Playing on hover" onLoadedMetadata={seek} onSeeked={seek} className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  );
}
