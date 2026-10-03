import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Camera, Clapperboard, Copy, Link2, Pause, Play, Repeat, Scissors, Split, X, ZoomIn, ZoomOut } from "lucide-react";
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

/** The most frames a strip holds: past that, one tile stands for several frames. */
const STRIP_FRAMES = 120;

/**
 * The Trim mode of a video: a filmstrip of the whole video with the playhead and an in and an out handle,
 * a second strip of the part zoomed into (down to one tile per frame), a picture of the exact frame
 * under the mouse, and what can be done with the range. The `<video>` is the viewer's own; this takes
 * it over (its native controls are off while trimming). Keys: I / O set in and out at the playhead,
 * , and . step one frame (Shift: ten), L loops the range, Space plays, Home / End, Z zooms to the range.
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
  // the part zoomed into: null is the whole video
  const [zoom, setZoom] = useState<Range | null>(null);
  // the exact frame under the mouse, on either strip
  const [hover, setHover] = useState<{ ms: number; x: number; bar: "whole" | "zoom" } | null>(null);
  const [peek, setPeek] = useState<number | null>(null);
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

  // the picture of the frame under the mouse: asked for a moment after the mouse settles
  useEffect(() => {
    if (!hover) { setPeek(null); return; }
    const t = setTimeout(() => setPeek(Math.round(hover.ms)), 90);
    return () => clearTimeout(t);
  }, [hover?.ms]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomTo = useCallback((win: Range | null) => {
    if (!win) return setZoom(null);
    const least = Math.min(duration, STRIP_FRAMES * frameMs);
    let a = Math.max(0, win.startMs);
    let b = Math.min(duration, win.endMs);
    if (b - a < least) { const mid = (a + b) / 2; a = Math.max(0, mid - least / 2); b = Math.min(duration, a + least); a = Math.max(0, b - least); }
    if (a <= 0 && b >= duration) return setZoom(null);
    setZoom({ startMs: a, endMs: b });
  }, [duration, frameMs]);

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
        case "z": case "Z": e.preventDefault(); zoomTo(zoom ? null : range); break;
        case " ": e.preventDefault(); if (v) { if (v.paused) void v.play(); else v.pause(); } break;
        case "Home": e.preventDefault(); seek(0); break;
        case "End": e.preventDefault(); seek(duration); break;
        case "Escape": e.preventDefault(); onClose(); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, duration, frameMs, player, range, seek, onClose, zoom, zoomTo]);

  const length = range.endMs - range.startMs;
  const frames = Math.round(length / frameMs);
  const whole = range.startMs <= 0 && range.endMs >= duration;
  const choose = (v: string) => {
    setCrf(v);
    try { localStorage.setItem(CRF_KEY, v); } catch { /* nowhere to remember it */ }
  };
  const crfN = Number(crf) || 10;
  const snap = (ms: number) => Math.round(ms / frameMs) * frameMs;
  const moveIn = (ms: number) => setRange((r) => ({ startMs: Math.max(0, Math.min(ms, r.endMs - frameMs)), endMs: r.endMs }));
  const moveOut = (ms: number) => setRange((r) => ({ startMs: r.startMs, endMs: Math.min(duration, Math.max(ms, r.startMs + frameMs)) }));
  const zoomFrames = zoom ? Math.min(STRIP_FRAMES, Math.max(2, Math.ceil((zoom.endMs - zoom.startMs) / frameMs))) : 0;
  const exact = zoom ? (zoom.endMs - zoom.startMs) / frameMs <= STRIP_FRAMES + 0.5 : false;
  const wholeSrc = useMemo(() => `/api/assets/${asset.id}/strip?frames=${Math.min(STRIP_FRAMES, Math.max(16, Math.round(duration / 1000)))}&height=48`, [asset.id, duration]);
  // the strip of the zoomed part is asked for once the zoom has settled: a wheel gesture is many small steps
  const [settledZoom, setSettledZoom] = useState<Range | null>(null);
  useEffect(() => {
    if (!zoom) { setSettledZoom(null); return; }
    const t = setTimeout(() => setSettledZoom(zoom), 160);
    return () => clearTimeout(t);
  }, [zoom]);
  const zoomSrc = useMemo(() => {
    if (!settledZoom) return "";
    const n = Math.min(STRIP_FRAMES, Math.max(2, Math.ceil((settledZoom.endMs - settledZoom.startMs) / frameMs)));
    return `/api/assets/${asset.id}/strip?frames=${n}&height=64&from=${Math.round(settledZoom.startMs)}&to=${Math.round(settledZoom.endMs)}`;
  }, [asset.id, settledZoom, frameMs]);

  // the wheel zooms around the moment under the mouse, by how far it turned (a mouse notch halves or doubles;
  // a trackpad's many small steps add up); the page under it does not scroll
  const wheelTargets = useRef<Record<string, HTMLDivElement | null>>({});
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const els = Object.entries(wheelTargets.current).filter((x): x is [string, HTMLDivElement] => Boolean(x[1]));
    const handlers = els.map(([kind, el]) => {
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const current = zoomRef.current ?? { startMs: 0, endMs: duration };
        const win = kind === "zoom" && zoomRef.current ? zoomRef.current : { startMs: 0, endMs: duration };
        const r = el.getBoundingClientRect();
        const ms = win.startMs + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (win.endMs - win.startMs);
        const factor = Math.min(2, Math.max(0.5, Math.exp(e.deltaY * 0.004)));
        const span = current.endMs - current.startMs;
        const nextSpan = Math.min(duration, span * factor);
        const share = Math.max(0, Math.min(1, (ms - current.startMs) / span));
        zoomTo({ startMs: ms - nextSpan * share, endMs: ms + nextSpan * (1 - share) });
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    });
    return () => handlers.forEach((off) => off());
  }, [duration, zoomTo, zoom === null]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One strip: the whole video, or the part zoomed into. The handles and the playhead sit on it where they fall in its window. */
  const bar = (win: Range, kind: "whole" | "zoom", src: string, tall: boolean) => {
    const span = win.endMs - win.startMs;
    // the zoom strip was made for the settled window: until the next one arrives, it is placed where its moments fall now
    const made = kind === "zoom" && settledZoom ? settledZoom : win;
    const stripStyle = { left: `${((made.startMs - win.startMs) / span) * 100}%`, width: `${((made.endMs - made.startMs) / span) * 100}%` };
    const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - win.startMs) / span) * 100))}%`;
    const inWin = (ms: number) => ms >= win.startMs - 1 && ms <= win.endMs + 1;
    const msAt = (el: HTMLElement, clientX: number) => {
      const r = el.getBoundingClientRect();
      return Math.max(win.startMs, Math.min(win.endMs, win.startMs + ((clientX - r.left) / r.width) * span));
    };
    const grab = (what: "in" | "out" | "head") => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = what;
      (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
      player.current?.pause();
    };
    return (
      <div
        key={kind}
        data-bar={kind}
        className={cx("relative w-full cursor-crosshair touch-none rounded-lg bg-raised select-none", tall ? "h-16" : "h-12")}
        onPointerDown={(e) => {
          // a press anywhere but on a handle moves the playhead there
          if ((e.target as HTMLElement).closest("[role=slider]")) return;
          player.current?.pause();
          seek(snap(msAt(e.currentTarget, e.clientX)));
          dragging.current = "head";
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const ms = snap(msAt(e.currentTarget, e.clientX));
          if (dragging.current === "in") moveIn(ms);
          else if (dragging.current === "out") moveOut(ms);
          if (dragging.current) seek(ms);
          else setHover({ ms, x: e.clientX - e.currentTarget.getBoundingClientRect().left, bar: kind });
        }}
        onPointerUp={() => { dragging.current = null; }}
        onPointerCancel={() => { dragging.current = null; }}
        onPointerLeave={() => { if (!dragging.current) setHover(null); }}
        ref={(el) => { wheelTargets.current[kind] = el; }}
      >
        <div className="absolute inset-0 overflow-hidden rounded-lg">
          {/* stretched to the bar, never cropped: a moment on the bar is the same moment on the strip */}
          <img src={src} alt="" draggable={false} className="pointer-events-none absolute inset-y-0 h-full object-fill opacity-90" style={stripStyle} />
          {/* what is outside the range is dimmed */}
          {range.startMs > win.startMs && <div className="pointer-events-none absolute inset-y-0 left-0 bg-ground/70" style={{ width: pct(Math.min(range.startMs, win.endMs)) }} />}
          {range.endMs < win.endMs && <div className="pointer-events-none absolute inset-y-0 right-0 bg-ground/70" style={{ width: `${Math.max(0, Math.min(100, ((win.endMs - Math.max(range.endMs, win.startMs)) / span) * 100))}%` }} />}
          <div className="pointer-events-none absolute inset-y-0 border-y-2 border-accent" style={{ left: pct(Math.max(range.startMs, win.startMs)), width: `${Math.max(0, Math.min(100, ((Math.min(range.endMs, win.endMs) - Math.max(range.startMs, win.startMs)) / span) * 100))}%` }} />
          {/* the zoomed part, shown on the whole */}
          {kind === "whole" && zoom && <div className="pointer-events-none absolute inset-y-0 border-x border-ink-strong/60 bg-ink-strong/10" style={{ left: pct(zoom.startMs), width: `${((zoom.endMs - zoom.startMs) / span) * 100}%` }} />}
        </div>
        {inWin(range.startMs) && <div role="slider" aria-label="In" aria-valuenow={Math.round(range.startMs)} tabIndex={0} onPointerDown={grab("in")} className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent" style={{ left: pct(range.startMs) }} />}
        {inWin(range.endMs) && <div role="slider" aria-label="Out" aria-valuenow={Math.round(range.endMs)} tabIndex={0} onPointerDown={grab("out")} className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent" style={{ left: pct(range.endMs) }} />}
        {/* the playhead, over everything: a white line with a dark edge, and a small head on top */}
        {inWin(at) && (
          <div className="pointer-events-none absolute -top-1 bottom-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" style={{ left: pct(at) }}>
            <div className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]" />
          </div>
        )}
        {/* the frame under the mouse, exact */}
        {hover && hover.bar === kind && !dragging.current && (
          <div className="pointer-events-none absolute bottom-full z-10 mb-1 flex -translate-x-1/2 flex-col items-center gap-0.5" style={{ left: hover.x }}>
            {peek !== null && <img src={`/api/assets/${asset.id}/peek?at=${peek}`} alt="" className="max-h-40 rounded-md border border-line-strong bg-ground shadow-lg" />}
            <span className="rounded bg-ground/90 px-1.5 py-0.5 font-mono text-[11px] text-ink">{stamp(hover.ms)}</span>
          </div>
        )}
      </div>
    );
  };

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

      {/* the whole video; under it, the part zoomed into */}
      {bar({ startMs: 0, endMs: duration }, "whole", wholeSrc, !zoom)}
      {zoom && (
        <div className="flex flex-col gap-1">
          {bar(zoom, "zoom", zoomSrc, true)}
          <span className="font-mono text-[11px] text-ink-3">{stamp(zoom.startMs)} – {stamp(zoom.endMs)} · {exact ? "one tile per frame" : `${Math.round((zoom.endMs - zoom.startMs) / frameMs / zoomFrames)} frames per tile`} · wheel to zoom, Z to leave</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => { const v = player.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }} title="Play / pause (Space)">{playing ? <Pause size={13} /> : <Play size={13} />}</Button>
        <Button size="sm" onClick={() => moveIn(at)} title="Set in at the playhead">In <Kbd>I</Kbd></Button>
        <Button size="sm" onClick={() => moveOut(at)} title="Set out at the playhead">Out <Kbd>O</Kbd></Button>
        <Button size="sm" onClick={() => { player.current?.pause(); seek(at - frameMs); }} title="One frame back (Shift: ten)"><Kbd>,</Kbd></Button>
        <Button size="sm" onClick={() => { player.current?.pause(); seek(at + frameMs); }} title="One frame forward (Shift: ten)"><Kbd>.</Kbd></Button>
        <Button size="sm" className={cx(looping && "border-accent text-accent")} onClick={() => { setLooping(!looping); if (!looping) { seek(range.startMs); void player.current?.play(); } }} title="Loop the range"><Repeat size={13} /> Loop <Kbd>L</Kbd></Button>
        <Button size="sm" className={cx(zoom && "border-accent text-accent")} onClick={() => zoomTo(zoom ? null : range)} title={zoom ? "Back to the whole video" : "Zoom into the range: a second strip, down to one tile per frame. The mouse wheel on a strip zooms too."}>{zoom ? <ZoomOut size={13} /> : <ZoomIn size={13} />} {zoom ? "Whole" : "Zoom to range"} <Kbd>Z</Kbd></Button>
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
        <Button size="sm" disabled={busy} title="The frame at the playhead, as an image in your library (G does the same)" onClick={() => onFrame(at)}><Camera size={13} /> Frame at playhead <Kbd>G</Kbd></Button>
        <span className="mx-1 h-5 border-l border-line" />
        {onBetween && <Button size="sm" disabled={busy} title="A new clip from the frame at in to the frame at out, on the video model used last: first frame, last frame, duration = the range." onClick={() => onBetween(range)}><Clapperboard size={13} /> Generate between</Button>}
        {onExtendHere && <Button size="sm" disabled={busy} title="A new clip that starts at the playhead's moment (H3 carries the motion on from there; the others open on that frame)." onClick={() => onExtendHere(at)}><Link2 size={13} /> Extend from here</Button>}
      </div>
    </div>
  );
}
