import { lazy, memo, Suspense, useMemo, useState } from "react";
import { Clipboard, Eye, FileOutput, Loader2, Music, Pencil, Play, RotateCcw, Scissors, Search, Trash2, X } from "lucide-react";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import type { HistoryJob } from "../../api";
import { HoverVideo } from "../../HoverVideo";
import { useAsset, useJobs } from "../../data";
import { fileLabel, took, when } from "../../format";
import { Select } from "../../Select";
import { useSettled } from "../../hooks";
import { Button, cx, Empty, Segmented } from "../../ui";
import { FailedRow } from "./FailedRow";
import { rowFacts, rowName } from "./historyText";
import { ROW, useJobActions } from "./jobActions";
import { useModelName } from "./modelName";

// the viewer is fetched the first time a result is opened here
const Viewer = lazy(() => import("../../Viewer").then((m) => ({ default: m.Viewer })));

type Status = "all" | "done" | "failed" | "cancelled";

/**
 * What the queue has done, as a list: each finished job a row with a thumbnail of what it made, its name,
 * the model, how long it took and when; failed ones first, tinted, with their error and a retry; cancelled
 * ones folded away. Jobs asked for together ("Make 4") are one row. A click on a thumbnail opens the
 * result as the library does. Held apart from the queue above it: a progress event redraws the running card, not these rows.
 */
export const History = memo(function History() {
  const [status, setStatus] = useState<Status>("all");
  const [typed, setTyped] = useState("");
  const [model, setModel] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useSettled(typed);
  const jobs = useJobs({ status: status === "all" ? undefined : status, q, model });
  const items = useMemo(() => jobs.data?.pages.flatMap((p) => p.items) ?? [], [jobs.data]);
  const counts = jobs.data?.pages[0]?.counts;
  const asset = useAsset(open);

  // the models seen in what is loaded: enough to narrow the list down
  const models = useMemo(() => {
    const seen = new Set(items.map((j) => j.model).filter((m): m is string => Boolean(m)));
    if (model) seen.add(model);
    return [...seen].sort((a, b) => fileLabel(a).localeCompare(fileLabel(b)));
  }, [items, model]);

  // failed first; cancelled jobs, and done ones whose result was deleted since, folded away unless asked for
  const gone = (j: HistoryJob) => j.status === "done" && j.kind === "render" && j.made.length === 0;
  const failed = status === "all" || status === "failed" ? items.filter((j) => j.status === "failed") : [];
  const folded = status === "all" || status === "done" ? items.filter((j) => (status === "all" && j.status === "cancelled") || gone(j)) : [];
  const listed = items.filter((j) => j.status !== "failed" && (showCancelled || !folded.includes(j)));
  const foldedSaid = [
    folded.filter((j) => j.status === "cancelled").length ? `${folded.filter((j) => j.status === "cancelled").length} cancelled` : "",
    folded.filter(gone).length ? `${folded.filter(gone).length} whose result was deleted` : "",
  ].filter(Boolean).join(", ");
  // jobs asked for together make one row
  const groups: HistoryJob[][] = [];
  for (const j of listed) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.status === "done" && j.status === "done" && last[0]!.batch === j.batch && last[0]!.kind === "render" && j.kind === "render") last.push(j);
    else groups.push([j]);
  }

  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="w-[380px] max-w-full">
          <Segmented<Status>
            label="Which jobs"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All" },
              { value: "done", label: counts ? `Done · ${counts.done}` : "Done" },
              { value: "failed", label: counts ? `Failed · ${counts.failed}` : "Failed" },
              { value: "cancelled", label: counts ? `Cancelled · ${counts.cancelled}` : "Cancelled" },
            ]}
          />
        </div>
        <label className="flex h-9 w-60 min-w-28 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-ink-3" />
          <input data-search aria-label="Search the history" placeholder="Search names and prompts" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3" />
          {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
        </label>
        {models.length > 0 && (
          <div className="w-56">
            <Select label="Model" value={model} onChange={setModel} options={[{ value: "", label: "Any model" }, ...models.map((m) => ({ value: m, label: fileLabel(m) }))]} className="h-9" />
          </div>
        )}
        <span className="grow" />
        {jobs.isFetching && <Loader2 size={14} className="animate-spin text-ink-3" />}
      </div>

      <div className="flex min-h-0 grow flex-col gap-1 overflow-y-auto pr-1 pb-4">
        {(failed.length > 0 || groups.length > 0) && (
          <div aria-hidden className={cx(ROW, "sticky top-0 z-10 bg-ground py-1 text-[11px] tracking-[0.06em] text-ink-3 uppercase")}>
            <span /><span>Name</span><span>Model</span><span className="text-right">Took</span><span className="text-right">When</span>
          </div>
        )}
        {failed.map((j) => <FailedRow key={j.id} job={j} />)}
        {groups.length === 0 && failed.length === 0 && !jobs.isLoading && (
          <Empty title={q || model || status !== "all" ? "Nothing matches" : "Nothing finished yet"} />
        )}
        {groups.map((g) => <Row key={g[0]!.id} jobs={g} onOpen={setOpen} />)}
        {folded.length > 0 && (
          <button type="button" onClick={() => setShowCancelled(!showCancelled)} className="mt-1 self-start px-3 text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
            {showCancelled ? `Hide ${foldedSaid}` : `${foldedSaid} · show`}
          </button>
        )}
        {jobs.hasNextPage && (
          <div className="px-3 pt-1">
            <Button size="sm" onClick={() => void jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>{jobs.isFetchingNextPage ? "Loading…" : "Load more"}</Button>
          </div>
        )}
      </div>

      {asset.data && <Suspense fallback={null}><Viewer asset={asset.data} onClose={() => setOpen(null)} /></Suspense>}
    </section>
  );
});

