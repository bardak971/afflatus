import { useEffect, useRef, useState } from "react";
import { Music } from "lucide-react";
import { fileUrl, thumbUrl } from "./api";
import { useHoverPlay } from "./store";

/**
 * A sound's tile: it plays while the mouse rests on it, with a bar that fills as it goes, and stops and
 * rewinds when the mouse leaves. Fills its box, like HoverVideo.
 */
export function HoverAudio({ asset, delay = 250 }: { asset: string; delay?: number }) {
  // sounds on hover turned off in Settings → Appearance: the card only shows
  const allowed = useHoverPlay((s) => s.sound);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const timer = useRef<number | null>(null);
  const el = useRef<HTMLAudioElement>(null);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPlaying(false);
    setAt(0);
  };
  useEffect(() => stop, []);
  useEffect(() => {
    const a = el.current;
    if (!playing || !a) return;
    a.play().catch(() => setPlaying(false));
  }, [playing]);
  return (
    <span
      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-ink-2"
      onPointerEnter={(e) => {
        if (!allowed || e.pointerType !== "mouse") return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPlaying(true), delay);
      }}
      onPointerLeave={stop}
    >
      <Music size={20} />
      {playing ? "Playing" : "Audio"}
      {playing && <audio ref={el} src={fileUrl(asset)} preload="auto" onTimeUpdate={(e) => setAt(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)} onEnded={stop} />}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-1 bg-line">
        <span className="block h-full bg-accent transition-[width] duration-150" style={{ width: `${Math.round(at * 100)}%` }} />
      </span>
    </span>
  );
}

/**
 * A preview frame that plays as a video, with its sound, while the mouse rests on it. Clips that open on
 * the same picture look alike as frames; they tell apart as they play. The sound plays when the browser
 * allows it (after any click on the page); otherwise the video plays silent. Fills its box: put it in a
 * box with `relative` and a size (an aspect ratio).
 */
export function HoverVideo({ asset, video, alt = "", delay = 250, onNoFrame }: {
  asset: string;
  /** It is a video: it plays on hover. An image only shows. */
  video: boolean;
  alt?: string;
  /** Milliseconds the mouse rests before the video starts: a sweep across tiles starts nothing. */
  delay?: number;
  /** The preview frame could not be shown (a video the server could not read a frame from). */
  onNoFrame?(): void;
}) {
  // Settings → Appearance: whether a video plays on hover, and with its sound
  const hover = useHoverPlay();
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  const el = useRef<HTMLVideoElement>(null);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setPlaying(false);
  };
  useEffect(() => stop, []);
  useEffect(() => {
    const v = el.current;
    if (!playing || !v) return;
    v.muted = !hover.sound;
    v.play().catch(() => {
      // no sound allowed yet: it plays silent rather than not at all
      v.muted = true;
      v.play().catch(() => {});
    });
  }, [playing, hover.sound]);
  return (
    <span
      className="absolute inset-0 block"
      onPointerEnter={(e) => {
        if (!video || !hover.video || e.pointerType !== "mouse") return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPlaying(true), delay);
      }}
      onPointerLeave={stop}
    >
      <img src={thumbUrl(asset)} alt={alt} loading="lazy" draggable={false} onError={onNoFrame} className="h-full w-full object-cover" />
      {playing && <video ref={el} src={fileUrl(asset)} loop playsInline preload="auto" aria-label="Playing on hover" className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  );
}
