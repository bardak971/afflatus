import type { TimeParts } from "../../api";
import { took } from "../../format";
import { cx } from "../../ui";

/** The parts of a render's time, each with its colour: as a class (the bars) and as a colour (the charts); `tip` says what is in it. */
export const PHASES: Array<{ id: keyof TimeParts; label: string; tip: string; tone: string; color: string }> = [
  { id: "loading", label: "model load", tip: "Loading the checkpoint, text encoders and VAE into VRAM", tone: "bg-ink-3", color: "var(--color-ink-3)" },
  { id: "sampling", label: "sampling", tip: "The main sampling pass", tone: "bg-accent", color: "var(--color-accent)" },
  { id: "refining", label: "refine/upscale", tip: "Refine and upscale passes: hires fix, upscale, SeedVR2, detailer", tone: "bg-picture", color: "var(--color-picture)" },
  { id: "finishing", label: "VAE decode/encode", tip: "VAE decode, frame interpolation, video encoding, saving", tone: "bg-good", color: "var(--color-good)" },
];

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** One render's time, or a sum of them, as a bar split by phase. */
export function PhaseBar({ phases, scale = 1, className }: { phases: TimeParts; scale?: number; className?: string }) {
  const total = Math.max(1, sum(PHASES.map((p) => phases[p.id])));
  return (
    <div className={cx("flex h-2.5 overflow-hidden rounded-full bg-line", className)} style={{ width: `${Math.max(4, Math.min(1, scale) * 100)}%` }}>
      {PHASES.map((p) => phases[p.id] > 0 && <div key={p.id} className={p.tone} data-tip={`${p.label}: ${took(phases[p.id])}`} style={{ width: `${(phases[p.id] / total) * 100}%` }} />)}
    </div>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {PHASES.map((p) => (
        <span key={p.id} className="flex items-center gap-1.5" data-tip={p.tip}><span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />{p.label}</span>
      ))}
    </div>
  );
}
