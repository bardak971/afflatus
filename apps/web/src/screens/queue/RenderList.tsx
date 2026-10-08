import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Clapperboard, Image as ImageIcon, X } from "lucide-react";
import { thumbUrl, type RenderItem, type TimesSummary } from "../../api";
import { long, pace, took, when } from "../../format";
import { Button, cx, ErrorNote, SectionTitle } from "../../ui";
import { Legend, PhaseBar } from "./phases";

type Page = { total: number; more: boolean; items: RenderItem[] };

/** The renders of the window one by one, their time split by phase: all, or the failed and cancelled ones. */
export function RenderList({ d, renders, picked, onModel, only, onOnly, onOpen }: {
  d: TimesSummary;
  renders: UseInfiniteQueryResult<InfiniteData<Page, unknown>>;
  picked: TimesSummary["models"][number] | undefined;
  onModel(key: string | null): void;
  only: "all" | "trouble";
  onOnly(only: "all" | "trouble"): void;
  onOpen(assetId: string): void;
}) {
  const listed = renders.data?.pages.flatMap((p) => p.items) ?? [];
  const longest = Math.max(1, ...listed.map((r) => r.totalMs));
  return (
  <section className="flex flex-col gap-2">
    <div className="flex flex-wrap items-center gap-3">
      <SectionTitle>Renders in this window · {renders.data?.pages[0]?.total ?? 0}</SectionTitle>
      {picked && (
        <button type="button" onClick={() => onModel(null)} className="flex items-center gap-1 rounded-full border border-line-strong px-2.5 py-0.5 text-xs hover:bg-hover">
          Only {picked.name} <X size={12} />
        </button>
      )}
      <div className="flex overflow-hidden rounded-lg border border-line-strong text-xs">
        {([["all", "All"], ["trouble", "Failed or cancelled"]] as const).map(([v, l]) => (
          <button key={v} type="button" aria-pressed={only === v} onClick={() => onOnly(v)} className={cx("h-7 px-2.5 font-semibold", only === v ? "bg-accent text-accent-ink" : "text-ink-2 hover:bg-hover hover:text-ink")}>{l}</button>
        ))}
      </div>
      <div className="grow" />
      <Legend />
    </div>
    {renders.isError && <ErrorNote>{renders.error.message}</ErrorNote>}
    <div className="flex flex-col gap-1.5">
      {listed.map((r) => (
        <div key={r.id} id={`render-${r.id}`} className="grid grid-cols-[44px_minmax(0,1.2fr)_minmax(0,2fr)_150px_120px] items-center gap-4 rounded-[10px] border border-line bg-panel px-3 py-2 target:border-accent">
          {r.assetId
            ? <button type="button" onClick={() => onOpen(r.assetId!)} title="Open what it made"><img src={thumbUrl(r.assetId)} alt="" loading="lazy" className="h-11 w-11 rounded-md object-cover" /></button>
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
                !r.whole ? "Afflatus started while it was rendering: only its total is known" : r.cold ? `cold start, model load ${took(r.phases.loading)}` : "warm (model already loaded)",
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
  );
}
