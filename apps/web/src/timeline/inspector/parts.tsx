import { useEffect, useState } from "react";
import { Slider } from "../../Slider";
import { CloseButton as KitClose, cx } from "../../ui";

/** A slider that says its value while it moves and saves it when it is let go; `disabled`, greyed and not moved (a change under way). */
export function Slide({ label, value, min = 0, max, step = 1, show, onCommit, disabled = false }: { label: string; value: number; min?: number; max: number; step?: number; show(value: number): string; onCommit(value: number): void; disabled?: boolean }) {
  const [local, setLocal] = useState<number | null>(null);
  // the value let go on, shown until it is back as `value` or the change it started is over (`disabled` ends): let go,
  // the slider sprang back to the old value until the read back, as if the change had not been taken
  const [held, setHeld] = useState<number | null>(null);
  useEffect(() => {
    if (held !== null && (held === value || !disabled)) setHeld(null);
  }, [held, value, disabled]);
  const shown = local ?? held ?? value;
  const commit = (v: number) => {
    if (v !== value && !disabled) {
      onCommit(v);
      setHeld(v);
    }
    setLocal(null);
  };
  return (
    <div className={cx("flex flex-col gap-1", disabled && "pointer-events-none")} aria-disabled={disabled || undefined}>
      <span className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className="font-mono text-ink-2">{show(shown)}</span>
      </span>
      <Slider box={false} label={label} min={min} max={max} step={step} value={shown} format={show} off={disabled} onChange={(v) => !disabled && setLocal(v)} onCommit={commit} />
    </div>
  );
}

/** The panel's way back to the timeline's own panel, at the right of its head: the same as Escape. */
export function CloseButton({ onClose }: { onClose(): void }) {
  return <KitClose size={28} keys="Esc" onClose={onClose} />;
}
