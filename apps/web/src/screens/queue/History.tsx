import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileOutput, Loader2, Music, Pencil, Play, RotateCcw, Scissors, Search, X } from "lucide-react";
import { api, thumbUrl, type HistoryJob } from "../../api";
import { useAsset, useJobs, useRecipes } from "../../data";
import { clock, fileLabel, took, when } from "../../format";
import { Select } from "../../Select";
import { useOpenDraft } from "../../store";
import { Button, cx, Empty, Segmented } from "../../ui";
import { Viewer } from "../../Viewer";
import { lighter, ranOutOfMemory } from "./retry";

type Status = "all" | "done" | "failed" | "cancelled";

/** What was typed, a moment after the typing stopped. */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * What the queue has done: every finished job as a card with what it made (the result itself, not a
 * word), the model, the size, how long it took, the seed; failed ones first with their error and a
 * retry; cancelled ones folded away. Jobs asked for together ("Make 4") are one card. A click on a
 * result opens it as the library does.
 */
export function History() {
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
  const failed = status === "all" ? items.filter((j) => j.status === "failed") : [];
  const folded = status === "all" || status === "done" ? items.filter((j) => (status === "all" && j.status === "cancelled") || gone(j)) : [];
  const listed = items.filter((j) => (status !== "all" || j.status !== "failed") && (showCancelled || !folded.includes(j)));
  const foldedSaid = [
    folded.filter((j) => j.status === "cancelled").length ? `${folded.filter((j) => j.status === "cancelled").length} cancelled` : "",
    folded.filter(gone).length ? `${folded.filter(gone).length} whose result was deleted` : "",
  ].filter(Boolean).join(", ");
  // jobs asked for together make one card
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
          <input data-search aria-label="Search the history" placeholder="Search prompts and labels" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3" />
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

      <div className="flex min-h-0 grow flex-col gap-3 overflow-y-auto pr-1 pb-4">
        {failed.length > 0 && (
          <div className="flex flex-col gap-2">
            {failed.map((j) => <Failed key={j.id} job={j} />)}
          </div>
        )}
        {groups.length === 0 && !jobs.isLoading && (
          <Empty title={q || model || status !== "all" ? "Nothing matches" : "Nothing finished yet"} />
        )}
        {groups.length > 0 && (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {groups.map((g) => <Card key={g[0]!.id} jobs={g} onOpen={setOpen} />)}
          </div>
        )}
        {folded.length > 0 && (
          <button type="button" onClick={() => setShowCancelled(!showCancelled)} className="self-start text-xs text-ink-2 underline underline-offset-2 hover:text-ink">
            {showCancelled ? `Hide ${foldedSaid}` : `${foldedSaid} · show`}
          </button>
        )}
        {jobs.hasNextPage && (
          <div>
            <Button size="sm" onClick={() => void jobs.fetchNextPage()} disabled={jobs.isFetchingNextPage}>{jobs.isFetchingNextPage ? "Loading…" : "Load more"}</Button>
          </div>
        )}
      </div>

      {asset.data && <Viewer asset={asset.data} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** What is done with a finished job: again, back to its draft, out of the list. */
function useJobActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["queue"] });
  const again = useMutation({ mutationFn: (v: { id: string; input?: Record<string, unknown> }) => api.retryJob(v.id, v.input), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: api.dismissJob, onSuccess: refresh });
  const openDraft = useOpenDraft((s) => s.open);
  const [, go] = useLocation();
  const toDraft = (id: string) => {
    openDraft(id);
    go("/create");
  };
  return { again, dismiss, toDraft };
}

