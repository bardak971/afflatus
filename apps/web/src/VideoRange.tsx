import { useState } from "react";
import { clock } from "./format";
import { RangeSlider } from "./RangeSlider";
import { cx } from "./ui";

/** How many frames the strip shows across the whole video. */
const TILES = 12;

/**
 * A part of a video, chosen on a strip of its frames: the app's RangeSlider over the frames ComfyUI-free peeks give
 * (GET /assets/:id/peek), the part's frames lit and the rest dimmed, what is past what one clip holds hatched. As a
 * sound's part (SoundRange): a click plays from there (`onSeek`), a drag on the strip draws a new part, the knobs show on
 * hover or focus. The knobs keep at most `most` apart.
 */
export function VideoRange({ asset, total, start, seconds, min, most, label, onSeek, onCommit }: {
  asset: string;
  /** The whole video, in seconds. */
  total: number;
  start: number;
  seconds: number;
  min: number;
  most: number;
  label: string;
  onSeek?(at: number): void;
  onCommit(start: number, seconds: number): void;
}) {
  // the part while a knob is dragged; the form hears of it when the knob is let go
  const [moving, setMoving] = useState<{ from: number; to: number } | null>(null);
  const from = moving?.from ?? start;
  const to = moving?.to ?? Math.min(total, start + seconds);
  const pct = (t: number) => `${(Math.max(0, Math.min(total, t)) / total) * 100}%`;
  const tenth = (v: number) => Math.round(v * 10) / 10;
  const at = (i: number) => ((i + 0.5) / TILES) * total;

  const track = (
    <span className="relative block h-14 w-full">
      <span aria-hidden className="absolute inset-0 flex gap-px overflow-hidden rounded-md bg-raised">
        {Array.from({ length: TILES }, (_, i) => (
          <img
            key={i} alt="" draggable={false} loading="lazy" src={`/api/assets/${asset}/peek?at=${Math.round(at(i) * 1000)}&h=96`}
            className={cx("h-full min-w-0 flex-1 object-cover transition-opacity", at(i) >= from && at(i) < to ? "opacity-100" : "opacity-35")}
          />
        ))}
        {/* past what the part can reach from its start: no clip holds it */}
        {from + most < total && (
          <span className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,var(--color-ground)_0_5px,transparent_5px_10px)] opacity-60" style={{ left: pct(from + most) }} />
        )}
      </span>
      <span
        aria-hidden style={{ left: pct(from), width: pct(to - from) }}
        className={cx("absolute -inset-y-0.5 rounded-lg border-2 border-accent", !moving && "opacity-0 transition-opacity group-hover/slider:opacity-100 group-focus-within/slider:opacity-100 pointer-coarse:opacity-100")}
      />
    </span>
  );

  return (
    <div className="flex flex-col gap-1">
      <RangeSlider
        from={from} to={to} min={0} max={total} step={0.1} gap={Math.min(min, total)} most={most} track={track}
        label={label} format={(v) => `${v.toFixed(1)} s`} quiet onPick={onSeek}
        onChange={(a, b) => setMoving({ from: a, to: b })}
        onCommit={(a, b) => {
          setMoving(null);
          // the end held to `most` exactly (a window of 141 frames is 5.875 s), not to a tenth
          onCommit(tenth(a), Math.min(most, tenth(b - a)));
        }}
      />
      <span className="flex justify-between gap-3 font-mono text-[10.5px] text-ink-3">
        <span className="shrink-0">0:00</span>
        <span className="min-w-0 truncate">click: play from there · drag: a new part</span>
        <span className="shrink-0">{clock(total * 1000, { decimals: 1 })}</span>
      </span>
    </div>
  );
}
