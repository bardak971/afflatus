import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "./ui";

/**
 * The app's slider with two knobs: a stretch of a span, from one to the other (what of a take plays). The same
 * track, fill and knobs as Slider; a press on the track takes the nearer knob there. The knobs keep at least
 * `gap` apart (one step when left out). The arrow keys move the focused knob one step (Shift: ten), Home and
 * End as far as it goes.
 *
 * `onChange` hears every move while dragging; `onCommit`, when given, only the pair let go on.
 */
export function RangeSlider({ from, to, min, max, step = 1, gap, onChange, onCommit, label, format, className }: {
  from: number;
  to: number;
  min: number;
  max: number;
  step?: number;
  /** The least the two keep apart. */
  gap?: number;
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
  const snap = (v: number) => Number((Math.round(Math.max(min, Math.min(max, v)) / step) * step).toFixed(decimals));
  const shownFrom = drag?.from ?? from;
  const shownTo = drag?.to ?? to;
  const at = (v: number) => (max === min ? 0 : ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100);
  const say = (v: number) => (format ? format(v) : v.toFixed(decimals));

  /** The pair with one knob moved to `v`, held off the other. */
  const moved = (knob: "from" | "to", v: number, a = from, b = to) =>
    knob === "from" ? { from: Math.max(min, Math.min(snap(v), b - apart)), to: b } : { from: a, to: Math.min(max, Math.max(snap(v), a + apart)) };

  const valueAt = (e: PointerEvent<HTMLElement>) => {
    const r = track.current!.getBoundingClientRect();
    return min + ((e.clientX - r.left) / Math.max(1, r.width)) * (max - min);
  };
  // the pair let go on is the one committed
  const last = useRef({ from, to });
  useEffect(() => {
    last.current = { from, to };
  }, [from, to]);
  const move = (knob: "from" | "to", v: number) => {
    const next = moved(knob, v);
    last.current = next;
    setDrag({ knob, ...next });
    if (next.from !== from || next.to !== to) onChange(next.from, next.to);
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
        className="group/knob absolute flex h-[22px] w-5 -translate-x-1/2 items-center justify-center outline-none"
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
          const which = hit ?? (Math.abs(v - from) < Math.abs(v - to) || v < from ? "from" : "to");
          track.current!.querySelector<HTMLElement>(`[data-knob=${which}]`)?.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          move(which, v);
        }}
        onPointerMove={(e) => {
          if (drag && e.currentTarget.hasPointerCapture(e.pointerId)) move(drag.knob, valueAt(e));
        }}
        onPointerUp={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          setDrag(null);
          onCommit?.(last.current.from, last.current.to);
        }}
        onPointerCancel={() => setDrag(null)}
        className="group/slider relative flex h-[22px] min-w-[60px] grow cursor-pointer touch-none items-center"
      >
        <span aria-hidden className={cx("absolute inset-x-0 rounded-full transition-[height,background-color]", drag ? "h-1.5 bg-ink-3" : "h-1 bg-line-strong group-hover/slider:h-1.5 group-hover/slider:bg-ink-3")} />
        <span aria-hidden style={{ left: `${at(shownFrom)}%`, width: `${at(shownTo) - at(shownFrom)}%` }} className={cx("absolute rounded-full bg-accent", drag ? "h-1.5" : "h-1 group-hover/slider:h-1.5")} />
        {knob("from")}
        {knob("to")}
      </span>
    </span>
  );
}
