import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pause, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { api, fileUrl } from "./api";
import { clock } from "./format";
import { barsOf, BARS } from "./screens/library/SoundWave";
import { cx } from "./ui";

/**
 * The app's audio player, in place of the browser's: a play button, the name and the time, the sound's
 * waveform (the loudness the server measures once for the library and the timelines) with what was played
 * in the accent, and the volume. A click or a drag on the waveform goes there; with the focus on the
 * player, Space plays and pauses, and the arrow keys on the waveform go back and forth. A sound that is
 * not in the library (no `asset`) has a plain bar in place of its waveform.
 */

/** How far an arrow key moves on the waveform, in seconds (Shift: one). */
const STEP_S = 5;
/** The volume every player starts on, kept in this browser: what was set last. */
const VOLUME_KEY = "afflatus.volume";

function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) !== null && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  } catch {
    return 1;
  }
}

// one sound at a time: a player that starts pauses the one that played
let playing: HTMLAudioElement | null = null;

/** Where along an element the pointer is, 0 to 1. */
const along = (e: PointerEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
};

/** A strip that a click or a drag sets (the waveform, the volume): the pointer held on it until it is let go. */
function useDrag(set: (at: number) => void) {
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      set(along(e));
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) set(along(e));
    },
  };
}

export function AudioPlayer({ asset, src, name, range, bare, className, onClick, children }: {
  /** The sound (or the video whose sound it is) in the library: its waveform is drawn. */
  asset?: string;
  /** Another address than the asset's file: a sound that is not in the library. */
  src?: string;
  /** Written over the waveform; left out, the time goes after it on one line. */
  name?: string;
  /** Only a part is played, in seconds of the sound: the waveform and the time are those of the part. */
  range?: { from: number; to: number };
  /** Inside a card of its own: no border and no ground. */
  bare?: boolean;
  className?: string;
  onClick?(e: React.MouseEvent): void;
  /** After the volume: buttons of the place it is in. */
  children?: ReactNode;
}) {
  const url = src ?? (asset ? fileUrl(asset) : "");
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  // the position and the length, in seconds of the sound (the part's start is taken off when shown)
  const [now, setNow] = useState(range?.from ?? 0);
  const [length, setLength] = useState<number | null>(null);
  const [volume, setVolumeState] = useState(savedVolume);
  const [muted, setMuted] = useState(false);
  const clip = useId();

  // the same key as the library's waveform and the timelines' curves: measured once for all of them
  const motion = useQuery({ queryKey: ["motion", asset], queryFn: () => api.motion(asset!), enabled: Boolean(asset), staleTime: Infinity, retry: 0 });

  const from = range ? range.from : 0;
  const to = range ? (length === null ? range.to : Math.min(range.to, length)) : length;
  const span = to === null ? null : Math.max(0.01, to - from);
  const at = span === null ? 0 : Math.max(0, Math.min(1, (now - from) / span));

  // the loudness of the part played, as bars
  const sound = motion.data?.sound;
  const rate = motion.data?.rate ?? 10;
  const bars = barsOf(sound && range ? sound.slice(Math.floor(range.from * rate), Math.ceil(range.to * rate)) : sound, BARS);

  // another sound or another part: from its start, paused
  useEffect(() => {
    setOn(false);
    setNow(range?.from ?? 0);
    setLength(null);
  }, [url, range?.from, range?.to]);

  useEffect(() => {
    const el = audio.current;
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [volume, muted, url]);

  // while it plays: the position read every frame (timeupdate comes four times a second, too few for the waveform)
  useEffect(() => {
    const el = audio.current;
    if (!on || !el) return;
    let frame = 0;
    const tick = () => {
      if (to !== null && el.currentTime >= to) {
        el.pause();
        el.currentTime = from;
      }
      setNow(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [on, from, to]);

  // gone from the screen: silent
  useEffect(() => () => {
    if (playing === audio.current) playing = null;
  }, []);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    if (el.currentTime < from || (to !== null && el.currentTime >= to - 0.05)) el.currentTime = from;
    if (playing && playing !== el) playing.pause();
    playing = el;
    void el.play().catch(() => setOn(false));
  };
  const seek = (fraction: number) => {
    const el = audio.current;
    if (!el || span === null) return;
    const t = from + fraction * span;
    el.currentTime = t;
    setNow(t);
  };
  const setVolume = (v: number) => {
    const next = Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
    setVolumeState(next);
    setMuted(next === 0);
    try {
      localStorage.setItem(VOLUME_KEY, String(next));
    } catch {
      // a browser that keeps nothing: this player only
    }
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey) return;
    // Space plays and pauses whatever in the player has the focus (a button would click itself too)
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) toggle();
  };
  const onSeekKeys = (e: KeyboardEvent<HTMLElement>) => {
    if (span === null) return;
    const step = (e.shiftKey ? 1 : STEP_S) / span;
    const go = e.key === "ArrowLeft" || e.key === "ArrowDown" ? at - step : e.key === "ArrowRight" || e.key === "ArrowUp" ? at + step : e.key === "Home" ? 0 : e.key === "End" ? 1 : null;
    if (go === null) return;
    // the viewer's arrow keys go to the next item: here they move in the sound
    e.preventDefault();
    e.stopPropagation();
    seek(Math.max(0, Math.min(1, go)));
  };
  const onVolumeKeys = (e: KeyboardEvent<HTMLElement>) => {
    const by = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.1 : null;
    if (by === null) return;
    e.preventDefault();
    e.stopPropagation();
    setVolume((muted ? 0 : volume) + by);
  };
  const seekDrag = useDrag(seek);
  const volumeDrag = useDrag(setVolume);

  const shownVolume = muted ? 0 : volume;
  const time = (
    <span className="shrink-0 font-mono text-xs text-ink-2 tabular-nums">
      {clock((now - from) * 1000)} / {span === null ? "–:––" : clock(span * 1000)}
    </span>
  );
  const W = BARS * 3;
  const d = (bars ?? []).map((v, i) => `M${i * 3} ${(1 - v) * 50}h2v${v * 100}h-2z`).join("");
  const wave = (
    <span
      role="slider"
      tabIndex={0}
      aria-label={name ? `Position in ${name}` : "Position"}
      aria-valuemin={0}
      aria-valuemax={Math.round(span ?? 0)}
      aria-valuenow={Math.round(now - from)}
      aria-valuetext={`${clock((now - from) * 1000)} of ${span === null ? "unknown" : clock(span * 1000)}`}
      onKeyDown={onSeekKeys}
      {...seekDrag}
      className="group/seek relative flex h-7 min-w-0 grow cursor-pointer touch-none items-center rounded-sm"
    >
      {bars ? (
        <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox={`0 0 ${W} 100`} preserveAspectRatio="none">
          <clipPath id={clip}><rect x={0} y={0} width={at * W} height={100} /></clipPath>
          <path d={d} className="fill-line-strong group-hover/seek:fill-ink-3" />
          <path d={d} className="fill-accent" clipPath={`url(#${clip})`} />
        </svg>
      ) : (
        // no waveform (not in the library, or not measured yet): a plain bar
        <span aria-hidden className="relative h-1 w-full overflow-hidden rounded-full bg-line-strong">
          <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${at * 100}%` }} />
        </span>
      )}
      {(on || at > 0) && <span aria-hidden className="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-ink" style={{ left: `${at * 100}%` }} />}
    </span>
  );

  return (
    <div
      onKeyDown={onKeys}
      onClick={onClick}
      className={cx("flex min-w-0 items-center gap-3.5", !bare && "rounded-[14px] border border-line bg-raised px-3.5 py-2.5", className)}
    >
      <audio
        key={url}
        ref={audio}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setLength(el.duration);
          if (from) el.currentTime = from;
        }}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
        onPlay={() => setOn(true)}
        onPause={(e) => {
          setOn(false);
          setNow(e.currentTarget.currentTime);
        }}
        onEnded={(e) => {
          setOn(false);
          e.currentTarget.currentTime = from;
          setNow(from);
        }}
        onSeeked={(e) => !on && setNow(e.currentTarget.currentTime)}
      />
      <button
        type="button"
        aria-label={on ? "Pause" : "Play"}
        data-tip={on ? "Pause (Space)" : "Play (Space)"}
        onClick={toggle}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110"
      >
        {on ? <Pause size={14} fill="currentColor" strokeWidth={0} /> : <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-px" />}
      </button>
      {name ? (
        <span className="flex min-w-0 grow flex-col gap-1.5">
          <span className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="min-w-0 grow truncate font-semibold">{name}</span>
            {time}
          </span>
          {wave}
        </span>
      ) : (
        <>
          {wave}
          {time}
        </>
      )}
      <span className="flex shrink-0 items-center gap-1.5 text-ink-2">
        <button
          type="button"
          aria-label={muted ? "Sound on" : "Mute"}
          aria-pressed={muted}
          data-tip={muted ? "Sound on" : "Mute"}
          onClick={() => {
            if (muted && volume === 0) setVolume(0.7);
            else setMuted(!muted);
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-ink"
        >
          {shownVolume === 0 ? <VolumeX size={15} /> : shownVolume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
        </button>
        <span
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shownVolume * 100)}
          aria-valuetext={`${Math.round(shownVolume * 100)} %`}
          onKeyDown={onVolumeKeys}
          {...volumeDrag}
          className="group/vol flex h-5 w-14 cursor-pointer touch-none items-center rounded-sm"
        >
          <span aria-hidden className="relative h-1 w-full rounded-full bg-line-strong">
            <span className="absolute inset-y-0 left-0 rounded-full bg-ink-2 group-hover/vol:bg-ink" style={{ width: `${shownVolume * 100}%` }} />
          </span>
        </span>
      </span>
      {children}
    </div>
  );
}
