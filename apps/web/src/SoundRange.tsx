import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { clock } from "./format";
import { pausesIn } from "./pauses";
import { queryKeys } from "./queryKeys";
import { RangeSlider } from "./RangeSlider";
import { barsOf } from "./screens/library/SoundWave";

/**
 * A part of a sound, chosen on the whole of it: its waveform, its pauses marked over it, and the part as a stretch
 * between two knobs (the app's RangeSlider, the timeline takes' slider). A knob dragged near a pause lands in it, so
 * that no word is cut; with Alt it goes where it is let go. The knobs keep at most `most` apart: what one clip holds
 * (a recording) or a model takes (a voice sample), and the sound past that is hatched.
 */

/** How many bars the waveform has across the whole sound. */
const BARS = 160;
/** How far into a pause a part's end goes (a part's start, before its end): the word ends whole, the next is not begun. */
const INTO = 0.2;

export type Pause = { from: number; to: number };

/** The sound's loudness and its pauses in seconds, measured once (the library's waveform and the timelines' key). */
export function useSoundMarks(asset: string | null) {
  const motion = useQuery({ queryKey: queryKeys.motion(asset), queryFn: () => api.motion(asset!), enabled: Boolean(asset), staleTime: Infinity, retry: 0 });
  return useMemo(() => {
    const sound = motion.data?.sound ?? null;
    const rate = motion.data?.rate ?? 10;
    const pauses: Pause[] = sound ? pausesIn(sound).map((p) => ({ from: p.from / rate, to: p.to / rate })) : [];
    return { sound, pauses, ready: motion.isFetched };
  }, [motion.data, motion.isFetched]);
}

/** Where a part that ends in this pause ends, and where one that starts in it starts. */
const endIn = (p: Pause) => p.from + Math.min(INTO, (p.to - p.from) / 2);
const startIn = (p: Pause) => p.to - Math.min(INTO, (p.to - p.from) / 2);
const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * The part a sound starts with when it is chosen: from its start, the whole of it when it fits in `longest`, else up to
 * the last pause that fits (else `longest`, a word cut: there is no pause to end on).
 */
export function firstPart(total: number, pauses: Pause[], longest: number): { start: number; seconds: number } {
  if (total <= longest) return { start: 0, seconds: tenth(total) };
  const ends = pauses.map(endIn).filter((e) => e >= 1 && e <= longest);
  return { start: 0, seconds: tenth(ends.length ? Math.max(...ends) : longest) };
}

export function SoundRange({ asset, total, start, seconds, min, most, label, playhead, onCommit }: {
  asset: string;
  /** The whole sound, in seconds. */
  total: number;
  start: number;
  seconds: number;
  /** The shortest part, and the longest. */
  min: number;
  most: number;
  label: string;
  /** Where the part being played is, in seconds of the sound: a line over the waveform. */
  playhead?: number | null;
  onCommit(start: number, seconds: number): void;
}) {
  const marks = useSoundMarks(asset);
  // the part while a knob is dragged; the form hears of it when the knob is let go
  const [moving, setMoving] = useState<{ from: number; to: number } | null>(null);
  const from = moving?.from ?? start;
  const to = moving?.to ?? Math.min(total, start + seconds);
  const clip = useId();
  const bars = barsOf(marks.sound, BARS);
  const pct = (t: number) => `${(Math.max(0, Math.min(total, t)) / total) * 100}%`;
  const W = BARS * 3;
  const d = (bars ?? []).map((v, i) => `M${i * 3} ${(1 - v) * 50}h2v${v * 100}h-2z`).join("");

  // a knob near a pause (within a fortieth of the sound) lands in it; the sound's two ends count as pauses
  const snapAt = (knob: "from" | "to", v: number) => {
    const marksAt = knob === "from" ? [0, ...marks.pauses.map(startIn)] : [total, ...marks.pauses.map(endIn)];
    let best = v;
    let near = total / 40;
    for (const m of marksAt) {
      if (Math.abs(m - v) < near) {
        near = Math.abs(m - v);
        best = m;
      }
    }
    return best;
  };

  const track = (
    <span className="relative block h-16 w-full">
      {/* the pauses found, over the waveform: where the knobs land */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-2">
        {marks.pauses.map((p) => <span key={p.from} className="absolute top-0.5 h-1 rounded-full bg-ink-3" style={{ left: pct(p.from), width: pct(p.to - p.from) }} />)}
      </span>
      <span aria-hidden className="absolute inset-x-0 top-3 bottom-0 overflow-hidden rounded-md bg-raised">
        {bars ? (
          <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${W} 100`} preserveAspectRatio="none">
            <clipPath id={clip}><rect x={(from / total) * W} y={0} width={((to - from) / total) * W} height={100} /></clipPath>
            <path d={d} className="fill-line-strong" />
            <path d={d} className="fill-accent" clipPath={`url(#${clip})`} />
          </svg>
        ) : (
          <span className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        )}
        {/* past what the part can reach from its start: no clip holds it */}
        {from + most < total && (
          <span className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,var(--color-ground)_0_5px,transparent_5px_10px)] opacity-60" style={{ left: pct(from + most) }} />
        )}
      </span>
      <span aria-hidden className="absolute top-2.5 -bottom-0.5 rounded-lg border-2 border-accent" style={{ left: pct(from), width: pct(to - from) }} />
      {playhead != null && !moving && <span aria-hidden className="absolute top-2 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-ink" style={{ left: pct(playhead) }} />}
    </span>
  );

  return (
    <div className="flex flex-col gap-1">
      <RangeSlider
        from={from} to={to} min={0} max={total} step={0.1} gap={Math.min(min, total)} most={most} snapAt={snapAt} track={track}
        label={label} format={(v) => `${v.toFixed(1)} s`}
        onChange={(a, b) => setMoving({ from: a, to: b })}
        onCommit={(a, b) => {
          setMoving(null);
          onCommit(tenth(a), tenth(b - a));
        }}
      />
      <span className="flex justify-between font-mono text-[10.5px] text-ink-3">
        <span>0:00</span>
        <span>{marks.pauses.length ? "Alt + drag: anywhere, not only in a pause" : ""}</span>
        <span>{clock(total * 1000, { decimals: 1 })}</span>
      </span>
    </div>
  );
}
