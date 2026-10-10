import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../queryKeys";

/**
 * A sound's waveform on its library tile: bars of how loud it is along its length, read off the loudness the
 * server measures once and keeps for the timelines (GET /assets/:id/motion, ten values a second), so the
 * library asks for nothing new. Asked for only once the tile comes near the screen, two at a time: the
 * first look at a folder of sounds does not start every measure at once.
 */

/** How many bars a waveform has. */
export const BARS = 64;

/** Bars of 0 to 1 from loudness in dB (-60 the floor): the loudest of each stretch, the loudest bar at the top. */
export function barsOf(sound: number[] | null | undefined, n = BARS): number[] | null {
  if (!sound || sound.length < 2) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * sound.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * sound.length) / n));
    let peak = -Infinity;
    for (let j = a; j < b && j < sound.length; j++) peak = Math.max(peak, sound[j]!);
    out.push(Math.max(0, Math.min(1, (peak + 60) / 60)));
  }
  const top = Math.max(...out);
  return top > 0 ? out.map((v) => Math.max(0.06, v / top)) : out.map(() => 0.06);
}

// ---- near the screen: one observer for every tile that asks
const watched = new Map<Element, (near: boolean) => void>();
let observer: IntersectionObserver | null = null;
function watch(el: Element, said: (near: boolean) => void) {
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) watched.get(e.target)?.(e.isIntersecting);
  }, { rootMargin: "400px" });
  watched.set(el, said);
  observer.observe(el);
  return () => {
    watched.delete(el);
    observer?.unobserve(el);
  };
}
/** The element has come within a screen's reach of the viewport (once: it is not forgotten when scrolled past). */
function useNear(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    return watch(el, (n) => n && setNear(true));
  }, [ref, near]);
  return near;
}

// ---- two measures asked for at a time
let running = 0;
const waiting: Array<() => void> = [];
async function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((go) => waiting.push(go));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** The waveform: neutral bars, the part before `at` (0 to 1) in the accent colour with a thin head there. */
export function SoundWave({ asset, at, className }: { asset: string; at: number | null; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const near = useNear(box);
  // the same key as the timelines' (useMotionMarks): measured once for both
  const motion = useQuery({ queryKey: queryKeys.motion(asset), queryFn: () => oneAtATime(() => api.motion(asset)), enabled: near, staleTime: Infinity, retry: 0 });
  const bars = barsOf(motion.data?.sound);
  const clip = useId();
  const W = BARS * 3;
  const d = (bars ?? []).map((v, i) => `M${i * 3} ${(1 - v) * 50}h2v${v * 100}h-2z`).join("");
  return (
    <span ref={box} className={className}>
      {bars ? (
        <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox={`0 0 ${W} 100`} preserveAspectRatio="none">
          <clipPath id={clip}><rect x={0} y={0} width={(at ?? 0) * W} height={100} /></clipPath>
          <path d={d} className="fill-line-strong" />
          {at !== null && <path d={d} className="fill-accent" clipPath={`url(#${clip})`} />}
        </svg>
      ) : (
        // not measured yet, or nothing to measure: a quiet line where the waveform goes
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
      )}
      {at !== null && <span aria-hidden className="absolute -inset-y-1 w-0.5 rounded-full bg-ink" style={{ left: `${at * 100}%` }} />}
    </span>
  );
}
