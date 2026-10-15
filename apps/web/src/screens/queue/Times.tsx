import { lazy, Suspense, useMemo, useState, type ComponentProps } from "react";
import type { TimesSummary, TopRender } from "../../api";
import { useAsset, useQueue } from "../../data";
import { machineLabel, severalMachines } from "../../machines";
import { Select } from "../../Select";
import { brief, long, plural, took, UI_LOCALE } from "../../format";
import { cx, Empty, ErrorNote, Segmented } from "../../ui";
import { TimeChart, useChartColors } from "./Chart";
import { flagsOf } from "./flagRules";
import { Flags } from "./Flags";
import { Lanes } from "./Lanes";
import { ModelDetail, ModelList, modelColor } from "./ModelTable";
import { PHASES } from "./phases";
import { RenderList } from "./RenderList";
import { spanSaid, SummaryTiles } from "./SummaryTiles";
import { chartTimeLabel, stretchOf, useTimesView } from "./useTimesView";
import { WindowBar } from "./WindowBar";
import { scrollInside } from "../../scrollInside";

/**
 * With several ComfyUIs and every machine shown: each machine's share of the window and its learned pace, against the
 * fastest ("×2.9": nearly three times its time for the same model and settings). A click shows that machine alone.
 */
function MachineShares({ d, names, onPick }: { d: TimesSummary; names: Record<string, string>; onPick(id: string): void }) {
  const machines = d.machines ?? [];
  const fastest = Math.min(...machines.map((m) => m.pace ?? Infinity));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {machines.map((m) => (
        <button
          key={m.id} type="button" onClick={() => onPick(m.id)}
          data-tip={m.pace !== null && Number.isFinite(fastest) ? `Learned from the same model and settings rendered on several machines: ${m.pace / fastest < 1.05 ? "the fastest" : `${(m.pace / fastest).toFixed(1)} times the fastest one's time`}. Click: this machine alone.` : "Nothing rendered on it that another machine rendered too: no pace to compare yet. Click: this machine alone."}
          className="inline-flex items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-1.5 text-xs hover:bg-hover"
        >
          <span className="font-semibold">{names[m.id] ?? m.name ?? m.id}</span>
          <span className="text-ink-2">{plural(m.renders, "render")} · {took(m.gpuMs)}</span>
          {m.pace !== null && Number.isFinite(fastest) && <span className="font-mono text-ink-2">×{(m.pace / fastest).toFixed(1)}</span>}
        </button>
      ))}
    </div>
  );
}

// the viewer is fetched the first time a render's result is opened here
const Viewer = lazy(() => import("../../Viewer").then((m) => ({ default: m.Viewer })));

/**
 * How long renders took: totals for a period, panels over time, what each model usually takes and where
 * its time goes, and the renders one by one with their time split by phase. Read from the record the
 * server keeps of every render (apps/server/src/renders.ts).
 */

/** What every chart of the tab shares: the stretches of time, how they are said, the drag that zooms, the list under the pointer. */
type ChartBase = Pick<ComponentProps<typeof TimeChart>, "times" | "timeLabel" | "step" | "onBrush" | "detail">;

