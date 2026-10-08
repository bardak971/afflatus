import type { SystemLoad } from "../../api";
import { useSystem } from "../../store";
import { Bar, cx, SectionTitle } from "../../ui";

/** The numbers of the machine ComfyUI runs on. Shows what is known: a meter with no source is left out. */
export function meters(load: SystemLoad | null): Array<{ label: string; value: string; percent: number; hot: boolean }> {
  if (!load) return [];
  const out: Array<{ label: string; value: string; percent: number; hot: boolean }> = [];
  const pct = (label: string, v: number | undefined) => v !== undefined && out.push({ label, value: `${Math.round(v)}%`, percent: v, hot: false });
  pct("CPU", load.cpu);
  pct("RAM", load.ram?.percent);
  pct("Disk", load.disks[0]?.percent);
  const gpu = load.gpus[0];
  if (gpu) {
    pct("GPU", gpu.load);
    pct("VRAM", gpu.vramPercent);
    // a GPU is built to run warm; past 80° it is worth a glance (a temperature, the same for every card, not a figure of one card)
    if (gpu.temperature !== undefined) out.push({ label: "GPU temp", value: `${Math.round(gpu.temperature)}°`, percent: gpu.temperature, hot: gpu.temperature >= 80 });
  }
  return out;
}

/** The machine's meters, small, under the queue: the footer has the ones that matter at every moment. */
export function MachineMeters() {
  const m = meters(useSystem((s) => s.load));
  if (!m.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Machine</SectionTitle>
      <div className="grid grid-cols-3 gap-1.5">
        {m.map((x) => (
          <div key={x.label} className="flex flex-col gap-1 rounded-[8px] border border-line bg-panel px-2 py-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-ink-2">{x.label}</span>
              <span className={cx("font-mono text-xs", x.hot && "text-warn-ink")}>{x.value}</span>
            </div>
            <Bar value={x.percent} tone={x.hot ? "warn" : "picture"} />
          </div>
        ))}
      </div>
    </section>
  );
}
