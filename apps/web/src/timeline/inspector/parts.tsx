import { useState } from "react";
import { Slider } from "../../Slider";
import { CloseButton as KitClose } from "../../ui";

/** A slider that says its value while it moves and saves it when it is let go. */
export function Slide({ label, value, min = 0, max, step = 1, show, onCommit }: { label: string; value: number; min?: number; max: number; step?: number; show(value: number): string; onCommit(value: number): void }) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const commit = (v: number) => {
    if (v !== value) onCommit(v);
    setLocal(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className="font-mono text-ink-2">{show(shown)}</span>
      </span>
      <Slider box={false} label={label} min={min} max={max} step={step} value={shown} format={show} onChange={setLocal} onCommit={commit} />
    </div>
  );
}

/** The panel's way back to the timeline's own panel, at the right of its head: the same as Escape. */
export function CloseButton({ onClose }: { onClose(): void }) {
  return <KitClose size={28} keys="Esc" onClose={onClose} />;
}