export function RenderTimes() {
  const { view, typed, setTyped, model, setModel, only, setOnly, machine, setMachine, times, renders, lanes, zoom, pick } = useTimesView();
  const several = severalMachines(useQueue().data);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const opened = useAsset(openedId);
  const tones = useChartColors();
  const d = times.data;
  const flags = useMemo(() => (d ? flagsOf(d, lanes.data?.items) : []), [d, lanes.data]);
  if (times.isError) return <ErrorNote>{times.error.message}</ErrorNote>;
  if (!d) return <div className="text-ink-2">Loading render history…</div>;

  const t = d.tiles;
  const anything = t.done + t.failed + t.cancelled > 0;
  const spanMs = d.to - d.from;
  const stretch = stretchOf(d.step);
  const timeLabel = chartTimeLabel(spanMs, d.step);
  const chart: ChartBase = { times: d.times, timeLabel, step: d.step, onBrush: zoom, detail: (i: number) => <TopList bucket={d.buckets[i]} /> };
  const windowSaid = `${timeLabel(d.from, true)} → ${timeLabel(d.to, true)}`;
  const pickedIndex = d.models.findIndex((m) => m.key === model);
  const picked = pickedIndex >= 0 ? d.models[pickedIndex] : undefined;
  // a flag's action: the list below, on that model's jobs (or its failed ones)
  const toJobs = (key: string, which: "all" | "trouble") => {
    setModel(key);
    setOnly(which);
    requestAnimationFrame(() => scrollInside(document.getElementById("render-list")));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <WindowBar view={view} shown={{ from: d.from, to: d.to }} typed={typed} onTyped={setTyped} onPreset={pick} onZoom={zoom} />
        <span className="text-xs text-ink-2">
          {windowSaid} · per {stretch}{d.prior ? ` · Δ vs prior ${spanSaid(d.prior.to - d.prior.from)}` : ""}
        </span>
        {d.since && <span className="text-xs text-ink-3" data-tip="First render on record">since {new Date(d.since).toLocaleDateString(UI_LOCALE, { day: "numeric", month: "short", year: "numeric" })}</span>}
        <span className="grow" />
        {/* with several ComfyUIs, which one the tab is of, as a dashboard's variable: All, or one machine */}
        {several.length > 0 && (
          <div className="w-52 shrink-0">
            <Select
              size="sm" label="Machine" value={machine ?? "all"} onChange={(v) => setMachine(v === "all" ? null : v)}
              options={[
                { value: "all", label: "All machines" },
                ...several.map((m) => ({ value: m.id, label: machineLabel(m) })),
                // a machine that rendered in the window and is gone since (a terminated pod): its figures can still be picked
                ...(d.machines ?? []).filter((m) => !several.some((x) => x.id === m.id)).map((m) => ({ value: m.id, label: `${m.name ?? m.id} (removed)` })),
              ]}
            />
          </div>
        )}
        <span className="text-xs text-ink-3">drag a chart: zoom</span>
      </div>
      {machine && <p className="-mt-3 text-xs text-ink-3">One machine's figures come from its renders kept one by one ({d.keepDays ? `the last ${d.keepDays} days, Settings › Storage` : "all of them"}); the days before are kept only as totals of every machine.</p>}
      {!machine && several.length > 0 && (d.machines?.length ?? 0) > 1 && <MachineShares d={d} names={Object.fromEntries(several.map((m) => [m.id, machineLabel(m)]))} onPick={setMachine} />}

      {!d.since && (
        <Empty title="No render history yet" help="Recorded for every render from now on: total, per phase (model load, sampling, VAE decode), VRAM, GPU temp. The ETAs come from it." />
      )}

      {d.since && (
        <>
          <SummaryTiles d={d} />

          {!anything && <div className="rounded-xl border border-line px-4 py-5 text-ink-2">No renders in this window.</div>}

          {anything && (
            <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
              {d.models.length > 0 && <ModelList d={d} model={model} onModel={setModel} palette={tones} />}
              <Flags flags={flags} onJobs={toJobs} />
            </div>
          )}

          {anything && picked && (
            <ModelDetail model={picked} color={modelColor(pickedIndex, tones)} times={d.times} timeLabel={timeLabel} stretch={stretch} onClose={() => setModel(null)} />
          )}

          {anything && (
            <Lanes items={lanes.data?.items ?? []} from={d.from} to={d.to} models={d.models.map((m) => m.key)} names={Object.fromEntries(d.models.map((m) => [m.key, m.name]))} only={model} timeLabel={timeLabel} onZoom={zoom} onOpen={(id) => setOpenedId(id)} />
          )}

          {anything && (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <TimeChart
                {...chart} title="Render time p50" note={`per ${stretch}`} format={long} axisFormat={brief} isolate={picked?.name}
                series={d.models.map((m) => ({ name: m.name, values: m.usual, tip: "p50 warm" }))}
              />
              <TimeChart
                {...chart} title="s/it vs p50" note="100 % = the model's own p50" format={(v) => `${Math.round(v)} %`} bottom={50} fill={false} isolate={picked?.name}
                series={[...d.models.map((m) => ({ name: m.name, values: m.pace })), { name: "p50", values: d.times.map(() => 100), color: "var(--color-ink-3)", dashed: true, tip: "Each model's own p50" }]}
              />
              <TimeChart
                {...chart} title="Finished" note={`per ${stretch}`} format={(v) => String(Math.round(v))} axisFormat={(v) => String(+v.toFixed(1))} stacked bars stat="sum"
                series={[
                  { name: "img", values: d.finished.images, color: "var(--color-picture)" },
                  { name: "vid", values: d.finished.videos, color: tones[0] },
                  { name: "failed/cancelled", values: d.finished.bad, color: "var(--color-warn)" },
                ]}
              />
              <TimeChart
                {...chart} title="GPU time by phase" note={`per ${stretch}`} format={long} axisFormat={brief} stacked stat="sum"
                series={PHASES.map((p) => ({ name: p.label, values: d.phases[p.id], color: p.id === "sampling" ? tones[0] : p.color, tip: p.tip }))}
              />
              <TimeChart
                {...chart} title="Queue wait" note="Generate → start" format={long} axisFormat={brief}
                series={[
                  { name: "p50", values: d.wait.usual, color: tones[0] },
                  { name: "p90", values: d.wait.slow, color: "var(--color-warn)", tip: "9 in 10 waited less" },
                ]}
              />
              <TimeChart
                {...chart} title="VRAM and GPU temperature" note={`peak per ${stretch}`} format={(v) => String(Math.round(v))} top={100} bottom={40} stat="max"
                series={[
                  { name: "VRAM %", values: d.gpu.vram, color: "var(--color-picture)" },
                  { name: "GPU °C", values: d.gpu.heat, color: "var(--color-warn)" },
                ]}
              />
              {d.upscale && (d.upscale.video.length > 0 || d.upscale.pictures.length > 0) && <UpscaleChart chart={chart} upscale={d.upscale} tones={tones} />}
            </div>
          )}

          <RenderList d={d} renders={renders} picked={picked} onModel={setModel} only={only} onOnly={setOnly} onOpen={(id) => setOpenedId(id)} />
        </>
      )}
      {openedId && opened.data && <Suspense fallback={null}><Viewer asset={opened.data} onClose={() => setOpenedId(null)} /></Suspense>}
    </div>
  );
}

/** The longest renders of a stretch, under the pointer: what took the time there. */
function TopList({ bucket }: { bucket: { renders: number; top: TopRender[] } | undefined }) {
  if (!bucket || !bucket.renders) return <span className="text-ink-3">no render</span>;
  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
      <span className="text-ink-3">{plural(bucket.renders, "job")}{bucket.top.length < bucket.renders ? ` · top ${bucket.top.length}` : ""}</span>
      {bucket.top.map((r) => (
        <span key={r.id} className="flex items-baseline gap-2">
          <span className="grow truncate text-ink-2">{r.name}{r.model ? <span className="text-ink-3"> · {r.model.split(" · ")[0]}</span> : ""}</span>
          <span className={cx("shrink-0 font-mono", r.status !== "done" && "text-warn-ink")}>{took(r.totalMs)}{r.status !== "done" ? ` · ${r.status}` : ""}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * How fast the upscales go, from the record: videos in minutes of work per second of video (a finish's route, a slow motion),
 * pictures in seconds per megapixel made (a picture tool, the hires pass of picture renders). Per second and per megapixel
 * because a 10 s clip or a 4K picture is not slower work, only more of it. Runs that ran out of video memory are left out.
 */
function UpscaleChart({ chart, upscale, tones }: { chart: ChartBase; upscale: NonNullable<TimesSummary["upscale"]>; tones: string[] }) {
  const [tab, setTab] = useState<"video" | "pictures">(upscale.video.length ? "video" : "pictures");
  const lines = tab === "video" ? upscale.video : upscale.pictures;
  return (
    <div className="relative">
      <TimeChart
        {...chart}
        title="Upscale speed"
        note={tab === "video" ? "GPU min / s of video · p50" : "GPU s / MP · p50"}
        format={(v) => (tab === "video" ? `${v.toFixed(v < 10 ? 1 : 0)} min/s` : `${v.toFixed(v < 10 ? 1 : 0)} s/MP`)}
        series={lines.map((l, i) => ({ name: l.name, values: l.points, color: tones[i % tones.length] }))}
      >
        {/* a choice only when both have runs: the note under the title says which one is drawn */}
        {upscale.video.length > 0 && upscale.pictures.length > 0 && (
          <Segmented<"video" | "pictures"> size="sm" oneLine label="Upscales of" value={tab} onChange={setTab} options={[{ value: "video", label: "Video" }, { value: "pictures", label: "Pictures" }]} />
        )}
      </TimeChart>
    </div>
  );
}
