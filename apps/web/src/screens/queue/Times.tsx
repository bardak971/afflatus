import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Clapperboard, Image as ImageIcon, X } from "lucide-react";
import { api, thumbUrl, type TimeParts, type TimesPeriod, type TimesSummary } from "../../api";
import { useRenderTimes } from "../../data";
import { took, when } from "../../format";
import { Button, cx, Empty, ErrorNote, SectionTitle, Segmented } from "../../ui";
import { TimeChart, useChartColors } from "./Chart";

/**
 * How long renders took: totals for a period, panels over time, what each model usually takes and where
 * its time goes, and the renders one by one with their time split by phase. Read from the record the
 * server keeps of every render (apps/server/src/renders.ts).
 */

const PERIODS: Array<{ value: TimesPeriod; label: string }> = [
  { value: "day", label: "24 hours" },
  { value: "week", label: "7 days" },
  { value: "month", label: "30 days" },
  { value: "all", label: "All time" },
];
const PHASES: Array<{ id: keyof TimeParts; label: string; tone: string; color: string }> = [
  { id: "loading", label: "Model load", tone: "bg-ink-3", color: "var(--color-ink-3)" },
  { id: "sampling", label: "Sampling", tone: "bg-accent", color: "var(--color-accent)" },
  { id: "refining", label: "Refine pass / hires fix", tone: "bg-picture", color: "var(--color-picture)" },
  { id: "finishing", label: "VAE decode, interpolation, encoding", tone: "bg-good", color: "var(--color-good)" },
];
const DAY = 86_400_000;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** "6 h 12 min", "48 min", "42 s". */
const long = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return ms < 90_000 ? took(ms) : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
};
const maybe = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : long(ms));
const pct = (share: number) => `${Math.round(share * 100)} %`;
/** The same as `long`, short enough for the scale of a chart: "42s", "3m 05s", "1h 05m". */
const brief = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s / 60}m`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};
/** Seconds per step, as ComfyUI says it. */
const pace = (stepMs: number | null) => (stepMs === null ? "—" : (stepMs / 1000).toFixed(stepMs < 10_000 ? 2 : 1));

function Tile({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[10px] border border-line bg-panel px-3.5 py-3">
      <span className="truncate text-xs text-ink-2">{label}</span>
      <span className={cx("truncate font-mono text-[19px] leading-tight", warn && "text-warn-ink")}>{value}</span>
      {note && <span className="truncate text-xs text-ink-3">{note}</span>}
    </div>
  );
}

/** One render's time, or a sum of them, as a bar split by phase. */
function PhaseBar({ phases, scale = 1, className }: { phases: TimeParts; scale?: number; className?: string }) {
  const total = Math.max(1, sum(PHASES.map((p) => phases[p.id])));
  return (
    <div className={cx("flex h-2.5 overflow-hidden rounded-full bg-line", className)} style={{ width: `${Math.max(4, Math.min(1, scale) * 100)}%` }}>
      {PHASES.map((p) => phases[p.id] > 0 && <div key={p.id} className={p.tone} title={`${p.label}: ${took(phases[p.id])}`} style={{ width: `${(phases[p.id] / total) * 100}%` }} />)}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {PHASES.map((p) => (
        <span key={p.id} className="flex items-center gap-1.5"><span className={cx("h-2.5 w-2.5 rounded-sm", p.tone)} />{p.label}</span>
      ))}
    </div>
  );
}

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

export function RenderTimes() {
  const [period, setPeriod] = useState<TimesPeriod>("week");
  const [model, setModel] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "trouble">("all");
  const tones = useChartColors();
  const times = useRenderTimes(period);
  const renders = useInfiniteQuery({
    // under "assets": read again when a render ends
    queryKey: ["assets", "renders", model, only],
    queryFn: ({ pageParam }) => api.renders({ recipe: model ?? undefined, trouble: only === "trouble", before: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.more ? last.items.at(-1)?.at : undefined),
  });
  const d = times.data;
  if (times.isError) return <ErrorNote>{times.error.message}</ErrorNote>;
  if (!d) return <div className="text-ink-2">Loading render history…</div>;

  const t = d.tiles;
  const anything = t.done + t.failed + t.cancelled > 0;
  const stretch = d.step < DAY ? (period === "day" ? "hour" : "6 hours") : "day";
  const timeLabel = (time: number, full?: boolean) =>
    new Date(time).toLocaleString(undefined, d.step < DAY ? (full ? { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : period === "day" ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit" }) : { day: "numeric", month: "short" });
  const picked = d.models.find((m) => m.key === model);
  const listed = renders.data?.pages.flatMap((p) => p.items) ?? [];
  const longest = Math.max(1, ...listed.map((r) => r.totalMs));
  const chart = { times: d.times, timeLabel };
  const columns = "grid-cols-[minmax(0,1.6fr)_70px_100px_100px_80px_100px_minmax(0,1fr)_110px]";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-[340px]"><Segmented<TimesPeriod> label="Period" value={period} options={PERIODS} onChange={setPeriod} /></div>
        {d.since && <span className="text-xs text-ink-3">History since {new Date(d.since).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}.</span>}
      </div>

      {!d.since && (
        <Empty title="No render history yet">
          From now on every render is timed here: total time, time per phase (model load, sampling, VAE decode), and GPU load. The estimates on the buttons are made from it. Earlier renders only have their total, and are not shown.
        </Empty>
      )}

      {d.since && (
        <>
          <div className="grid grid-cols-4 gap-2.5 xl:grid-cols-6">
            <Tile label="Renders" value={String(t.done)} note={`${t.images} image${t.images === 1 ? "" : "s"} · ${t.videos} video${t.videos === 1 ? "" : "s"}`} />
            <Tile label="Video generated" value={long(t.videoMs)} note="total duration of all clips" />
            <Tile label="Failed · cancelled" value={`${t.failed} · ${t.cancelled}`} note={`${long(t.lostMs)} of GPU time lost`} warn={t.failed > 0} />
            <Tile label="GPU time" value={long(t.gpuMs)} note={`longest render: ${long(t.longestMs)}`} />
            <Tile label="GPU busy" value={pct(t.gpuMs / Math.max(1, d.spanMs))} note="of the period, with studai's renders" />
            <Tile label="Queue wait" value={maybe(t.waitedUsualMs)} note={`median · p90: ${maybe(t.waitedSlowMs)}`} />
            <Tile label="Model load" value={pct(t.loadMs / Math.max(1, t.gpuMs))} note={`${long(t.loadMs)} of the GPU time`} />
            <Tile label="Model loads" value={`${t.loads} time${t.loads === 1 ? "" : "s"}`} note={t.loadUsualMs === null ? undefined : `${long(t.loadUsualMs)} each, median`} />
            <Tile label="Estimate error" value={t.off === null ? "—" : `± ${pct(t.off)}`} note="how far off the estimates usually are" />
            <Tile label="Most used" value={d.models[0]?.name.split(" · ")[0] ?? "—"} note={d.models[0] ? `${pct(d.models[0].gpuMs / Math.max(1, t.gpuMs))} of the GPU time` : undefined} />
            <Tile label="Peak VRAM" value={t.vramPeak === null ? "—" : `${Math.round(t.vramPeak)} %`} note={t.vramUsual === null ? "not reported" : `median ${Math.round(t.vramUsual)} %`} />
            <Tile label="Peak GPU temp" value={t.heatPeak === null ? "—" : `${Math.round(t.heatPeak)}°`} note={t.heatUsual === null ? "not reported" : `median ${Math.round(t.heatUsual)}°`} warn={(t.heatPeak ?? 0) >= 80} />
          </div>

          {!anything && <div className="rounded-xl border border-line px-4 py-5 text-ink-2">No renders in this period.</div>}

          {anything && (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <TimeChart
                {...chart} title="Render time by model" note={`median per ${stretch} · click a name to isolate it`} format={long} axisFormat={brief}
                series={d.models.map((m) => ({ name: m.name, values: m.usual }))}
              />
              <TimeChart
                {...chart} title="Speed vs. the model's median" note="seconds per step (s/it) against the model's own median: 100 % is as usual" format={(v) => `${Math.round(v)} %`} bottom={50} fill={false}
                series={[...d.models.map((m) => ({ name: m.name, values: m.pace })), { name: "as usual", values: d.times.map(() => 100), color: "var(--color-ink-3)", dashed: true }]}
              />
              <TimeChart
                {...chart} title="Finished" note={`per ${stretch}`} format={(v) => String(Math.round(v))} stacked stat="sum"
                series={[
                  { name: "Images", values: d.finished.images, color: "var(--color-picture)" },
                  { name: "Videos", values: d.finished.videos, color: tones[0] },
                  { name: "Failed or cancelled", values: d.finished.bad, color: "var(--color-warn)" },
                ]}
              />
              <TimeChart
                {...chart} title="GPU time by phase" note={`per ${stretch}`} format={long} axisFormat={brief} stacked stat="sum"
                series={PHASES.map((p) => ({ name: p.label, values: d.phases[p.id], color: p.id === "sampling" ? tones[0] : p.color }))}
              />
              <TimeChart
                {...chart} title="Queue wait" note="from Generate to the render starting" format={long} axisFormat={brief}
                series={[
                  { name: "Median", values: d.wait.usual, color: tones[0] },
                  { name: "p90 (the slowest 10 % are above)", values: d.wait.slow, color: "var(--color-warn)" },
                ]}
              />
              <TimeChart
                {...chart} title="VRAM and GPU temperature" note={`peak per ${stretch}`} format={(v) => String(Math.round(v))} top={100} bottom={40} stat="max"
                series={[
                  { name: "VRAM, %", values: d.gpu.vram, color: "var(--color-picture)" },
                  { name: "Temperature, °C", values: d.gpu.heat, color: "var(--color-warn)" },
                ]}
              />
            </div>
          )}

          {d.models.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionTitle>By model · click one for details</SectionTitle>
              <div className="overflow-hidden rounded-xl border border-line">
                <div className={cx("grid items-center gap-3 border-b border-line bg-panel px-4 py-2 text-xs text-ink-2", columns)}>
                  <span>Model</span><span className="text-right">Renders</span><span className="text-right">Median</span><span className="text-right">p90</span><span className="text-right">s/it</span><span className="text-right">Model load</span><span>Share of GPU time</span><span>Trend</span>
                </div>
                {d.models.map((m) => (
                  <div key={m.key}>
                    <button type="button" onClick={() => setModel(m.key === model ? null : m.key)} className={cx("grid w-full items-center gap-3 border-b border-line px-4 py-2 text-left hover:bg-raised", columns, m.key === model && "bg-accent-wash")}>
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
          )}

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <SectionTitle>{d.keepDays ? `Renders, last ${d.keepDays} days` : "Renders"} · {renders.data?.pages[0]?.total ?? 0}</SectionTitle>
              {picked && (
                <button type="button" onClick={() => setModel(null)} className="flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-0.5 text-xs hover:bg-hover">
                  Only {picked.name} <X size={12} />
                </button>
              )}
              <div className="w-56"><Segmented<"all" | "trouble"> label="Filter" value={only} options={[{ value: "all", label: "All" }, { value: "trouble", label: "Failed or cancelled" }]} onChange={setOnly} /></div>
              <div className="grow" />
              <Legend />
            </div>
            {renders.isError && <ErrorNote>{renders.error.message}</ErrorNote>}
            <div className="flex flex-col gap-1.5">
              {listed.map((r) => (
                <div key={r.id} className="grid grid-cols-[44px_minmax(0,1.2fr)_minmax(0,2fr)_150px_120px] items-center gap-4 rounded-[10px] border border-line bg-panel px-3 py-2">
                  {r.assetId
                    ? <img src={thumbUrl(r.assetId)} alt="" loading="lazy" className="h-11 w-11 rounded-md object-cover" />
                    : <div className="flex h-11 w-11 items-center justify-center rounded-md bg-raised text-ink-3" title={r.status === "done" ? "Its output is no longer in the library" : "No output"}>{r.kind === "video" ? <Clapperboard size={16} /> : <ImageIcon size={16} />}</div>}
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{r.name}</span>
                    <span className="truncate text-xs text-ink-2" title={r.model}>
                      {[r.model, r.width && r.height ? `${r.width} × ${r.height}` : "", r.seconds ? `${r.seconds} s` : "", `${r.steps} step${r.steps === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <PhaseBar phases={r.phases} scale={r.totalMs / longest} />
                    <span className="truncate text-xs text-ink-3">
                      {[
                        !r.whole ? "studai started while it was rendering: only its total is known" : r.cold ? `cold start, model load ${took(r.phases.loading)}` : "warm (model already loaded)",
                        r.stepMs === null ? "" : `${pace(r.stepMs)} s/it`,
                        r.waitedMs > 1000 ? `queued ${long(r.waitedMs)}` : "",
                      ].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className={cx("font-mono text-[15px]", r.status !== "done" && "text-warn-ink")}>{r.status === "done" ? took(r.totalMs) : r.status === "failed" ? "Failed" : "Cancelled"}</span>
                    <span className="text-xs text-ink-3">{r.status !== "done" ? `after ${took(r.totalMs)}` : r.expectedMs ? `estimated ${took(r.expectedMs)}` : "no estimate"}</span>
                  </div>
                  <div className="flex flex-col items-end text-xs text-ink-2">
                    <span>{when(r.at)}</span>
                    <span className="font-mono text-ink-3">{[r.vram === null ? "" : `${Math.round(r.vram)} %`, r.heat === null ? "" : `${Math.round(r.heat)}°`].filter(Boolean).join(" · ")}</span>
                  </div>
                </div>
              ))}
              {renders.isSuccess && !listed.length && <div className="rounded-xl border border-line px-4 py-5 text-ink-2">No renders.</div>}
              {renders.hasNextPage && <div><Button size="sm" onClick={() => renders.fetchNextPage()} disabled={renders.isFetchingNextPage}>More</Button></div>}
              <span className="text-xs text-ink-3">
                {d.keepDays
                  ? `Individual renders are kept for ${d.keepDays} days (a setting in Settings). Older ones are folded into the daily aggregates the charts above are drawn from, which are kept for good.`
                  : "Every individual render is kept for good (a setting in Settings)."}
              </span>
            </div>
          </section>
        </>
      )}
    </div>
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
                s.refineMs > 500 ? `refine pass ${took(s.refineMs)}` : "",
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
              <div key={f.file} className="flex items-baseline justify-between gap-3"><span className="truncate text-ink-2" title={f.name}>{f.name}</span><span className="shrink-0 font-mono">{f.renders} render{f.renders === 1 ? "" : "s"} · {pace(f.stepMs)} s/it</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
