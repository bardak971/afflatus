import { useId, type ReactNode } from "react";
import type { TimesSummary } from "../../api";
import { long } from "../../format";
import { cx } from "../../ui";
import { useChartColors } from "./Chart";
import { bar, curve } from "./chartMath";
import { change, VRAM_FULL } from "./flagRules";

const maybe = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : long(ms));
export const pct = (share: number) => `${Math.round(share * 100)} %`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The window's length, short: "31 d", "24 h", "45 min". */
export function spanSaid(ms: number): string {
  const H = 3_600_000;
  return ms >= 2 * 24 * H ? `${Math.round(ms / (24 * H))} d` : ms >= 2 * H ? `${Math.round(ms / H)} h` : `${Math.round(ms / 60_000)} min`;
}

/** A small curve or bars per stretch under a headline figure; `over`: a second series stacked on the bars (failures). */
function Spark({ values, color, bars, over }: { values: number[]; color: string; bars?: boolean; over?: { values: number[]; color: string } }) {
  const id = useId().replace(/:/g, "");
  const W = 400;
  const H = 56;
  const n = values.length;
  const max = Math.max(1e-9, ...values.map((v, i) => v + (over?.values[i] ?? 0)));
  const y = (v: number) => H - (v / max) * (H - 4);
  if (!n) return <div className="h-14" />;
  if (bars) {
    const band = W / n;
    const w = Math.max(1, band * 0.7);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-14 w-full" aria-hidden>
        <path fill={color} fillOpacity={0.8} d={values.map((v, i) => bar(i * band + (band - w) / 2, w, H, y(v), (over?.values[i] ?? 0) > 0 ? 0 : 2)).join("")} />
        {over && <path fill={over.color} d={over.values.map((v, i) => (v > 0 ? bar(i * band + (band - w) / 2, w, y(values[i]!), y(values[i]! + v), 2) : "")).join("")} />}
      </svg>
    );
  }
  const points = values.map((v, i) => [n > 1 ? (i / (n - 1)) * W : W / 2, y(v)] as [number, number]);
  const line = curve(points);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-14 w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.4} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** One of the three figures that matter: big, a line of what it is made of, its change against the period before, its curve. */
