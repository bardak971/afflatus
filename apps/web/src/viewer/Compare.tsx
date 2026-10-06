import { useEffect, useRef, useState, type RefObject } from "react";
import { fileUrl, thumbUrl, type Asset } from "../api";
import { Kbd } from "../Keys";
import { Button, cx } from "../ui";

/** Keeps the second video in step with the first: play, pause, seeks and the rate follow it; a drift past a frame or two is corrected. */
function useInStep(master: RefObject<HTMLVideoElement | null>, other: RefObject<HTMLVideoElement | null>, key: string) {
  useEffect(() => {
    const m = master.current;
    const o = other.current;
    if (!m || !o) return;
    const follow = () => {
      if (Math.abs(o.currentTime - m.currentTime) > 0.06) o.currentTime = m.currentTime;
    };
    const onPlay = () => {
      follow();
      void o.play().catch(() => {});
    };
    const onPause = () => {
      o.pause();
      follow();
    };
    const onRate = () => {
      o.playbackRate = m.playbackRate;
    };
    m.addEventListener("play", onPlay);
    m.addEventListener("pause", onPause);
    m.addEventListener("seeked", follow);
    m.addEventListener("timeupdate", follow);
    m.addEventListener("ratechange", onRate);
    return () => {
      m.removeEventListener("play", onPlay);
      m.removeEventListener("pause", onPause);
      m.removeEventListener("seeked", follow);
      m.removeEventListener("timeupdate", follow);
      m.removeEventListener("ratechange", onRate);
    };
  }, [master, other, key]);
}

/**
 * Two items side by side: the one pinned, and the one the arrow keys move through. Videos play in step
 * from the pinned one's controls; two pictures can also be laid over each other with a wipe.
 */
export function Compare({ pinned, other, onSwap, onClose }: { pinned: Asset; other: Asset; onSwap(): void; onClose(): void }) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  // pictures laid over each other: where the second one takes over, in percent of the width; null = side by side
  const [wipe, setWipe] = useState<number | null>(null);
  useInStep(left, right, `${pinned.id}:${other.id}`);
  const pictures = pinned.kind === "image" && other.kind === "image";
  const pane = (a: Asset, ref: RefObject<HTMLVideoElement | null>, label: string) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-1.5">
      <span className="max-w-full truncate text-xs text-ink-3">{label}{a.name ? ` · ${a.name}` : ""}</span>
      {a.kind === "video" ? (
        <video key={a.id} ref={ref} src={fileUrl(a.id)} poster={thumbUrl(a.id)} controls={ref === left} muted={ref === right} className="min-h-0 max-h-full max-w-full rounded-lg" />
      ) : a.kind === "image" ? (
        <img key={a.id} src={fileUrl(a.id)} alt="" className="min-h-0 max-h-full max-w-full rounded-lg object-contain" />
      ) : (
        <audio key={a.id} src={fileUrl(a.id)} controls />
      )}
    </div>
  );
  return (
    <div className="flex min-h-0 min-w-0 grow flex-col gap-2 p-4" onClick={(e) => e.stopPropagation()}>
      {wipe === null || !pictures ? (
        <div className="flex min-h-0 grow items-stretch justify-center gap-3">
          {pane(pinned, left, "Pinned")}
          {pane(other, right, "This one")}
        </div>
      ) : (
        // the two pictures in one box: the second drawn over the first and cut at the slider's line
        <div className="flex min-h-0 grow items-center justify-center">
          <div className="relative max-h-full max-w-full">
            <img src={fileUrl(pinned.id)} alt="" className="max-h-[calc(100vh-150px)] max-w-full rounded-lg object-contain" />
            <img src={fileUrl(other.id)} alt="" className="absolute inset-0 h-full w-full rounded-lg object-contain" style={{ clipPath: `inset(0 0 0 ${wipe}%)` }} />
            <div className="pointer-events-none absolute inset-y-0 w-px bg-white/80" style={{ left: `${wipe}%` }} />
          </div>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2">
        {pictures && <Button size="sm" tone={wipe !== null ? "primary" : "plain"} aria-pressed={wipe !== null} title="The two pictures over each other, the second cut at a line you move" onClick={() => setWipe((w) => (w === null ? 50 : null))}>Wipe</Button>}
        {pictures && wipe !== null && <input type="range" min={0} max={100} value={wipe} aria-label="Where the second picture takes over" onChange={(e) => setWipe(Number(e.target.value))} className="w-64 accent-[var(--color-accent)]" />}
        <Button size="sm" title="The pinned one becomes the one you move through, and the other way round" onClick={onSwap}>Swap</Button>
        <span className="text-xs text-ink-3">← → change the right one</span>
        <Button size="sm" onClick={onClose}>Done <Kbd>X</Kbd></Button>
      </div>
    </div>
  );
}
