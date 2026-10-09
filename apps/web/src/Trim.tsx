import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Camera, Clapperboard, Copy, Gauge, Link2, Pause, Play, Repeat, Scissors, Split, X, ZoomIn, ZoomOut } from "lucide-react";
import type { Asset } from "./api";
import { clock } from "./format";
import { Kbd } from "./Keys";
import { Select } from "./Select";
import { Button, cx } from "./ui";
import { useSettled } from "./hooks";

/** Where the cut's quality is remembered, per browser. */
const CRF_KEY = "afflatus.cut.crf";
const CRFS = [
  { value: "10", label: "CRF 10 · near-lossless", note: "large file" },
  { value: "16", label: "CRF 16 · very good", note: "half the size" },
  { value: "23", label: "CRF 23 · web", note: "small" },
];
const cutCrf = (): number => {
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

/** "0:04.20": a moment to the frame, with hundredths. */
const stamp = (ms: number) => clock(ms, { decimals: 2 });

/** The most frames a strip holds: past that, one tile stands for several frames. */
const STRIP_FRAMES = 120;

/** The frames at in and at out, large enough to judge, beside the video while trimming. Asked for once the handles settle. */
export function RangeFrames({ asset, range }: { asset: Asset; range: Range }) {
  const shown = useSettled(range, 220);
  return (
    <div className="flex h-full min-h-0 w-[22%] max-w-[260px] min-w-[120px] shrink-0 flex-col justify-center gap-2" onClick={(e) => e.stopPropagation()}>
      {[{ label: "In", at: shown.startMs }, { label: "Out", at: shown.endMs }].map((f) => (
        <div key={f.label} className="flex min-h-0 flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold text-ink-2">{f.label} <span className="font-mono font-normal">{stamp(f.at)}</span></span>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-line bg-raised">
            <img src={`/api/assets/${asset.id}/peek?at=${Math.round(f.at)}&h=480`} alt="" className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The Trim mode of a video: a filmstrip of the whole video with the playhead and an in and an out handle,
 * a second strip of the part zoomed into (down to one tile per frame), a picture of the exact frame
 * under the mouse, and what can be done with the range. The `<video>` is the viewer's own; this takes
 * it over (its native controls are off while trimming). Keys: I / O set in and out at the playhead,
 * , and . step one frame, ← and → too (Shift: ten), L loops the range, Space plays, Home / End, Z zooms to the range.
 */
export function Trim({ asset, player, busy, initial, actions, compact, onCopy, onSplit, onRemove, onSlow, onFrame, onBetween, onExtendHere, onRange, scenes, onEveryScene, onClose }: {
  asset: Asset;
  player: RefObject<HTMLVideoElement | null>;
  busy?: boolean;
  /** The range to start on (a timeline clip: what plays of its take); the whole video otherwise. */
  initial?: Range;
  /** A host's own action row (the timeline's), in place of the library's. */
  actions?(ctx: { range: Range; at: number; crf: number; whole: boolean }): ReactNode;
  /** Less tall, where the video above needs the room (the timeline). */
  compact?: boolean;
  onCopy?(range: Range, crf: number): void;
  onSplit?(range: Range, crf: number): void;
  onRemove?(range: Range, crf: number): void;
  /** The range slowed down ×2 or ×4, as a new video (RIFE on the GPU when ComfyUI has it, else ffmpeg). */
  onSlow?(range: Range, factor: 2 | 4): void;
  onFrame(atMs: number): void;
  /** A new clip from the frame at in to the frame at out. */
  onBetween?(range: Range): void;
  /** A new clip that starts at the playhead's moment. */
  onExtendHere?(atMs: number): void;
  /** The range as it stands, for whoever shows its frames. */
  onRange?(range: Range): void;
  /** Where the video cuts between shots (moments), shown as marks; and every shot copied out as its own video. */
  scenes?: number[];
  onEveryScene?(cuts: number[], crf: number): void;
  onClose(): void;
}) {
  const duration = asset.durationMs ?? 0;
  const fps = asset.fps && asset.fps > 0 ? asset.fps : 24;
  const frameMs = 1000 / fps;
  const [range, setRange] = useState<Range>(initial ? { startMs: Math.max(0, initial.startMs), endMs: Math.min(duration, initial.endMs) } : { startMs: 0, endMs: duration });
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
  useEffect(() => { onRange?.(range); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps
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
    const onSeeked = () => setAt(v.currentTime * 1000);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    if (!v.paused) onPlay();
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
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

  /** The range with room on both sides: zoomed to, its two handles show inside the strip, not on its edges. */
  const roomy = (r: Range): Range => {
    const pad = Math.max((r.endMs - r.startMs) * 0.08, 4 * frameMs);
    return { startMs: r.startMs - pad, endMs: r.endMs + pad };
  };

  /** Loop on: from the range's start when the playhead is outside it, and playing. Loop off: the video goes on. */
  const toggleLoop = () => {
    const v = player.current;
    if (looping) { setLooping(false); return; }
    setLooping(true);
    if (!v) return;
    if (at < range.startMs - 1 || at > range.endMs - frameMs) seek(range.startMs);
    if (v.paused) void v.play();
  };

  // the keys of the mode: bound once, reading the playhead, the range and the zoom as they stand (the
  // playhead moves with every frame decoded; a listener re-bound each time would be the dearest part of playing)
  const now = useRef({ at, range, zoom, toggleLoop, onClose });
  now.current = { at, range, zoom, toggleLoop, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as Partial<HTMLElement> | null;
      if (typeof el?.closest === "function" && el.closest("input, textarea, select, [contenteditable], [role=listbox]")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = player.current;
      const { at, range, zoom } = now.current;
      // , and . are one frame on every layout: on AZERTY "." is itself Shift + ";", so Shift cannot mean ten there.
      // Ten frames is Shift with the arrows, as in the timeline
      const step = frameMs;
      const arrows = (e.shiftKey ? 10 : 1) * frameMs;
      switch (e.key) {
        case "i": case "I": e.preventDefault(); setRange((r) => ({ startMs: Math.min(at, r.endMs - frameMs), endMs: r.endMs })); break;
        case "o": case "O": e.preventDefault(); setRange((r) => ({ startMs: r.startMs, endMs: Math.max(at, r.startMs + frameMs) })); break;
        case ",": case "<": e.preventDefault(); v?.pause(); seek(at - step); break;
        case ".": case ">": e.preventDefault(); v?.pause(); seek(at + step); break;
        case "ArrowLeft": e.preventDefault(); v?.pause(); seek(at - arrows); break;
        case "ArrowRight": e.preventDefault(); v?.pause(); seek(at + arrows); break;
        case "l": case "L": e.preventDefault(); now.current.toggleLoop(); break;
        case "z": case "Z": e.preventDefault(); zoomTo(zoom ? null : roomy(range)); break;
        case " ": e.preventDefault(); if (v) { if (v.paused) void v.play(); else v.pause(); } break;
        case "Home": e.preventDefault(); seek(0); break;
        case "End": e.preventDefault(); seek(duration); break;
        case "Escape": e.preventDefault(); now.current.onClose(); break;
        default: return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [duration, frameMs, player, seek, zoomTo]);
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
  const settled = useSettled(zoom, 160);
  // out of the zoom at once
  const settledZoom = zoom ? settled : null;
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
        className={cx("relative w-full cursor-crosshair touch-none rounded-lg bg-raised select-none", compact ? (tall ? "h-11" : "h-8") : tall ? "h-16" : "h-12")}
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
          {/* where the video cuts between shots: a tick each; a click on one later is the same as a press there */}
          {(scenes ?? []).filter(inWin).map((ms) => (
            <div key={ms} className="pointer-events-none absolute inset-y-0 w-px bg-amber-300/90 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" style={{ left: pct(ms) }} data-tip={`Cut at ${clock(ms)}`}>
              <div className="absolute -top-px left-1/2 h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-amber-300" />
            </div>
          ))}
          {/* the zoomed part, shown on the whole */}
          {kind === "whole" && zoom && <div className="pointer-events-none absolute inset-y-0 border-x-2 border-picture/80 bg-picture/30" style={{ left: pct(zoom.startMs), width: `${((zoom.endMs - zoom.startMs) / span) * 100}%` }} />}
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
    <div className={cx("flex w-full shrink-0 flex-col rounded-xl border border-line-strong bg-panel", compact ? "gap-1.5 p-2" : "gap-2 p-3")} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Scissors size={14} className="text-accent" />
        <span className="font-semibold text-ink">Trim</span>
        <span className="font-mono">in {stamp(range.startMs)} · out {stamp(range.endMs)} · {(length / 1000).toFixed(2)} s · {frames} frame{frames === 1 ? "" : "s"}</span>
        <span className="grow" />
        <span className="font-mono">{stamp(at)} / {clock(duration)}</span>
        <button type="button" aria-label="Leave Trim" data-tip="Leave Trim (Esc)" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover hover:text-ink"><X size={14} /></button>
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
        <Button size="sm" tone={playing ? "primary" : "plain"} aria-pressed={playing} aria-label="Play / pause" onClick={() => { const v = player.current; if (!v) return; if (v.paused) void v.play(); else v.pause(); }} data-tip="Play / pause (Space)">{playing ? <Pause size={13} /> : <Play size={13} />}</Button>
        <Button size="sm" onClick={() => moveIn(at)} data-tip="Set in at the playhead">In <Kbd>I</Kbd></Button>
        <Button size="sm" onClick={() => moveOut(at)} data-tip="Set out at the playhead">Out <Kbd>O</Kbd></Button>
        <Button size="sm" onClick={() => { player.current?.pause(); seek(at - frameMs); }} data-tip="One frame back (Shift: ten)"><Kbd>,</Kbd></Button>
        <Button size="sm" onClick={() => { player.current?.pause(); seek(at + frameMs); }} data-tip="One frame forward (Shift: ten)"><Kbd>.</Kbd></Button>
        <Button size="sm" tone={looping ? "primary" : "plain"} aria-pressed={looping} onClick={toggleLoop} data-tip={looping ? "Stop looping (the video goes on playing)" : "Loop the range"}><Repeat size={13} /> Loop <Kbd>L</Kbd></Button>
        <Button size="sm" tone={zoom ? "primary" : "plain"} aria-pressed={Boolean(zoom)} onClick={() => zoomTo(zoom ? null : roomy(range))} data-tip={zoom ? "Back to the whole video" : "Zoom into the range: a second strip, down to one tile per frame. The mouse wheel on a strip zooms too."}>{zoom ? <ZoomOut size={13} /> : <ZoomIn size={13} />} {zoom ? "Whole" : "Zoom to range"} <Kbd>Z</Kbd></Button>
        <span className="grow" />
        <div className="w-52">
          <Select size="sm" className="h-8" label="Quality of the cut" value={crf} onChange={choose} options={CRFS} />
        </div>
      </div>

      {actions ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2">{actions({ range, at, crf: crfN, whole })}</div>
      ) : (
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2">
        <Button size="sm" tone="primary" disabled={busy || whole} data-tip={whole ? "The whole video: there is nothing to cut." : "The range as a new video in your library; this one stays."} onClick={() => onCopy?.(range, crfN)}><Copy size={13} /> Copy to library</Button>
        <Button size="sm" disabled={busy || whole} data-tip="Three videos: before the range, the range, after it. This one goes to the bin." onClick={() => onSplit?.(range, crfN)}><Split size={13} /> Split</Button>
        <Button size="sm" disabled={busy || whole} data-tip="One video without the range. This one goes to the bin." onClick={() => onRemove?.(range, crfN)}><Scissors size={13} /> Remove range</Button>
        {onEveryScene && scenes && scenes.length > 0 && (
          <Button size="sm" disabled={busy} data-tip={`${scenes.length + 1} shots found by their cuts: each copied out as its own video. This one stays.`} onClick={() => onEveryScene(scenes, crfN)}><Split size={13} /> Extract every scene ({scenes.length + 1})</Button>
        )}
        {onSlow && (
          <>
            <span className="mx-1 h-5 border-l border-line" />
            <Button size="sm" disabled={busy} data-tip="The range at half speed, as a new video, its sound slowed with it (pitch kept): RIFE on the GPU through the queue when ComfyUI has it, else ffmpeg's motion interpolation on the processor, which is slow." onClick={() => onSlow(range, 2)}><Gauge size={13} /> Slow ×2</Button>
            <Button size="sm" disabled={busy} data-tip="The range at a quarter speed, as a new video, its sound slowed with it." onClick={() => onSlow(range, 4)}><Gauge size={13} /> ×4</Button>
          </>
        )}
        <span className="mx-1 h-5 border-l border-line" />
        <Button size="sm" disabled={busy} data-tip="The frame at the playhead, as an image in your library (G does the same)" onClick={() => onFrame(at)}><Camera size={13} /> Frame at playhead <Kbd>G</Kbd></Button>
        <span className="mx-1 h-5 border-l border-line" />
        {onBetween && <Button size="sm" disabled={busy} data-tip="A new clip from the frame at in to the frame at out, on the video model used last: first frame, last frame, duration = the range." onClick={() => onBetween(range)}><Clapperboard size={13} /> Generate between</Button>}
        {onExtendHere && <Button size="sm" disabled={busy} data-tip="A new clip that starts at the playhead's moment (H3 carries the motion on from there; the others open on that frame)." onClick={() => onExtendHere(at)}><Link2 size={13} /> Extend from here</Button>}
      </div>
      )}
    </div>
  );
}