/** One finished job, or several asked for together: what came out, and the facts of how. */
function Card({ jobs, onOpen }: { jobs: HistoryJob[]; onOpen(assetId: string): void }) {
  const head = jobs[0]!;
  const { again, dismiss, toDraft } = useJobActions();
  const made = jobs.flatMap((j) => j.made);
  const shown = made.slice(0, 4);
  const first = made[0];
  const facts = [
    first?.kind === "video" && first.durationMs ? clock(first.durationMs) : first?.width && first.height ? `${first.width} × ${first.height}` : "",
    head.tookMs !== null && head.status === "done" ? took(head.tookMs) : "",
  ].filter(Boolean);
  const dim = head.status === "cancelled";
  const title = head.prompt || head.label;
  return (
    <div className={cx("group flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel", dim && "opacity-60 hover:opacity-100")} title={title}>
      <div data-stage className={cx("relative grid aspect-square gap-px bg-raised", shown.length > 1 ? "grid-cols-2" : "grid-cols-1", shown.length > 2 ? "grid-rows-2" : "grid-rows-1")}>
        {shown.length === 0 ? (
          <span className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-2">
            {head.kind === "export" ? <FileOutput size={22} /> : head.kind === "cut" ? <Scissors size={22} /> : head.kind === "load" ? <Loader2 size={22} /> : head.status === "cancelled" ? <X size={22} /> : <Play size={22} />}
            <span className="text-xs">{head.kind === "export" ? "Export" : head.kind === "cut" ? "Cut" : head.kind === "load" ? "Model loaded" : head.status === "cancelled" ? "Cancelled" : "No result"}</span>
          </span>
        ) : (
          shown.map((m) => (
            <button key={m.id} type="button" aria-label={`Open ${m.kind}`} onClick={() => onOpen(m.id)} className={cx("relative h-full w-full min-h-0 min-w-0 overflow-hidden", shown.length === 3 && m === shown[0] && "row-span-2", m.inBin && "opacity-40")}>
              {m.kind === "audio" ? (
                <span className="absolute inset-0 flex items-center justify-center text-ink-2"><Music size={20} /></span>
              ) : (
                <img src={thumbUrl(m.id)} alt="" loading="lazy" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
              )}
              {m.kind === "video" && (
                <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">
                  <Play size={10} fill="currentColor" />{m.durationMs ? clock(m.durationMs) : ""}
                </span>
              )}
            </button>
          ))
        )}
        {made.length > 4 && <span className="absolute right-1.5 bottom-1.5 rounded-md bg-ground/80 px-1.5 py-0.5 text-[11px] font-semibold">+{made.length - 4}</span>}
        {jobs.length > 1 && <span className="absolute top-1.5 right-1.5 rounded-full bg-ground/80 px-2 py-0.5 text-[11px] font-bold">×{jobs.length}</span>}
        {head.status === "cancelled" && <span className="absolute top-1.5 left-1.5 rounded-full bg-ground/80 px-2 py-0.5 text-[11px] font-bold text-ink-2">Cancelled</span>}
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 grow truncate text-[13px] font-semibold">{head.label}{head.model ? <span className="font-normal text-ink-2"> · {fileLabel(head.model)}</span> : ""}</span>
        </div>
        {head.seed !== null && jobs.length === 1 && <span className="truncate font-mono text-[11px] text-ink-3" title={`seed ${head.seed}`}>seed {head.seed}</span>}
        {facts.length > 0 && <span className="truncate text-xs text-ink-2">{facts.join(" · ")}</span>}
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <span className="min-w-0 grow truncate">{head.finishedAt ? when(head.finishedAt) : ""}</span>
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {head.kind === "render" && (
              <button type="button" title={jobs.length > 1 ? `Requeue these ${jobs.length}` : "Requeue: the same job again"} aria-label="Requeue" disabled={again.isPending} onClick={() => jobs.forEach((j) => again.mutate({ id: j.id }))} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink"><RotateCcw size={13} /></button>
            )}
            {head.draftId && (
              <button type="button" title="Open its draft in Studio" aria-label="Open the draft" onClick={() => toDraft(head.draftId!)} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink"><Pencil size={13} /></button>
            )}
            <button type="button" title="Remove from the history (what it made stays in the library)" aria-label="Remove from the history" onClick={() => jobs.forEach((j) => dismiss.mutate(j.id))} className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink"><X size={13} /></button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A job that failed: the error, and the ways to run it again. */
function Failed({ job }: { job: HistoryJob }) {
  const recipes = useRecipes();
  const { again, dismiss, toDraft } = useJobActions();
  const recipe = recipes.data?.recipes.find((x) => x.id === job.recipe);
  const fix = ranOutOfMemory(job.error) ? lighter(recipe, job.input) : null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-warn/50 bg-warn-wash px-3.5 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{job.label}{job.model ? <span className="font-normal text-ink-2"> · {fileLabel(job.model)}</span> : ""}</span>
        <span className="grow truncate text-xs text-ink-2">{job.prompt}</span>
        <span className="shrink-0 text-xs text-ink-2">{job.finishedAt ? when(job.finishedAt) : ""}</span>
      </div>
      <div className="text-sm text-warn-ink">{job.error}{fix ? " Out of VRAM." : ""}</div>
      <div className="flex flex-wrap gap-1.5">
        {fix && <Button size="sm" tone="danger" disabled={again.isPending} onClick={() => again.mutate({ id: job.id, input: fix.change }, { onSuccess: () => dismiss.mutate(job.id) })}>{fix.label}</Button>}
        <Button size="sm" disabled={again.isPending} onClick={() => again.mutate({ id: job.id }, { onSuccess: () => dismiss.mutate(job.id) })}>Retry unchanged</Button>
        {job.draftId && <Button size="sm" onClick={() => toDraft(job.draftId!)}>Open the draft</Button>}
        <Button size="sm" tone="quiet" onClick={() => dismiss.mutate(job.id)}>Dismiss</Button>
      </div>
    </div>
  );
}
