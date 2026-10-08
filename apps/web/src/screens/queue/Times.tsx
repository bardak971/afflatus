import { lazy, Suspense, useState, type ComponentProps } from "react";
import type { TimesSummary, TopRender } from "../../api";
import { useAsset } from "../../data";
import { brief, long, took } from "../../format";
import { cx, Empty, ErrorNote } from "../../ui";
import { TimeChart, useChartColors } from "./Chart";
import { Lanes } from "./Lanes";
import { ModelTable } from "./ModelTable";
import { PHASES } from "./phases";
import { RenderList } from "./RenderList";
import { SummaryTiles } from "./SummaryTiles";
import { DAY, HOUR, useTimesView } from "./useTimesView";
import { WindowBar } from "./WindowBar";

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
  const { view, typed, setTyped, model, setModel, only, setOnly, times, renders, lanes, zoom, pick } = useTimesView();
  const [openedId, setOpenedId] = useState<string | null>(null);
  const opened = useAsset(openedId);
  const tones = useChartColors();
  const d = times.data;
  if (times.isError) return <ErrorNote>{times.error.message}</ErrorNote>;
  if (!d) return <div className="text-ink-2">Loading render history…</div>;

  const t = d.tiles;
  const anything = t.done + t.failed + t.cancelled > 0;
  const spanMs = d.to - d.from;
  const stretch = d.step < HOUR ? `${Math.round(d.step / 60_000)} minutes` : d.step === HOUR ? "hour" : d.step < DAY ? `${Math.round(d.step / HOUR)} hours` : "day";
  // en-GB: the UI is in English, and day before month, 24 h, whatever the browser's own locale
  const timeLabel = (time: number, full?: boolean) =>
    new Date(time).toLocaleString("en-GB", full
      ? d.step < DAY ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", year: "numeric" }
      : d.step < DAY ? (spanMs > 36 * HOUR ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) : { day: "numeric", month: "short" });
  const chart: ChartBase = { times: d.times, timeLabel, step: d.step, onBrush: zoom, detail: (i: number) => <TopList bucket={d.buckets[i]} /> };
  const windowSaid = `${timeLabel(d.from, true)} → ${timeLabel(d.to, true)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <WindowBar view={view} shown={{ from: d.from, to: d.to }} typed={typed} onTyped={setTyped} onPreset={pick} onZoom={zoom} />
        <span className="text-xs text-ink-3">{windowSaid} · a stretch is {d.step < DAY && d.step !== HOUR ? "" : "one "}{stretch} · drag on a chart to zoom in</span>
        {d.since && <span className="text-xs text-ink-3">History since {new Date(d.since).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.</span>}
      </div>

      {!d.since && (
        <Empty title="No render history yet">
          From now on every render is timed here: total time, time per phase (model load, sampling, VAE decode), and GPU load. The estimates on the buttons are made from it. Earlier renders only have their total, and are not shown.
        </Empty>
      )}

      {d.since && (
        <>
          <SummaryTiles d={d} />

          {!anything && <div className="rounded-xl border border-line px-4 py-5 text-ink-2">No renders in this window.</div>}

          {anything && (
            <Lanes items={lanes.data?.items ?? []} from={d.from} to={d.to} models={d.models.map((m) => m.key)} names={Object.fromEntries(d.models.map((m) => [m.key, m.name]))} timeLabel={timeLabel} onZoom={zoom} onOpen={(id) => setOpenedId(id)} />
          )}

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
                {...chart} title="Finished" note={`per ${stretch}`} format={(v) => String(Math.round(v))} axisFormat={(v) => String(+v.toFixed(1))} stacked bars stat="sum"
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
              {d.upscale && (d.upscale.video.length > 0 || d.upscale.pictures.length > 0) && <UpscaleChart chart={chart} upscale={d.upscale} tones={tones} />}
            </div>
          )}

          {d.models.length > 0 && <ModelTable d={d} model={model} onModel={setModel} timeLabel={timeLabel} stretch={stretch} />}

          <RenderList d={d} renders={renders} picked={d.models.find((m) => m.key === model)} onModel={setModel} only={only} onOnly={setOnly} onOpen={(id) => setOpenedId(id)} />
        </>
      )}
      {openedId && opened.data && <Suspense fallback={null}><Viewer asset={opened.data} onClose={() => setOpenedId(null)} /></Suspense>}
    </div>
  );
}

/** The longest renders of a stretch, under the pointer: what took the time there. */
function TopList({ bucket }: { bucket: { renders: number; top: TopRender[] } | undefined }) {
  if (!bucket || !bucket.renders) return <span className="text-ink-3">no render in this stretch</span>;
  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
      <span className="text-ink-3">{bucket.renders} render{bucket.renders === 1 ? "" : "s"}{bucket.top.length < bucket.renders ? `, the ${bucket.top.length} longest:` : ":"}</span>
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
        note={tab === "video" ? "minutes of work per second of video, median per stretch" : "seconds per megapixel made, median per stretch"}
        format={(v) => (tab === "video" ? `${v.toFixed(v < 10 ? 1 : 0)} min/s` : `${v.toFixed(v < 10 ? 1 : 0)} s/MP`)}
        series={lines.map((l, i) => ({ name: l.name, values: l.points, color: tones[i % tones.length] }))}
      >
        <div className="flex gap-1">
          {(["video", "pictures"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={tab === k} disabled={!(k === "video" ? upscale.video : upscale.pictures).length} onClick={() => setTab(k)}
              className={cx("rounded-md px-2 py-0.5 text-xs disabled:opacity-40", tab === k ? "bg-accent-wash text-accent" : "text-ink-2 hover:bg-hover hover:text-ink")}>
              {k === "video" ? "Video" : "Pictures"}
            </button>
          ))}
        </div>
      </TimeChart>
    </div>
  );
}