function Headline({ label, value, sub, subTip, delta, deltaTip, children }: { label: string; value: string; sub: string; subTip?: string; delta: number | null; deltaTip?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 overflow-hidden rounded-2xl border border-line bg-panel px-4.5 pt-4 pb-2.5">
      <span className="text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{label}</span>
      <span className="flex items-baseline gap-2.5">
        <span className="truncate font-mono text-[34px] leading-tight font-bold tracking-tight">{value}</span>
        {delta !== null && <span className="shrink-0 font-mono text-xs font-semibold text-ink-2" data-tip={deltaTip}>{delta > 0 ? "▲" : delta < 0 ? "▼" : "="} {Math.abs(delta)} %</span>}
      </span>
      <span className="truncate text-xs text-ink-3" data-tip={subTip}>{sub}</span>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** A figure of the quiet strip: coloured only when it asks for attention. */
function Figure({ label, value, tip, warn }: { label: string; value: string; tip?: string; warn?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-line px-4 py-2.5 [&:not(:first-child)]:border-l" data-tip={tip}>
      <span className="truncate text-[11px] text-ink-3">{label}</span>
      <span className={cx("truncate font-mono text-base font-semibold", warn && "text-warn-ink")}>{value}</span>
    </div>
  );
}

/** The window's totals: GPU time, jobs and video out with their curves and change, then the rest in one strip. */
export function SummaryTiles({ d }: { d: TimesSummary }) {
  const t = d.tiles;
  const tones = useChartColors();
  const prior = d.prior ?? null;
  const vs = prior ? `vs prior ${spanSaid(prior.to - prior.from)}` : "";
  const gpu = d.times.map((_x, i) => d.phases.loading[i]! + d.phases.sampling[i]! + d.phases.refining[i]! + d.phases.finishing[i]!);
  const done = d.times.map((_x, i) => (d.finished.images[i] ?? 0) + (d.finished.videos[i] ?? 0));
  // the GPU time of the video models, against the video they made: what a second of video costs
  const videoGpu = d.models.filter((m) => m.kind === "video").reduce((n, m) => n + m.gpuMs, 0);
  const oom = t.oom ?? 0;
  // the failures that never reached ComfyUI are counted too, so the figures agree with the Queue's list; the tip says how many
  const unsent = (t.unsent?.failed ?? 0) + (t.unsent?.cancelled ?? 0);
  const unsentTip = unsent ? ` · ${t.unsent!.failed} failed and ${t.unsent!.cancelled} cancelled before they reached ComfyUI (no GPU time)` : "";
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
        <Headline
          label="GPU time" value={long(t.gpuMs)}
          sub={`max ${long(t.longestMs)} · GPU busy ${pct(t.gpuMs / Math.max(1, d.spanMs))}`}
          subTip="Longest job · share of the window the GPU spent on Afflatus's jobs (failed and cancelled included)"
          delta={change(t.gpuMs, prior?.gpuMs)} deltaTip={prior ? `${vs}: ${long(prior.gpuMs)}` : undefined}
        >
          <Spark values={gpu} color={tones[0] ?? "var(--color-accent)"} />
        </Headline>
        <Headline
          label="Jobs" value={String(t.done)}
          sub={`${t.images} img · ${t.videos} vid · ${t.failed} failed · ${t.cancelled} cancelled`}
          subTip={`${plural(t.done, "job")} done${t.tools ? `, ${plural(t.tools, "finish or slow-mo", "finishes or slow-mos")} among them` : ""} · failed and cancelled on top of the bars${unsentTip}`}
          delta={change(t.done, prior?.done)} deltaTip={prior ? `${vs}: ${prior.done} done · ${prior.failed} failed · ${prior.cancelled} cancelled` : undefined}
        >
          <Spark values={done} color="var(--color-picture)" bars over={{ values: d.finished.bad, color: "var(--color-warn)" }} />
        </Headline>
        <Headline
          label="Video out" value={t.videoMs ? long(t.videoMs) : "—"}
          sub={t.videoMs ? `${(videoGpu / t.videoMs).toFixed(videoGpu / t.videoMs < 10 ? 1 : 0)} s GPU / s of video` : "no video"}
          subTip="Length of all clips made · GPU time of the video models per second of clip"
          delta={change(t.videoMs, prior?.videoMs)} deltaTip={prior ? `${vs}: ${maybe(prior.videoMs)}` : undefined}
        >
          {/* the length made per stretch; a server from before it was sent has the count of videos instead */}
          <Spark values={d.finished.videoMs ?? d.finished.videos} color="var(--color-good)" />
        </Headline>
      </div>
      <div className="grid grid-cols-4 overflow-hidden rounded-2xl border border-line bg-panel xl:grid-cols-7">
        <Figure label="Model load" value={pct(t.loadMs / Math.max(1, t.gpuMs))} tip={`Of the GPU time: ${long(t.loadMs)} · ${plural(t.loads, "load")}${t.loadUsualMs === null ? "" : ` · p50 ${long(t.loadUsualMs)}`}`} />
        <Figure label="ETA error" value={t.off === null ? "—" : `± ${pct(t.off)}`} tip="How far off the ETAs usually are (p50)" />
        <Figure label="Queue wait p90" value={maybe(t.waitedSlowMs)} tip={`Generate → render start · p50 ${maybe(t.waitedUsualMs)}`} />
        <Figure label="VRAM peak" value={t.vramPeak === null ? "—" : `${Math.round(t.vramPeak)} %`} tip={t.vramUsual === null ? "not reported" : `p50 ${Math.round(t.vramUsual)} %`} warn={(t.vramPeak ?? 0) >= VRAM_FULL} />
        <Figure
          label="OOM" value={String(oom)} warn={oom > 0}
          tip={`Failed out of memory: ${oom} · spills (VRAM full, ≥ 2× the ETA): ${t.spills ?? 0}${t.spills ? `, +${long(t.spillLostMs ?? 0)}, their bars in the warning colour` : ""}`}
        />
        {/* 80 °C: a temperature, the same for every card, not a figure of one card */}
        <Figure label="GPU temp peak" value={t.heatPeak === null ? "—" : `${Math.round(t.heatPeak)}°`} tip={t.heatUsual === null ? "not reported" : `p50 ${Math.round(t.heatUsual)}°`} warn={(t.heatPeak ?? 0) >= 80} />
        <Figure label="Failed · cancelled" value={`${t.failed} · ${t.cancelled}`} tip={`${long(t.lostMs)} GPU time lost${unsentTip}`} />
      </div>
    </div>
  );
}
