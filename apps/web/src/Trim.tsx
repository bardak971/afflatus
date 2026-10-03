import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Camera, Clapperboard, Copy, Link2, Pause, Play, Repeat, Scissors, Split, X } from "lucide-react";
import type { Asset } from "./api";
import { clock } from "./format";
import { Kbd } from "./Keys";
import { Select } from "./Select";
import { Button, cx } from "./ui";

/** Where the cut's quality is remembered, per browser. */
const CRF_KEY = "afflatus.cut.crf";
const CRFS = [
  { value: "10", label: "CRF 10 · near-lossless", note: "large file" },
  { value: "16", label: "CRF 16 · very good", note: "half the size" },
  { value: "23", label: "CRF 23 · web", note: "small" },
];
export const cutCrf = (): number => {
  try {
    return Number(localStorage.getItem(CRF_KEY) ?? 10) || 10;
  } catch {
    return 10;
  }
};

export interface Range {
  startMs: number;
  endMs: number;
}

/** "0:04.20": a moment with hundredths. */
const stamp = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 100)).padStart(2, "0")}`;
};

/**
 * The Trim mode of a video: a filmstrip, a scrubber with the playhead and an in and an out handle, and
 * what can be done with the range between them. The `<video>` is the viewer's own; this takes it over
 * (its native controls are off while trimming). Keys: I / O set in and out at the playhead, , and .
 * step one frame (Shift: ten), L loops the range, Space plays, Home / End.
 */
export function Trim({ asset, player, busy, onCopy, onSplit, onRemove, onFrame, onBetween, onExtendHere, onClose }: {
  asset: Asset;
  player: RefObject<HTMLVideoElement | null>;
  busy?: boolean;
  onCopy(range: Range, crf: number): void;
  onSplit(range: Range, crf: number): void;
  onRemove(range: Range, crf: number): void;
  onFrame(atMs: number): void;
  /** A new clip from the frame at in to the frame at out. */
  onBetween?(range: Range): void;
  /** A new clip that starts at the playhead's moment. */
  onExtendHere?(atMs: number): void;
  onClose(): void;
}) {
  const duration = asset.durationMs ?? 0;
  const fps = asset.fps && asset.fps > 0 ? asset.fps : 24;
  const frameMs = 1000 / fps;
  const [range, setRange] = useState<Range>({ startMs: 0, endMs: duration });
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const [crf, setCrf] = useState(String(cutCrf()));
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef<"in" | "out" | "head" | null>(null);
  const seek = useCallback((ms: number) => {
    const v = player.current;
    const to = Math.max(0, Math.min(duration, ms));
    if (v) v.currentTime = to / 1000;
    setAt(to);
  }, [player, duration]);

  // the playhead follows the video, frame by frame where the browser can say so
  useEffect(() => {
    const v = player.current;
    if (!v) return;
    let handle = 0;
    const tick = () => {
      setAt(v.currentTime * 1000);
      // the loop: back to in when out is reached
      if (looping && v.currentTime * 1000 >= range.endMs - 1) v.currentTime = range.startMs / 1000;
      handle = "requestVideoFrameCallback" in v ? (v as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number }).requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    const onPlay = () => { setPlaying(true); tick(); };
    const onPause = () => { setPlaying(false); setAt(v.currentTime * 1000); };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onPause);
    if (!v.paused) onPlay();
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onPause);
      if ("cancelVideoFrameCallback" in v) (v as HTMLVideoElement & { cancelVideoFrameCallback(h: number): void }).cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [player, looping, range.startMs, range.endMs]);

  // the keys of the mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as Partial<HTMLElement> | null;
      if (typeof el?.closest === "function" && el.closest("input, textarea, select, [contenteditable], [role=listbox]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = player.current;
      const step = (e.shiftKey ? 10 : 1) * frameMs;
      switch (e.key) {
        case "i": case "I": e.preventDefault(); setRange((r) => ({ startMs: Math.min(at, r.endMs - frameMs), endMs: r.endMs })); break;
        case "o": case "O": e.preventDefault(); setRange((r) => ({ startMs: r.startMs, endMs: Math.max(at, r.startMs + frameMs) })); break;
        case ",": case "<": e.preventDefault(); v?.pause(); seek(at - step); break;
        case ".": case ">": e.preventDefault(); v?.pause(); seek(at + step); break;
        case "l": case "L": e.preventDefault(); setLooping((l) => !l); if (v && v.paused) { seek(range.startMs); void v.play(); } break;
        case " ": e.preventDefault(); if (v) { if (v.paused) void v.play(); else v.pause(); } break;
        case "Home": e.preventDefault(); seek(0); break;
        case "End": e.preventDefault(); seek(duration); break;
        case "Escape": e.preventDefault(); onClose(); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, duration, frameMs, player, range, seek, onClose]);

  const msAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || !duration) return 0;
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const onPointerDown = (what: "in" | "out" | "head") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = what;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    player.current?.pause();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const ms = Math.round(msAt(e.clientX) / frameMs) * frameMs;
    if (dragging.current === "in") setRange((r) => ({ startMs: Math.min(ms, r.endMs - frameMs), endMs: r.endMs }));
    else if (dragging.current === "out") setRange((r) => ({ startMs: r.startMs, endMs: Math.max(ms, r.startMs + frameMs) }));
    seek(ms);
  };
  const onPointerUp = () => { dragging.current = null; };

  const pct = (ms: number) => (duration ? `${(ms / duration) * 100}%` : "0%");
  const length = range.endMs - range.startMs;
  const frames = Math.round(length / frameMs);
  const whole = range.startMs <= 0 && range.endMs >= duration;
  const strip = useMemo(() => `/api/assets/${asset.id}/strip?frames=${Math.min(120, Math.max(16, Math.round(duration / 1000)))}&height=48`, [asset.id, duration]);
  const choose = (v: string) => {
    setCrf(v);
    try { localStorage.setItem(CRF_KEY, v); } catch { /* nowhere to remember it */ }
  };
  const crfN = Number(crf) || 10;

  return (
    <div className="flex w-full shrink-0 flex-col gap-2 rounded-xl border border-line-strong bg-panel p-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Scissors size={14} className="text-accent" />
        <span className="font-semibold text-ink">Trim</span>
        <span className="font-mono">in {stamp(range.startMs)} · out {stamp(range.endMs)} · {(length / 1000).toFixed(2)} s · {frames} frame{frames === 1 ? "" : "s"}</span>
        <span className="grow" />
        <span className="font-mono">{stamp(at)} / {clock(duration)}</span>
        <button type="button" aria-label="Leave Trim" title="Leave Trim (Esc)" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-ink"><X size={14} /></button>
      </div>

      {/* the filmstrip with the range on it */}
      <div
        ref={bar}
        className="relative h-14 w-full cursor-crosshair touch-none overflow-hidden rounded-lg bg-raised select-none"
        onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === "IMG") { player.current?.pause(); seek(msAt(e.clientX)); dragging.current = "head"; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* stretched to the bar, never cropped: a moment on the bar is the same moment on the strip */}
        <img src={strip} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-90" />
        {/* what is outside the range is dimmed */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-ground/70" style={{ width: pct(range.startMs) }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-ground/70" style={{ width: pct(duration - range.endMs) }} />
        <div className="pointer-events-none absolute inset-y-0 border-y-2 border-accent" style={{ left: pct(range.startMs), width: pct(length) }} />
        {/* the handles */}
        <div role="slider" aria-label="In" aria-valuenow={Math.round(range.startMs)} tabIndex={0} onPointerDown={onPointerDown("in")} className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent" style={{ left: pct(range.startMs) }} />
        <div role="slider" aria-label="Out" aria-valuenow={Math.round(range.endMs)} tabIndex={0} onPointerDown={onPointerDown("out")} className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent" style={{ left: pct(range.endMs) }} />
        {/* the playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink-strong" style={{ left: pct(at) }} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => { const v = player.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }} title="Play / pause (Space)">{playing ? <Pause size={13} /> : <Play size={13} />}</Button>
        <Button size="sm" onClick={() => setRange((r) => ({ startMs: Math.min(at, r.endMs - frameMs), endMs: r.endMs }))} title="Set in at the playhead">In <Kbd>I</Kbd></Button>
        <Button size="sm" onClick={() => setRange((r) => ({ startMs: r.startMs, endMs: Math.max(at, r.startMs + frameMs) }))} title="Set out at the playhead">Out <Kbd>O</Kbd></Button>
        <Button size="sm" onClick={() => { player.current?.pause(); seek(at - frameMs); }} title="One frame back (Shift: ten)"><Kbd>,</Kbd></Button>
        <Button size="sm" onClick={() => { player.current?.pause(); seek(at + frameMs); }} title="One frame forward (Shift: ten)"><Kbd>.</Kbd></Button>
        <Button size="sm" className={cx(looping && "border-accent text-accent")} onClick={() => { setLooping(!looping); if (!looping) { seek(range.startMs); void player.current?.play(); } }} title="Loop the range"><Repeat size={13} /> Loop <Kbd>L</Kbd></Button>
        <span className="grow" />
        <div className="w-52">
          <Select size="sm" className="h-8" label="Quality of the cut" value={crf} onChange={choose} options={CRFS} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <Button size="sm" tone="primary" disabled={busy || whole} title={whole ? "The whole video: there is nothing to cut." : "The range as a new video in your library; this one stays."} onClick={() => onCopy(range, crfN)}><Copy size={13} /> Copy to library</Button>
        <Button size="sm" disabled={busy || whole} title="Three videos: before the range, the range, after it. This one goes to the bin." onClick={() => onSplit(range, crfN)}><Split size={13} /> Split</Button>
        <Button size="sm" disabled={busy || whole} title="One video without the range. This one goes to the bin." onClick={() => onRemove(range, crfN)}><Scissors size={13} /> Remove range</Button>
        <span className="mx-1 h-5 border-l border-line" />
        <Button size="sm" disabled={busy} title="The frame at in, as an image" onClick={() => onFrame(range.startMs)}><Camera size={13} /> Frame at in</Button>
        <Button size="sm" disabled={busy} title="The frame at out, as an image" onClick={() => onFrame(range.endMs)}><Camera size={13} /> Frame at out</Button>
        <span className="mx-1 h-5 border-l border-line" />
        {onBetween && <Button size="sm" disabled={busy} title="A new clip from the frame at in to the frame at out, on the video model used last: first frame, last frame, duration = the range." onClick={() => onBetween(range)}><Clapperboard size={13} /> Generate between</Button>}
        {onExtendHere && <Button size="sm" disabled={busy} title="A new clip that starts at the playhead's moment (H3 carries the motion on from there; the others open on that frame)." onClick={() => onExtendHere(at)}><Link2 size={13} /> Extend from here</Button>}
      </div>
    </div>
  );
}
