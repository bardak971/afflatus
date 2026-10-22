import type { KeyboardEvent, MutableRefObject, PointerEvent, RefObject } from "react";
import { clock } from "../format";
import { cx } from "../ui";
import { stamp, type Range } from "./range";

/** The frame under the mouse on a strip: its moment, where it is across the strip, and which strip. */
export interface Hover {
  ms: number;
  x: number;
  bar: "whole" | "zoom";
}

/**
 * One of Trim's strips: the whole video, or the part zoomed into (`win`). The range, its two handles and the playhead sit
 * on it where they fall in its window; a press moves the playhead, the handles drag (and take the arrows), and the frame
 * under the mouse is shown above it. What it changes is Trim's (`range`, the playhead, `hover`): two strips share it.
 */
export function Strip({ assetId, win, kind, src, tall, compact, range, at, zoom, settledZoom, scenes, hover, peek, dragging, duration, frameMs, player, moveIn, moveOut, showFrom, setHover, placed }: {
  assetId: string;
  win: Range;
  kind: "whole" | "zoom";
  src: string;
  tall: boolean;
  compact?: boolean;
  range: Range;
  at: number;
  zoom: Range | null;
  /** The window the zoom strip's picture was made for (it follows the zoom once that settles). */
  settledZoom: Range | null;
  scenes?: number[];
  hover: Hover | null;
  peek: number | null;
  /** What a pointer drags across the strips, if anything: shared, as one drag can leave one strip for the other. */
  dragging: MutableRefObject<"in" | "out" | "head" | null>;
  duration: number;
  frameMs: number;
  player: RefObject<HTMLVideoElement | null>;
  moveIn(ms: number): void;
  moveOut(ms: number): void;
  /** The picture of the frame that starts at a frame's edge on a strip. */
  showFrom(edge: number): void;
  setHover(h: Hover | null): void;
  /** Where the strip's element goes, for the wheel's zoom (useWheelZoom). */
  placed(el: HTMLDivElement | null): void;
}) {
  const span = win.endMs - win.startMs;
  const snap = (ms: number) => Math.round(ms / frameMs) * frameMs;
  // the zoom strip was made for the settled window: until the next one arrives, it is placed where its moments fall now
  const made = kind === "zoom" && settledZoom ? settledZoom : win;
  const stripStyle = { left: `${((made.startMs - win.startMs) / span) * 100}%`, width: `${((made.endMs - made.startMs) / span) * 100}%` };
  const pct = (ms: number) => `${Math.max(0, Math.min(100, ((ms - win.startMs) / span) * 100))}%`;
  const inWin = (ms: number) => ms >= win.startMs - 1 && ms <= win.endMs + 1;
  const msAt = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    return Math.max(win.startMs, Math.min(win.endMs, win.startMs + ((clientX - r.left) / r.width) * span));
  };
  // a handle with the focus moves a frame with the arrows (Shift: ten), showing the frame it stands for; the playhead's
  // own arrows (Trim's, the timeline's) are not stepped as well
  const nudge = (what: "in" | "out") => (e: KeyboardEvent) => {
    const by = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!by || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    player.current?.pause();
    const ms = snap((what === "in" ? range.startMs : range.endMs) + by * (e.shiftKey ? 10 : 1) * frameMs);
    if (what === "in") {
      const to = Math.max(0, Math.min(ms, range.endMs - frameMs));
      moveIn(to);
      showFrom(to);
    } else {
      const to = Math.min(duration, Math.max(ms, range.startMs + frameMs));
      moveOut(to);
      showFrom(to - frameMs);
    }
  };
  const grab = (what: "in" | "out" | "head") => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = what;
    (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
    player.current?.pause();
  };
  return (
    <div
      data-bar={kind}
      className={cx("relative w-full cursor-crosshair touch-none rounded-lg bg-raised select-none", compact ? (tall ? "h-11" : "h-8") : tall ? "h-16" : "h-12")}
      onPointerDown={(e) => {
        // a press anywhere but on a handle moves the playhead there
        if ((e.target as HTMLElement).closest("[role=slider]")) return;
        player.current?.pause();
        showFrom(snap(msAt(e.currentTarget, e.clientX)));
        dragging.current = "head";
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const ms = snap(msAt(e.currentTarget, e.clientX));
        if (dragging.current === "in") moveIn(ms);
        else if (dragging.current === "out") moveOut(ms);
        // the frame the handle stands for: the first one in for In, the last one in for Out
        if (dragging.current === "out") showFrom(ms - frameMs);
        else if (dragging.current) showFrom(ms);
        else setHover({ ms, x: e.clientX - e.currentTarget.getBoundingClientRect().left, bar: kind });
      }}
      onPointerUp={() => { dragging.current = null; }}
      onPointerCancel={() => { dragging.current = null; }}
      onPointerLeave={() => { if (!dragging.current) setHover(null); }}
      ref={placed}
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
          <div key={ms} className="pointer-events-none absolute inset-y-0 w-px bg-attention/90 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-shade)_50%,transparent)]" style={{ left: pct(ms) }} data-tip={`Cut at ${clock(ms)}`}>
            <div className="absolute -top-px left-1/2 h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-attention" />
          </div>
        ))}
        {/* the zoomed part, shown on the whole */}
        {kind === "whole" && zoom && <div className="pointer-events-none absolute inset-y-0 border-x-2 border-picture/80 bg-picture/30" style={{ left: pct(zoom.startMs), width: `${((zoom.endMs - zoom.startMs) / span) * 100}%` }} />}
      </div>
      {inWin(range.startMs) && <div role="slider" aria-label="In" aria-valuenow={Math.round(range.startMs)} aria-valuemin={0} aria-valuemax={Math.round(range.endMs - frameMs)} aria-valuetext={stamp(range.startMs)} tabIndex={0} onPointerDown={grab("in")} onKeyDown={nudge("in")} className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent" style={{ left: pct(range.startMs) }} />}
      {inWin(range.endMs) && <div role="slider" aria-label="Out" aria-valuenow={Math.round(range.endMs)} aria-valuemin={Math.round(range.startMs + frameMs)} aria-valuemax={Math.round(duration)} aria-valuetext={stamp(range.endMs)} tabIndex={0} onPointerDown={grab("out")} onKeyDown={nudge("out")} className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-accent" style={{ left: pct(range.endMs) }} />}
      {/* the playhead, over everything: a white line with a dark edge, and a small head on top (the stage's ink-strong and shade: the viewer is a stage in every theme) */}
      {inWin(at) && (
        <div className="pointer-events-none absolute -top-1 bottom-0 w-0.5 -translate-x-1/2 bg-ink-strong shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-shade)_60%,transparent)]" style={{ left: pct(at) }}>
          <div className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-ink-strong shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-shade)_60%,transparent)]" />
        </div>
      )}
      {/* the frame under the mouse, exact */}
      {hover && hover.bar === kind && !dragging.current && (
        <div className="pointer-events-none absolute bottom-full z-10 mb-1 flex -translate-x-1/2 flex-col items-center gap-0.5" style={{ left: hover.x }}>
          {peek !== null && <img src={`/api/assets/${assetId}/peek?at=${peek}`} alt="" className="max-h-40 rounded-md border border-line-strong bg-ground shadow-lg" />}
          <span className="rounded bg-ground/90 px-1.5 py-0.5 font-mono text-meta text-ink">{stamp(hover.ms)}</span>
        </div>
      )}
    </div>
  );
}
