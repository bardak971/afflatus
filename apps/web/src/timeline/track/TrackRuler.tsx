import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Clock } from "../clock";
import { PAD, playAt, stamp, type Slot } from "../model";
import type { TimeRange } from "../Track";
import { HINTS } from "./peek";
import { HEIGHT, RULER } from "./rows";
import type { useMotionMarks } from "./useMotionMarks";

/** How far apart the ruler's labels are, in seconds: the first step that leaves them room. */
const stepFor = (pps: number) => [1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pps >= 58) ?? 300;

/**
 * The ruler over the track: its marks, the playhead moved by a click or a drag, the range swept with Shift
 * and dragged by its brackets, and the quiet moments and pauses In and Out snap to. The frame under the pointer
 * is FramePeek's, over the ruler and the clips alike.
 */
export function TrackRuler({ clock, durationMs, slots, totalMs, playEnd, pps, xOf, range, onRange, onSeek, band, motion, snapRange, snapQuiet }: {
  /** The moment of what plays: the slider says it, set in place so that the ruler does not redraw on every tick. */
  clock: Clock;
  durationMs: number;
  slots: Slot[];
  totalMs: number;
  /** Where what plays ends. */
  playEnd: number;
  pps: number;
  /** A pointer's x, in the track's own pixels. */
  xOf(clientX: number): number;
  range: TimeRange | null;
  onRange(range: TimeRange | null): void;
  onSeek(playMs: number, trackMs?: number): void;
  /** In and Out, in pixels; null while they cannot be placed. */
  band: { a: number; b: number } | null;
  motion: ReturnType<typeof useMotionMarks>["motion"];
  snapRange(ms: number): number;
  snapQuiet?: boolean;
}) {
  // the slider's value follows the clock without the ruler redrawing on every tick: the attribute is set in place
  const ruler = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const set = () => ruler.current?.setAttribute("aria-valuenow", String(Math.round(clock.get() / 1000)));
    set();
    return clock.subscribe(set);
  }, [clock]);

  // ---- the playhead: click or drag on the ruler
  const scrub = (e: ReactPointerEvent) => {
    const x = xOf(e.clientX);
    onSeek(playAt(slots, x), Math.max(0, Math.min(totalMs, ((x - PAD) / pps) * 1000)));
  };

  // ---- the range: In and Out, swept on the ruler with Shift, or dragged by their brackets; they snap to cuts, to the playhead and to quiet moments
  const sweep = useRef<number | null>(null);
  const grab = useRef<"in" | "out" | null>(null);

  const grabHandle = (e: ReactPointerEvent, which: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    grab.current = which;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveHandle = (e: ReactPointerEvent) => {
    if (!grab.current || !range) return;
    const ms = snapRange(playAt(slots, xOf(e.clientX)));
    onRange(grab.current === "in" ? { inMs: Math.min(ms, range.outMs), outMs: range.outMs } : { inMs: range.inMs, outMs: Math.max(ms, range.inMs) });
  };
  const dropHandle = (e: ReactPointerEvent) => {
    grab.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // ---- the ruler's marks
  const step = stepFor(pps);
  const marks = [];
  for (let s = 0; s * 1000 <= totalMs + step * 1000; s += step) marks.push(s);

  return (
    <>
      {/* the ruler: a click or a drag moves the playhead */}
      <div
        ref={ruler}
        role="slider"
        aria-label="Move the playhead"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(clock.get() / 1000)}
        tabIndex={0}
        onPointerDown={(e) => {
          // the browser must not take this for the start of a text selection or of a drag
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          if (e.shiftKey) {
            // Shift: a range is swept from here
            const ms = snapRange(playAt(slots, xOf(e.clientX)));
            sweep.current = ms;
            onRange({ inMs: ms, outMs: ms });
          } else scrub(e);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          if (sweep.current === null) return scrub(e);
          const ms = snapRange(playAt(slots, xOf(e.clientX)));
          onRange({ inMs: Math.min(sweep.current, ms), outMs: Math.max(sweep.current, ms) });
        }}
        onPointerUp={(e) => {
          sweep.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDragStart={(e) => e.preventDefault()}
        className="absolute inset-x-0 top-0 cursor-ew-resize touch-none border-b border-line"
        style={{ height: RULER }}
        data-hint={HINTS.ruler}
      >
        {marks.map((s) => (
          <span key={s} className="pointer-events-none absolute top-0 h-full border-l border-line-strong pl-1 font-mono text-[10px] leading-[18px] text-ink-3" style={{ left: PAD + s * pps }}>
            {stamp(s * 1000).slice(0, -2)}
          </span>
        ))}
      </div>
      {range && motion.map(({ slot: s, curve, quiet, pauses }) =>
        curve.length > 1 || pauses.length ? (
          <svg key={s.clip.id} aria-hidden className="pointer-events-none absolute top-0 z-[11] text-accent" style={{ left: s.left, width: s.width, height: RULER }} viewBox={`0 0 ${Math.max(1, s.width)} ${RULER}`} preserveAspectRatio="none">
            {curve.length > 1 && <path d={`M0 ${RULER} ${curve.map((v, k) => `L${((k / (curve.length - 1)) * s.width).toFixed(1)} ${(RULER - 2 - v * (RULER - 5)).toFixed(1)}`).join(" ")} L${s.width} ${RULER} Z`} fill="currentColor" opacity={0.22} />}
            {snapQuiet !== false && quiet.map((q) => <line key={q} x1={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} x2={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} y1={RULER - 6} y2={RULER - 1} stroke="currentColor" strokeWidth={1.5} opacity={0.7} />)}
            {/* pauses in the sound: a tick of the sound's green */}
            {snapQuiet !== false && pauses.map((q) => <line key={`p${q}`} x1={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} x2={((q - s.clip.atMs) / s.clip.lengthMs) * s.width} y1={1} y2={7} className="text-good" stroke="currentColor" strokeWidth={1.5} opacity={0.9} />)}
          </svg>
        ) : null,
      )}
      {band && range && (
        <>
          <div aria-hidden className="pointer-events-none absolute top-0 z-[12] border-x-2 border-accent bg-accent/15" style={{ left: band.a - 1, width: Math.max(2, band.b - band.a + 2), height: HEIGHT - 4 }} />
          <span
            role="slider"
            aria-label="In"
            aria-valuemin={0}
            aria-valuemax={Math.round(playEnd / 1000)}
            aria-valuenow={Math.round(range.inMs / 1000)}
            data-hint="drag: move In · I: In at the playhead"
            onPointerDown={(e) => grabHandle(e, "in")}
            onPointerMove={moveHandle}
            onPointerUp={dropHandle}
            onPointerCancel={dropHandle}
            className="absolute top-0 z-[16] flex w-2.5 cursor-ew-resize touch-none items-center justify-center rounded-l bg-accent font-mono text-[10px] font-bold leading-none text-accent-ink"
            style={{ left: band.a - 10, height: RULER - 1 }}
          >
            [
          </span>
          <span
            role="slider"
            aria-label="Out"
            aria-valuemin={0}
            aria-valuemax={Math.round(playEnd / 1000)}
            aria-valuenow={Math.round(range.outMs / 1000)}
            data-hint="drag: move Out · O: Out at the playhead"
            onPointerDown={(e) => grabHandle(e, "out")}
            onPointerMove={moveHandle}
            onPointerUp={dropHandle}
            onPointerCancel={dropHandle}
            className="absolute top-0 z-[16] flex w-2.5 cursor-ew-resize touch-none items-center justify-center rounded-r bg-accent font-mono text-[10px] font-bold leading-none text-accent-ink"
            style={{ left: band.b, height: RULER - 1 }}
          >
            ]
          </span>
        </>
      )}
    </>
  );
}
