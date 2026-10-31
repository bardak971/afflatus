import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Clapperboard, Image as ImageIcon } from "lucide-react";
import { thumbUrl, type RenderItem, type TimesSummary } from "../../api";
import { long, pace, took, when } from "../../format";
import { Thumb } from "../../Thumb";
import { Button, Chip, cx, Empty, Failed, SectionTitle, Segmented } from "../../ui";
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
  <section id="render-list" className="flex scroll-mt-4 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-3">
      <SectionTitle>Renders · {renders.data?.pages[0]?.total ?? 0}</SectionTitle>
      {picked && (
        <Chip tone="link" truncate onRemove={() => onModel(null)} removeLabel="Show every model's renders again" className="max-w-72">
          Only {picked.name}
        </Chip>
      )}
      <Segmented<"all" | "trouble"> size="sm" oneLine label="Which renders" value={only} options={[{ value: "all", label: "all" }, { value: "trouble", label: "failed/cancelled" }]} onChange={onOnly} />
      <div className="grow" />
      <Legend />
    </div>
    {renders.isError && <Failed what="Renders not loaded" error={renders.error} />}
    <div className="flex flex-col gap-1.5">
      {listed.map((r) => (
        <div key={r.id} id={`render-${r.id}`} className="grid grid-cols-[44px_minmax(0,1.2fr)_minmax(0,2fr)_150px_120px] items-center gap-4 rounded-control border border-line bg-panel px-3 py-2 target:border-accent">
          {r.assetId
            ? (
              // design: the output's thumbnail, opening it; its size is the picture's, not an icon button's
              <button type="button" onClick={() => onOpen(r.assetId!)} aria-label="Open output" data-tip="Open output" className="block rounded-md bg-raised"><Thumb src={thumbUrl(r.assetId)} alt="" loading="lazy" sizes="44px" className="h-11 w-11 rounded-md object-cover" /></button>
            )
            : <div className="flex h-11 w-11 items-center justify-center rounded-md bg-raised text-ink-3" data-tip={r.status === "done" ? "Output deleted" : "No output"}>{r.kind === "video" ? <Clapperboard size={16} /> : <ImageIcon size={16} />}</div>}
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{r.name}</span>
            <span className="truncate text-xs text-ink-2" data-tip={r.model}>
              {[r.model, r.width && r.height ? `${r.width}×${r.height}` : "", r.seconds ? `${r.seconds} s` : "", `${r.steps} steps`].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <PhaseBar phases={r.phases} scale={r.totalMs / longest} />
            <span className="truncate text-xs text-ink-3" data-tip={!r.whole ? "Afflatus started while it was rendering: only its total is known" : undefined}>
              {[
                !r.whole ? "resumed · total only" : r.cold ? `cold · load ${took(r.phases.loading)}` : "warm",
                r.stepMs === null ? "" : `${pace(r.stepMs)} s/it`,
                r.waitedMs > 1000 ? `wait ${long(r.waitedMs)}` : "",
                r.oom ? "OOM" : r.spilled ? "VRAM spill" : "",
              ].filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className={cx("font-mono text-title", r.status !== "done" && "text-warn-ink")}>{r.status === "done" ? took(r.totalMs) : r.status === "failed" ? "Failed" : "Cancelled"}</span>
            <span className="text-xs text-ink-3">{r.status !== "done" ? `after ${took(r.totalMs)}` : r.expectedMs ? `ETA ${took(r.expectedMs)}` : "no ETA"}</span>
          </div>
          <div className="flex flex-col items-end text-xs text-ink-2">
            <span>{when(r.at)}</span>
            <span className="font-mono text-ink-3">{[r.vram === null ? "" : `${Math.round(r.vram)} %`, r.heat === null ? "" : `${Math.round(r.heat)}°`].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
      ))}
      {renders.isSuccess && !listed.length && <Empty title={only === "trouble" ? "No failed or cancelled render in this window" : "No renders in this window"} action={only === "trouble" ? <Button size="sm" onClick={() => onOnly("all")}>Show all</Button> : undefined} />}
      {renders.hasNextPage && <div><Button size="sm" onClick={() => renders.fetchNextPage()} disabled={renders.isFetchingNextPage}>More</Button></div>}
      <span
        className="self-start text-xs text-ink-3"
        data-tip={d.keepDays ? "A setting in Settings. Older jobs are folded into daily figures, which the charts keep drawing for good." : "A setting in Settings."}
      >
        {d.keepDays ? `jobs kept ${d.keepDays} d · then daily figures` : "jobs kept for good"}
      </span>
    </div>
  </section>
  );
}
