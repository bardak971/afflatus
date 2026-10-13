import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { snapTo } from "./snap";
import { cx } from "./ui";

/**
 * The app's slider with two knobs: a stretch of a span, from one to the other (what of a take plays). The same
 * track, fill and knobs as Slider; a press on the track takes the nearer knob there. The knobs keep at least
 * `gap` apart (one step when left out). The arrow keys move the focused knob one step (Shift: ten), Home and
 * End as far as it goes.
 *
 * `onChange` hears every move while dragging; `onCommit`, when given, only the pair let go on. A part of a sound
 * (SoundRange) draws its waveform as the `track`, keeps the knobs at most `most` apart and snaps them to its pauses
 * (`snapAt`, not while Alt is held). With `onPick`, a press on the track itself is no longer a knob's: a click picks
 * that moment (to play from), a drag draws a new stretch from it. `quiet`: the knobs show on hover, focus or a drag
 * only (always on a touch screen).
 */
export function RangeSlider({ from, to, min, max, step = 1, gap, most, snapAt, track: drawn, onPick, quiet, onChange, onCommit, label, format, className }: {
  from: number;
  to: number;
  min: number;
  max: number;
  step?: number;
  /** The least the two keep apart. */
  gap?: number;
  /** The most the two keep apart: a knob dragged further stops there. */
  most?: number;
  /** Where a dragged knob lands near `v` (a pause in a sound): asked for a drag without Alt, not for the keys. */
  snapAt?(knob: "from" | "to", v: number): number;
  /** Drawn in place of the thin track and its fill (a waveform), as tall as it is. */
  track?: ReactNode;
  /** A click on the track, off the knobs: the value there. */
  onPick?(v: number): void;
  /** The knobs hidden until the slider is hovered, focused or dragged. */
  quiet?: boolean;
  onChange(from: number, to: number): void;
  onCommit?(from: number, to: number): void;
  label: string;
  /** How a value is written in the bubble and for screen readers. */
  format?(value: number): string;
  className?: string;
}) {
  const track = useRef<HTMLSpanElement>(null);
  // the knob being dragged, and the pair while it moves
  const [drag, setDrag] = useState<{ knob: "from" | "to"; from: number; to: number } | null>(null);
  const decimals = (String(step).split(".")[1] ?? "").length;
  const apart = Math.max(step, gap ?? step);
  const snap = (v: number) => snapTo(v, min, max, step);
  const shownFrom = drag?.from ?? from;
  const shownTo = drag?.to ?? to;
  const at = (v: number) => (max === min ? 0 : ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100);
  const say = (v: number) => (format ? format(v) : v.toFixed(decimals));

  /** The pair with one knob moved to `v`, held off the other. */
  const moved = (knob: "from" | "to", v: number, a = from, b = to) => {
    const wide = most ?? max - min;
    return knob === "from"
      ? { from: Math.max(min, b - wide, Math.min(snap(v), b - apart)), to: b }
      : { from: a, to: Math.min(max, a + wide, Math.max(snap(v), a + apart)) };
  };

  const valueAt = (e: PointerEvent<HTMLElement>) => {
    const r = track.current!.getBoundingClientRect();
    return min + ((e.clientX - r.left) / Math.max(1, r.width)) * (max - min);
  };
  // a press on the track with onPick: where it was, and whether it has become a drag that draws a new stretch
  const press = useRef<{ x: number; v: number; drawing: boolean } | null>(null);
  // the pair let go on is the one committed
  const last = useRef({ from, to });
  useEffect(() => {
    last.current = { from, to };
  }, [from, to]);
  const move = (knob: "from" | "to", v: number, free = false) => {
    const next = moved(knob, snapAt && !free ? snapAt(knob, v) : v);
    last.current = next;
    setDrag({ knob, ...next });
    if (next.from !== from || next.to !== to) onChange(next.from, next.to);
  };
  /** A new stretch drawn from `anchor` to `v`, its ends snapped, held between gap and most. */
  const draw = (anchor: number, v: number, free: boolean) => {
    const wide = most ?? max - min;
    const right = v >= anchor;
    let lo = right ? anchor : v;
    let hi = right ? v : anchor;
    if (snapAt && !free) {
      lo = snapAt("from", lo);
      hi = snapAt("to", hi);
    }
    lo = Math.max(min, snap(lo));
    hi = Math.min(max, snap(hi));
    if (hi - lo > wide) {
      if (right) hi = lo + wide;
      else lo = hi - wide;
    }
    if (hi - lo < apart) {
      if (right) hi = Math.min(max, lo + apart);
      else lo = Math.max(min, hi - apart);
    }
    last.current = { from: lo, to: hi };
    setDrag({ knob: right ? "to" : "from", from: lo, to: hi });
    onChange(lo, hi);
  };
  const onKeys = (knob: "from" | "to") => (e: KeyboardEvent<HTMLSpanElement>) => {
    const by = (e.shiftKey ? 10 : 1) * step;
    const now = knob === "from" ? from : to;
    const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? now + by : e.key === "ArrowLeft" || e.key === "ArrowDown" ? now - by : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const pair = moved(knob, next);
    if (pair.from === from && pair.to === to) return;
    onChange(pair.from, pair.to);
    onCommit?.(pair.from, pair.to);
  };

  const knob = (which: "from" | "to") => {
    const v = which === "from" ? shownFrom : shownTo;
    const held = drag?.knob === which;
    return (
      <span
        key={which}
        data-knob={which}
        role="slider"
        tabIndex={0}
        aria-label={`${label}: ${which === "from" ? "start" : "end"}`}
        aria-valuemin={which === "from" ? min : shownFrom + apart}
        aria-valuemax={which === "from" ? shownTo - apart : max}
        aria-valuenow={v}
        aria-valuetext={say(v)}
        onKeyDown={onKeys(which)}
        style={{ left: `${at(v)}%` }}
        className={cx(
          "group/knob absolute flex h-[22px] w-5 -translate-x-1/2 items-center justify-center outline-none",
          quiet && !drag && "opacity-0 transition-opacity group-hover/slider:opacity-100 group-focus-within/slider:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <span
          aria-hidden
          className={cx(
            "pointer-events-none rounded-full bg-ink shadow-[0_0_0_3px_var(--color-panel)] transition-[width,height] group-focus-visible/knob:shadow-[0_0_0_3px_var(--color-panel),0_0_0_5px_var(--color-accent)]",
            held ? "h-[18px] w-[18px]" : "h-3.5 w-3.5 group-hover/slider:h-4 group-hover/slider:w-4",
          )}
        />
        {held && (
          <span aria-hidden className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-md bg-ink px-1.5 py-px font-mono text-[11px] font-medium whitespace-nowrap text-ground">
            {say(v)}
          </span>
        )}
      </span>
    );
  };

  return (
    <span className={cx("flex min-w-0 items-center", className)}>
      <span
        ref={track}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const v = valueAt(e);
          // the knob pressed on, else the nearer one (on a tie: the side the press is on)
          const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-knob]")?.dataset.knob as "from" | "to" | undefined;
          e.currentTarget.setPointerCapture(e.pointerId);
          if (!hit && onPick) {
            press.current = { x: e.clientX, v, drawing: false };
            return;
          }
          const which = hit ?? (Math.abs(v - from) < Math.abs(v - to) || v < from ? "from" : "to");
          track.current!.querySelector<HTMLElement>(`[data-knob=${which}]`)?.focus();
          move(which, v, e.altKey);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const p = press.current;
          if (p) {
            // a few pixels of slack: a click that shakes is still a click
            if (!p.drawing && Math.abs(e.clientX - p.x) < 4) return;
            p.drawing = true;
            draw(p.v, valueAt(e), e.altKey);
            return;
          }
          if (drag) move(drag.knob, valueAt(e), e.altKey);
        }}
        onPointerUp={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const p = press.current;
          press.current = null;
          if (p && !p.drawing) return onPick?.(p.v);
          setDrag(null);
          onCommit?.(last.current.from, last.current.to);
        }}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
        className={cx("group/slider relative flex min-w-[60px] grow cursor-pointer touch-none items-center", !drawn && "h-[22px]")}
      >
        {drawn ?? (
          <>
            <span aria-hidden className={cx("absolute inset-x-0 rounded-full transition-[height,background-color]", drag ? "h-1.5 bg-ink-3" : "h-1 bg-line-strong group-hover/slider:h-1.5 group-hover/slider:bg-ink-3")} />
            <span aria-hidden style={{ left: `${at(shownFrom)}%`, width: `${at(shownTo) - at(shownFrom)}%` }} className={cx("absolute rounded-full bg-accent", drag ? "h-1.5" : "h-1 group-hover/slider:h-1.5")} />
          </>
        )}
        {knob("from")}
        {knob("to")}
      </span>
    </span>
  );
}
