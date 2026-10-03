import { useEffect, useRef, useState } from "react";
import { fileUrl, thumbUrl } from "./api";

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
    v.muted = false;
    v.play().catch(() => {
      // no sound allowed yet: it plays silent rather than not at all
      v.muted = true;
      v.play().catch(() => {});
    });
  }, [playing]);
  return (
    <span
      className="absolute inset-0 block"
      onPointerEnter={(e) => {
        if (!video || e.pointerType !== "mouse") return;
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
