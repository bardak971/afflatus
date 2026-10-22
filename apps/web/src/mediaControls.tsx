import { useId, type KeyboardEvent, type PointerEvent } from "react";
import { Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { clock } from "./format";
import { BARS } from "./screens/library/SoundWave";
import { cx } from "./ui";

/**
 * The pieces the app's players share, in place of the browser's controls: the play button, the position
 * strip (the sound's waveform, or a plain bar), the time, and the volume. The audio player and the video
 * player are made of them.
 */

/** How far an arrow key moves on the position strip, in seconds (Shift: one). */
const STEP_S = 5;
/** The volume every player starts on, kept in this browser: what was set last. */
const VOLUME_KEY = "afflatus.volume";

export function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  } catch {
    return 1;
  }
}

export function storeVolume(v: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    // a browser that keeps nothing: this player only
  }
}

// one sound at a time: a player that starts pauses the one that played
let playing: HTMLMediaElement | null = null;

/** Play this one, pausing whichever played before it. */
export function claimPlayback(el: HTMLMediaElement) {
  if (playing && playing !== el) playing.pause();
  playing = el;
}

/** Gone from the screen: no longer the one that plays. */
export function releasePlayback(el: HTMLMediaElement | null) {
  if (playing === el) playing = null;
}

/** Where along an element the pointer is, 0 to 1. */
const along = (e: PointerEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
};

/** A strip that a click or a drag sets (the position, the volume): the pointer held on it until it is let go. */
function useDrag(set: (at: number) => void) {
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      set(along(e));
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) set(along(e));
    },
  };
}

/**
 * The round accent button that plays and pauses: the one look of play in the app (the viewer, the music, the timeline's
 * player). `label` and `tip` where it plays something more particular (the timeline's range).
 */
export function PlayButton({ on, onClick, label, tip, disabled, className }: { on: boolean; onClick(): void; label?: string; tip?: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label ?? (on ? "Pause" : "Play")}
      data-tip={tip ?? (on ? "Pause" : "Play")}
      data-tip-keys="Space"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100", className)}
    >
      {on ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
    </button>
  );
}

/** Where it is, out of how long: mono. */
export function TimeReadout({ now, span }: { now: number; span: number | null }) {
  return (
    <span className="shrink-0 font-mono text-xs text-ink-2 tabular-nums">
      {clock(now * 1000)} / {span === null ? "–:––" : clock(span * 1000)}
    </span>
  );
}

/**
 * The position: the sound's waveform with what was played in the accent, or a plain bar when there is no
 * waveform. A click or a drag goes there; the arrow keys go back and forth (Shift: one second), Home and End
 * to the ends.
 */
export function SeekStrip({ at, now, span, bars, playing: on, name, onSeek }: {
  /** Where it is, 0 to 1. */
  at: number;
  /** Where it is and how long it is, in seconds. */
  now: number;
  span: number | null;
  /** The loudness as bars, 0 to 1, or nothing for a plain bar. */
  bars?: number[] | null;
  playing: boolean;
  name?: string;
  onSeek(fraction: number): void;
}) {
  const clip = useId();
  const drag = useDrag(onSeek);
  const onKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (span === null) return;
    const step = (e.shiftKey ? 1 : STEP_S) / span;
    const go = e.key === "ArrowLeft" || e.key === "ArrowDown" ? at - step : e.key === "ArrowRight" || e.key === "ArrowUp" ? at + step : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
    if (go === null) return;
    // the viewer's arrow keys go to the next item: here they move in the sound or the video
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.max(0, Math.min(1, go)));
  };
  const W = BARS * 3;
  const d = (bars ?? []).map((v, i) => `M${i * 3} ${(1 - v) * 50}h2v${v * 100}h-2z`).join("");
  return (
    <span
      role="slider"
      tabIndex={0}
      aria-label={name ? `Position in ${name}` : "Position"}
      aria-valuemin={0}
      aria-valuemax={Math.round(span ?? 0)}
      aria-valuenow={Math.round(now)}
      aria-valuetext={`${clock(now * 1000)} of ${span === null ? "unknown" : clock(span * 1000)}`}
      onKeyDown={onKeys}
      onClick={(e) => e.stopPropagation()}
      {...drag}
      className="group/seek relative flex h-7 min-w-0 grow cursor-pointer touch-none items-center rounded-sm"
    >
      {bars ? (
        <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox={`0 0 ${W} 100`} preserveAspectRatio="none">
          <clipPath id={clip}><rect x={0} y={0} width={at * W} height={100} /></clipPath>
          <path d={d} className="fill-line-strong group-hover/seek:fill-ink-3" />
          <path d={d} className="fill-accent" clipPath={`url(#${clip})`} />
        </svg>
      ) : (
        // no waveform (no sound, not in the library, or not measured yet): a plain bar
        <span aria-hidden className="relative h-1 w-full overflow-hidden rounded-full bg-line-strong group-hover/seek:h-1.5">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${at * 100}%` }} />
        </span>
      )}
      {(on || at > 0) && <span aria-hidden className="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-ink" style={{ left: `${at * 100}%` }} />}
    </span>
  );
}

/** The mute button and the volume strip. */
export function VolumeControl({ volume, muted, onVolume, onMuted }: { volume: number; muted: boolean; onVolume(v: number): void; onMuted(muted: boolean): void }) {
  const drag = useDrag(onVolume);
  const shown = muted ? 0 : volume;
  const onKeys = (e: KeyboardEvent<HTMLElement>) => {
    const by = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.1 : null;
    if (by === null) return;
    e.preventDefault();
    e.stopPropagation();
    onVolume(shown + by);
  };
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-ink-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={muted ? "Sound on" : "Mute"}
        aria-pressed={muted}
        data-tip={muted ? "Sound on" : "Mute"}
        onClick={() => {
          if (muted && volume === 0) onVolume(0.7);
          else onMuted(!muted);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-ink"
      >
        {shown === 0 ? <VolumeX size={15} /> : shown < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
      </button>
      <span
        role="slider"
        tabIndex={0}
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-valuetext={`${Math.round(shown * 100)} %`}
        onKeyDown={onKeys}
        {...drag}
        className={cx("group/vol flex h-5 w-14 cursor-pointer touch-none items-center rounded-sm")}
      >
        <span aria-hidden className="relative h-1 w-full rounded-full bg-line-strong">
          <span className="absolute inset-y-0 left-0 rounded-full bg-ink-2 group-hover/vol:bg-ink" style={{ width: `${shown * 100}%` }} />
        </span>
      </span>
    </span>
  );
}