/** A row's thumbnail: what it made (a picture, or a video that plays on hover); neutral for a cut, an export or nothing made. */
function Thumb({ jobs, onOpen }: { jobs: HistoryJob[]; onOpen(assetId: string): void }) {
  const head = jobs[0]!;
  const made = jobs.flatMap((j) => j.made);
  const first = made[0];
  const box = "relative flex h-9 w-16 items-center justify-center overflow-hidden rounded-[7px] bg-raised text-ink-3";
  if (!first || head.kind === "cut" || head.kind === "export" || first.kind === "audio") {
    const icon = head.kind === "export" ? <FileOutput size={15} /> : head.kind === "cut" ? <Scissors size={15} /> : head.kind === "load" ? <Loader2 size={15} /> : first?.kind === "audio" ? <Music size={15} /> : head.status === "cancelled" ? <X size={15} /> : <Play size={15} />;
    return first ? <button type="button" aria-label={`Open ${first.name || first.kind}`} onClick={() => onOpen(first.id)} className={cx(box, "hover:text-ink")}>{icon}</button> : <span className={box}>{icon}</span>;
  }
  return (
    <button type="button" data-stage aria-label={`Open ${first.name || first.kind}`} onClick={() => onOpen(first.id)} className={cx(box, "hover:ring-2 hover:ring-accent/50", first.inBin && "opacity-40")}>
      <HoverVideo asset={first.id} video={first.kind === "video"} />
      {made.length > 1 && <span className="absolute right-0.5 bottom-0.5 rounded bg-ground/80 px-1 text-[10px] leading-tight font-bold text-ink">×{made.length}</span>}
    </button>
  );
}

