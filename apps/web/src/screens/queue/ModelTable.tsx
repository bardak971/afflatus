import type { TimesSummary } from "../../api";
import { pace, took, long, brief } from "../../format";
import { cx, SectionTitle } from "../../ui";
import { TimeChart } from "./Chart";
import { PHASES, PhaseBar } from "./phases";
import { pct } from "./SummaryTiles";

const columns = "grid-cols-[minmax(0,1.6fr)_70px_100px_100px_80px_100px_minmax(0,1fr)_110px]";

/** The last renders of a model as a small line: is it getting slower? */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-ink-3">—</span>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 96 + 2},${22 - ((v - min) / (max - min || 1)) * 18}`).join(" ");
  return (
    <svg width="100" height="26" viewBox="0 0 100 26" className="text-accent" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** What each model usually takes and where its time goes; a click opens one, closer. */
export function ModelTable({ d, model, onModel, timeLabel, stretch }: { d: TimesSummary; model: string | null; onModel(key: string | null): void; timeLabel(time: number, full?: boolean): string; stretch: string }) {
  const t = d.tiles;
  const picked = d.models.find((m) => m.key === model);
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>By model · click one for details</SectionTitle>
      <div className="overflow-hidden rounded-xl border border-line">
        <div className={cx("grid items-center gap-3 border-b border-line bg-panel px-4 py-2 text-xs text-ink-2", columns)}>
          <span>Model</span><span className="text-right">Renders</span><span className="text-right">Median</span><span className="text-right">p90</span><span className="text-right">s/it</span><span className="text-right">Model load</span><span>Share of GPU time</span><span>Trend</span>
        </div>
        {d.models.map((m) => (
          <div key={m.key}>
            <button type="button" onClick={() => onModel(m.key === model ? null : m.key)} className={cx("grid w-full items-center gap-3 border-b border-line px-4 py-2 text-left hover:bg-raised", columns, m.key === model && "bg-accent-wash")}>
              <span className="truncate font-medium">{m.name}</span>
              <span className="text-right font-mono">{m.renders}</span>
              <span className="text-right font-mono">{m.usualMs === null ? "—" : took(m.usualMs)}</span>
              <span className="text-right font-mono text-ink-2">{m.slowMs === null ? "—" : took(m.slowMs)}</span>
              <span className="text-right font-mono">{pace(m.stepMs)}</span>
              <span className="text-right font-mono text-ink-2">{m.loadMs ? took(m.loadMs) : "—"}</span>
              <span className="flex items-center gap-2">
                <span className="h-1.5 grow overflow-hidden rounded-full bg-line"><span className="block h-full bg-accent" style={{ width: `${(m.gpuMs / Math.max(1, t.gpuMs)) * 100}%` }} /></span>
                <span className="w-9 text-right font-mono text-xs text-ink-2">{pct(m.gpuMs / Math.max(1, t.gpuMs))}</span>
              </span>
              <Spark values={m.trend} />
            </button>
            {picked && m.key === model && <ModelDetail model={m} times={d.times} timeLabel={timeLabel} stretch={stretch} />}
          </div>
        ))}
      </div>
      <span className="text-xs text-ink-3">Median: the middle render time with the model already loaded (warm): half were faster, half slower. p90: the time 90 % of renders stay under; the slowest 10 % are above it. s/it: seconds per step, as ComfyUI shows it.</span>
    </section>
  );
}

/** One model, closer: its render time and its speed over time, where its time goes, and what the button will say. */
function ModelDetail({ model: m, times, timeLabel, stretch }: { model: TimesSummary["models"][number]; times: number[]; timeLabel(time: number, full?: boolean): string; stretch: string }) {
  const s = m.setting;
  return (
    <div className="grid grid-cols-1 gap-3 border-b border-line bg-ground px-4 py-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(300px,0.8fr)]">
      <TimeChart
        title={`${m.name}: render time`} note={`per ${stretch}`} times={times} timeLabel={timeLabel} format={long} axisFormat={brief}
        series={[
          { name: "Median, warm (model already loaded)", values: m.usual },
          { name: "p90 (the slowest 10 % are above)", values: m.slow, color: "var(--color-warn)" },
          { name: "Cold start (model loaded first)", values: m.cold, color: "var(--color-ink-3)" },
        ]}
      />
      <TimeChart
        title="Seconds per step (s/it)" note="by model file: is one of them slower, or getting slower?" times={times} timeLabel={timeLabel} format={(v) => `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`}
        series={m.files.map((f) => ({ name: f.name, values: f.step }))}
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SectionTitle>Time by phase (warm)</SectionTitle>
          <PhaseBar phases={m.phases} className="!h-3.5" />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
            {PHASES.filter((p) => m.phases[p.id] > 500).map((p) => (
              <span key={p.id} className="flex items-center gap-1.5"><span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />{p.label} <span className="font-mono text-ink">{took(m.phases[p.id])}</span></span>
            ))}
          </div>
        </div>
        {s && (
          <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel px-3.5 py-3">
            <SectionTitle>Estimate on the Generate button</SectionTitle>
            <span className="text-xs text-ink-2">
              For {[s.width && s.height ? `${s.width} × ${s.height}` : "", s.seconds ? `${s.seconds} s` : "", `${s.steps} step${s.steps === 1 ? "" : "s"}`].filter(Boolean).join(", ")}, the most used parameters ({s.samples} render{s.samples === 1 ? "" : "s"}):
            </span>
            <div className="flex items-baseline justify-between"><span>Warm (model already loaded)</span><span className="font-mono text-[15px]">about {took(s.warmMs)}</span></div>
            <div className="flex items-baseline justify-between"><span>Cold start (model load first)</span><span className="font-mono text-[15px]">about {took(s.warmMs + s.loadMs)}</span></div>
            <span className="text-xs text-ink-3">
              {[
                s.stepMs === null ? `sampling ${took(s.sampleMs)}` : `sampling ${took(s.sampleMs)} at ${pace(s.stepMs)} s/it`,
                s.refineMs > 500 ? `refine/upscale ${took(s.refineMs)}` : "",
                `VAE decode and encoding ${took(s.finishMs)}`,
                s.loadMs ? `model load ${took(s.loadMs)} on a cold start` : "",
              ].filter(Boolean).join(" + ")}. Other parameters are scaled from the model's median, per second of video when it is one.
            </span>
          </div>
        )}
        {m.files.length > 1 && (
          <div className="flex flex-col gap-1 text-xs">
            <SectionTitle>By model file</SectionTitle>
            {m.files.map((f) => (
              <div key={f.file} className="flex items-baseline justify-between gap-3"><span className="truncate text-ink-2" data-tip={f.name}>{f.name}</span><span className="shrink-0 font-mono">{f.renders} render{f.renders === 1 ? "" : "s"} · {pace(f.stepMs)} s/it</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
