import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { snapTo } from "./snap";
import { cx, NumberBox } from "./ui";

/**
 * The app's slider, in place of the browser's: an accent track with a round knob, the value in a small mono
 * box beside it to type into. Hovered, the track thickens and the knob grows; dragged, the value rides on the
 * knob. `mark` puts a notch where the model's default is (a click on it goes back there); `zero` fills from a
 * middle value rather than the left end (a LoRA's strength, −1 to 2, fills from 0). `off`: greyed, its setting
 * does nothing now. The arrow keys move one step (Shift: ten), Home and End go to the ends.
 *
 * `onChange` hears every move while dragging; `onCommit`, when given, only the value let go on (for what
 * should not be saved at every pixel).
 */
export function Slider({ value, min, max, step = 1, onChange, onCommit, label, unit, mark, zero, off, box = true, format, className }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
  onCommit?(value: number): void;
  label: string;
  unit?: string;
  /** The model's default: a notch on the track. */
  mark?: number;
  /** Where the fill starts from, when not the left end. */
  zero?: number;
  off?: boolean;
  /** The value box beside the track (left out: the bubble while dragging says it). */
  box?: boolean;
  /** How the value is written in the bubble and for screen readers. */
  format?(value: number): string;
  className?: string;
}) {
  const track = useRef<HTMLSpanElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const decimals = (String(step).split(".")[1] ?? "").length;
  const snap = (v: number) => snapTo(v, min, max, step);
  const shown = drag ?? value;
  const at = (v: number) => (max === min ? 0 : ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * 100);
  const said = format ? format(shown) : `${shown.toFixed(decimals)}${unit ? ` ${unit.trim()}` : ""}`;
  const from = zero !== undefined ? Math.min(at(zero), at(shown)) : 0;
  const to = zero !== undefined ? Math.max(at(zero), at(shown)) : at(shown);

  const valueAt = (e: PointerEvent<HTMLElement>) => {
    const r = track.current!.getBoundingClientRect();
    return snap(min + ((e.clientX - r.left) / Math.max(1, r.width)) * (max - min));
  };
  // the value let go on is the one committed
  const last = useRef(value);
  useEffect(() => {
    last.current = value;
  }, [value]);
  const move = (v: number) => {
    last.current = v;
    setDrag(v);
    if (v !== value) onChange(v);
  };
  const onKeys = (e: KeyboardEvent<HTMLSpanElement>) => {
    const by = (e.shiftKey ? 10 : 1) * step;
    const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? value + by : e.key === "ArrowLeft" || e.key === "ArrowDown" ? value - by : e.key === "Home" ? min : e.key === "End" ? max : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const v = snap(next);
    if (v === value) return;
    onChange(v);
    onCommit?.(v);
  };

  return (
    <span className={cx("flex min-w-0 items-center gap-3", off && "opacity-55", className)}>
      <span
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        aria-valuetext={said}
        onKeyDown={onKeys}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          move(valueAt(e));
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) move(valueAt(e));
        }}
        onPointerUp={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          setDrag(null);
          onCommit?.(last.current);
        }}
        onPointerCancel={() => setDrag(null)}
        className="group/slider relative flex h-[22px] min-w-[60px] grow cursor-pointer touch-none items-center outline-none"
      >
        <span aria-hidden className={cx("absolute inset-x-0 rounded-full transition-[height,background-color]", drag !== null ? "h-1.5 bg-ink-3" : "h-1 bg-line-strong group-hover/slider:h-1.5 group-hover/slider:bg-ink-3")} />
        <span aria-hidden style={{ left: `${from}%`, width: `${to - from}%` }} className={cx("absolute rounded-full", drag !== null ? "h-1.5" : "h-1 group-hover/slider:h-1.5", off ? "bg-ink-3" : "bg-accent")} />
        {mark !== undefined && mark !== shown && (
          <span
            aria-hidden
            data-tip={`Default: ${format ? format(mark) : mark}`}
            onPointerDown={(e) => {
              // the notch is the way back to the default
              e.stopPropagation();
              onChange(mark);
              onCommit?.(mark);
            }}
            style={{ left: `${at(mark)}%` }}
            className="absolute -ml-[1px] h-3 w-0.5 cursor-pointer rounded-full bg-ink-2"
          />
        )}
        <span
          aria-hidden
          style={{ left: `${at(shown)}%` }}
          className={cx(
            "pointer-events-none absolute rounded-full shadow-[0_0_0_3px_var(--color-panel)] transition-[width,height,margin] group-focus-visible/slider:shadow-[0_0_0_3px_var(--color-panel),0_0_0_5px_var(--color-accent)]",
            drag !== null ? "-ml-[9px] h-[18px] w-[18px]" : "-ml-[7px] h-3.5 w-3.5 group-hover/slider:-ml-2 group-hover/slider:h-4 group-hover/slider:w-4",
            off ? "bg-ink-3" : "bg-ink",
          )}
        />
        {drag !== null && (
          <span aria-hidden style={{ left: `${at(shown)}%` }} className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-md bg-ink px-1.5 py-px font-mono text-meta font-medium whitespace-nowrap text-ground">
            {said}
          </span>
        )}
      </span>
      {box && <NumberBox value={value} min={min} max={max} step={step} unit={unit} label={label} onCommit={(v) => { onChange(v); onCommit?.(v); }} />}
    </span>
  );
}