/** How a finished job ended, at the head of its menu. */
const STATUS_WORD = { queued: "Waiting", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" } as const;

/** One finished job, or several asked for together: what it made, under its name, and the facts of how. */
function Row({ jobs, onOpen }: { jobs: HistoryJob[]; onOpen(assetId: string): void }) {
  const head = jobs[0]!;
  const { again, dismiss, toDraft } = useJobActions();
  const modelOf = useModelName();
  const made = jobs.flatMap((j) => j.made);
  const first = made[0];
  const name = rowName(jobs);
  // right-click: what the row's buttons do, opening what it made, and its seed
  const menu = useMenu<true>();
  const items: MenuItem[] = [
    ...(first ? [{ label: made.length > 1 ? "Open the first result" : "Open the result", icon: <Eye size={14} />, run: () => onOpen(first.id) }] : []),
    ...(head.draftId ? [{ label: "Open its draft in Studio", icon: <Pencil size={14} />, run: () => toDraft(head.draftId!) }] : []),
    ...(head.kind === "render" ? [{ label: jobs.length > 1 ? `Requeue these ${jobs.length}` : "Requeue", icon: <RotateCcw size={14} />, note: "the same job again", disabled: again.isPending, run: () => jobs.forEach((j) => again.mutate({ id: j.id })) }] : []),
    ...(head.seed !== null && jobs.length === 1 ? [{ label: "Copy the seed", icon: <Clipboard size={14} />, note: String(head.seed), run: () => void navigator.clipboard?.writeText(String(head.seed)).catch(() => {}) }] : []),
    "—",
    { label: "Remove from the history", icon: <Trash2 size={14} />, danger: true, note: "what it made stays in the library", run: () => dismiss.mutate(jobs.map((j) => j.id)) },
  ];
  const tip = [head.prompt, name !== head.label ? head.label : "", head.seed !== null && jobs.length === 1 ? `seed ${head.seed}` : ""].filter(Boolean).join("\n");
  return (
    <div className={cx(ROW, "group rounded-xl py-1.5 hover:bg-hover", head.status === "cancelled" && "opacity-60 hover:opacity-100")} onContextMenu={(e) => menu.open(e, true)}>
      {menu.menu && <ContextMenu at={menu.menu.at} label={`Actions on ${name}`} head={{ title: name, sub: `${STATUS_WORD[head.status]}${jobs.length > 1 ? ` · ${jobs.length} jobs` : ""} · ${modelOf(head)}`, thumb: first && first.kind !== "audio" ? first.id : undefined }} items={items} onClose={menu.close} />}
      <Thumb jobs={jobs} onOpen={onOpen} />
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 grow flex-col gap-0.5" data-tip={tip || undefined}>
          <span className="truncate text-[13.5px] font-semibold">{name}</span>
          <span className="truncate text-xs text-ink-2">
            {rowFacts(jobs)}
            {head.warning && <span className="text-warn-ink" data-tip={head.warning}> · {head.warning}</span>}
          </span>
        </span>
        {/* what the menu does, at hand on hover or focus */}
        <span className="flex shrink-0 items-center gap-0.5 text-ink-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {head.kind === "render" && (
            <button type="button" data-tip={jobs.length > 1 ? `Requeue these ${jobs.length}` : "Requeue: the same job again"} aria-label="Requeue" disabled={again.isPending} onClick={() => jobs.forEach((j) => again.mutate({ id: j.id }))} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised hover:text-ink"><RotateCcw size={13} /></button>
          )}
          {head.draftId && (
            <button type="button" data-tip="Open its draft in Studio" aria-label="Open the draft" onClick={() => toDraft(head.draftId!)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised hover:text-ink"><Pencil size={13} /></button>
          )}
          <button type="button" data-tip="Remove from the history (what it made stays in the library)" aria-label="Remove from the history" onClick={() => dismiss.mutate(jobs.map((j) => j.id))} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised hover:text-ink"><X size={13} /></button>
        </span>
      </span>
      <span className="truncate text-[12.5px] text-ink-2" data-tip={head.model ? fileLabel(head.model) : undefined}>{modelOf(head)}</span>
      <span className="text-right font-mono text-xs text-ink-2">{head.tookMs !== null && head.status === "done" ? took(head.tookMs) : "—"}</span>
      <span className="text-right text-xs text-ink-2">{head.finishedAt ? when(head.finishedAt) : ""}</span>
    </div>
  );
}
