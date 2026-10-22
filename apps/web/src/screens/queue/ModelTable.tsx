import type { TimesSummary } from "../../api";
import { pace, took, long, brief, dayMonth } from "../../format";
import { CloseButton, cx, Help } from "../../ui";
import { TimeChart } from "./Chart";
import { paceDrift, SLOW } from "./flagRules";
import { PHASES, PhaseBar } from "./phases";
import { pct } from "./SummaryTiles";

type Model = TimesSummary["models"][number];

const columns = "grid-cols-[minmax(0,1.3fr)_minmax(60px,1fr)_88px_48px_78px_40px]";
const head = "text-meta font-bold tracking-label text-ink-3 uppercase";

/** A model's colour: its place in the list, round the palette, as the charts and the lanes colour it. */
export const modelColor = (index: number, palette: string[]) => palette[index % palette.length] ?? "currentColor";

/** A signed percentage, with a real minus: "+18 %", "−4 %". */
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} %`;

/** Which models the GPU went to: share, p50, jobs, pace against their own p50, failures. A click picks one: the charts look at it alone and its detail opens. */
export function ModelList({ d, model, onModel, palette }: { d: TimesSummary; model: string | null; onModel(key: string | null): void; palette: string[] }) {
  const gpu = Math.max(1, d.tiles.gpuMs);
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      <div className="flex items-center gap-2 px-4.5 pt-3.5 pb-2">
        <span className={head}>Models</span>
        <Help text="p50: the middle render time, model already loaded (warm). p90: 9 in 10 renders are faster. s/it: seconds per step, as ComfyUI says it. s/it vs p50: the pace lately against the model's own p50 over the window." />
        <span className="grow" />
        <span className="text-xs text-ink-3">click: filter the charts</span>
      </div>
      <div className={cx("grid items-center gap-3.5 px-4.5 pb-1 text-micro font-semibold text-ink-3", columns)}>
        <span /><span>GPU share</span><span className="text-right">p50</span><span className="text-right">jobs</span><span className="text-right">s/it vs p50</span><span className="text-right">fail</span>
      </div>
      {d.models.map((m, i) => {
        const drift = paceDrift(m.pace, d.times);
        const share = m.gpuMs / gpu;
        const on = m.key === model;
        return (
          <button
            key={m.key} type="button" aria-pressed={on} onClick={() => onModel(on ? null : m.key)}
            className={cx("grid w-full items-center gap-3.5 border-t border-line px-4.5 py-2 text-left text-body hover:bg-raised", columns, on && "bg-accent-wash")}
          >
            <span className="flex min-w-0 items-center gap-2" data-tip={m.name}>
              <span className="size-3 shrink-0 rounded-key" style={{ background: modelColor(i, palette) }} />
              <span className="truncate">{m.name}</span>
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-line" data-tip={`${pct(share)} of the GPU time · ${long(m.gpuMs)}`}>
              <span className="block h-full rounded-full" style={{ width: `${share * 100}%`, background: modelColor(i, palette) }} />
            </span>
            <span className="text-right font-mono whitespace-nowrap" data-tip={`p90 ${m.slowMs === null ? "—" : took(m.slowMs)}`}>{m.usualMs === null ? "—" : took(m.usualMs)}</span>
            <span className="text-right font-mono">{m.renders}</span>
            <span
              className={cx("text-right font-mono", drift && drift.pct >= SLOW && "text-warn-ink")}
              data-tip={drift ? `${pace(m.stepMs)} s/it p50${drift.since === null ? "" : ` · slower since ${dayMonth(drift.since)}`}` : "no s/it measured"}
            >
              {drift ? signed(drift.pct) : "—"}
            </span>
            <span className={cx("text-right font-mono", !m.failed && "text-ink-3")} data-tip={m.failed ? `${m.failed} failed${m.oom ? ` · ${m.oom} OOM` : ""} · ${m.cancelled ?? 0} cancelled · ${long(m.lostMs ?? 0)} GPU lost` : undefined}>{m.failed ?? "—"}</span>
          </button>
        );
      })}
    </section>
  );
}

/** One model, closer: its render time and its s/it over time, where its time goes, and what the Generate button will say. */
export function ModelDetail({ model: m, color, times, timeLabel, stretch, onClose }: { model: Model; color: string; times: number[]; timeLabel(time: number, full?: boolean): string; stretch: string; onClose(): void }) {
  const s = m.setting;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-2 text-body font-semibold"><span className="size-3 rounded-key" style={{ background: color }} />{m.name}</span>
        <span className="font-mono text-xs text-ink-2">
          {[
            `p50 ${m.usualMs === null ? "—" : took(m.usualMs)}`, `p90 ${m.slowMs === null ? "—" : took(m.slowMs)}`, `${pace(m.stepMs)} s/it`,
            m.loadMs ? `load ${took(m.loadMs)}${m.loads ? ` × ${m.loads}` : ""}` : "", `${m.renders} jobs`,
          ].filter(Boolean).join(" · ")}
        </span>
        <span className="grow" />
        <CloseButton size={28} tip="Close · show every model" onClose={onClose} />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(300px,0.8fr)]">
        <TimeChart
          title="Render time" note={`per ${stretch}`} times={times} timeLabel={timeLabel} format={long} axisFormat={brief}
          series={[
            { name: "p50 warm", values: m.usual, color, tip: "Middle render time, model already loaded" },
            { name: "p90", values: m.slow, color: "var(--color-warn)", dashed: true, tip: "9 in 10 renders are faster" },
            { name: "p50 cold", values: m.cold, color: "var(--color-ink-3)", tip: "Middle render time when the model loaded first" },
          ]}
        />
        <TimeChart
          title="s/it by model file" note={`per ${stretch}`} times={times} timeLabel={timeLabel} format={(v) => `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`}
          series={m.files.map((f) => ({ name: f.name, values: f.step }))}
        />
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className={head}>Phases · warm</span>
            <PhaseBar phases={m.phases} className="!h-3.5" />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
              {PHASES.filter((p) => m.phases[p.id] > 500).map((p) => (
                <span key={p.id} className="flex items-center gap-1.5" data-tip={p.tip}><span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />{p.label} <span className="font-mono text-ink">{took(m.phases[p.id])}</span></span>
              ))}
            </div>
          </div>
          {s && (
            <div className="flex flex-col gap-1.5 rounded-control border border-line bg-raised/40 px-3.5 py-3">
              <span className="flex items-center gap-2">
                <span className={head}>ETA on Render</span>
                <Help text="For the setting used most. Other settings are scaled from the model's p50, per second of video for a video." />
              </span>
              <span className="font-mono text-xs text-ink-2">
                {[s.width && s.height ? `${s.width}×${s.height}` : "", s.seconds ? `${s.seconds} s` : "", `${s.steps} steps`, `most used (${s.samples})`].filter(Boolean).join(" · ")}
              </span>
              <div className="flex items-baseline justify-between"><span>warm</span><span className="font-mono text-title">{took(s.warmMs)}</span></div>
              <div className="flex items-baseline justify-between"><span>cold</span><span className="font-mono text-title">{took(s.warmMs + s.loadMs)}</span></div>
              <span className="font-mono text-xs text-ink-3">
                {[
                  s.stepMs === null ? `sampling ${took(s.sampleMs)}` : `sampling ${took(s.sampleMs)} @ ${pace(s.stepMs)} s/it`,
                  s.refineMs > 500 ? `refine/upscale ${took(s.refineMs)}` : "",
                  `VAE decode/encode ${took(s.finishMs)}`,
                  s.loadMs ? `+ load ${took(s.loadMs)} cold` : "",
                ].filter(Boolean).join(" · ")}
              </span>
            </div>
          )}
          {m.files.length > 1 && (
            <div className="flex flex-col gap-1 text-xs">
              <span className={head}>By model file</span>
              {m.files.map((f) => (
                <div key={f.file} className="flex items-baseline justify-between gap-3"><span className="truncate text-ink-2" data-tip={f.name}>{f.name}</span><span className="shrink-0 font-mono">{f.renders} jobs · {pace(f.stepMs)} s/it</span></div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
