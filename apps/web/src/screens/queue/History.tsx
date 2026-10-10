import { lazy, memo, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Clipboard, FileOutput, Loader2, Music, Pencil, Play, RotateCcw, Scissors, Search, Trash2, X } from "lucide-react";
import { ContextMenu, useMenu, type MenuItem } from "../../ContextMenu";
import { api, type HistoryJob } from "../../api";
import { HoverVideo } from "../../HoverVideo";
import { assetKey, useAsset, useJobs, useRecipes } from "../../data";
import { fileLabel, took, when } from "../../format";
import { Select } from "../../Select";
import { useSettled } from "../../hooks";
import { Button, cx, Empty, Help, Segmented } from "../../ui";
import { useQueueBulk } from "./bulk";
import { useCopyNote } from "./copyNote";
import { FailedRow } from "./FailedRow";
import { dayLabel, dayOf, failureKey, foldFailures, hourOf, pinnedFailures, reasonsOf } from "./failures";
import { rowFacts, rowName } from "./historyText";
import { ROW, useJobActions } from "./jobActions";
import { modelTip, useModelName } from "./modelName";
import { useTileMenu } from "../../TileMenu";

// the viewer is fetched the first time a result is opened here
const Viewer = lazy(() => import("../../Viewer").then((m) => ({ default: m.Viewer })));

type Status = "all" | "done" | "failed" | "cancelled";

/** "Retry", "Retry both", "Retry all": what a button over n jobs says. */
const overAll = (verb: string, n: number) => (n === 1 ? verb : n === 2 ? `${verb} both` : `${verb} all`);

/** What the history's ? says about where failures go. */
const ORDER_HELP = "In time order, by day. Failures since your last render done are pinned on top in one strip; older ones stay in time order, and those of earlier days fold under one line per day.";

/** The failures since the last render done, folded into one strip: how many and since when, their reasons, Retry all and Dismiss all; unfolded, each one's own row (the same failure several times: one row, foldFailures). */
function PinnedFailures({ jobs, since }: { jobs: HistoryJob[]; since: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const bulk = useQueueBulk();
  const ids = jobs.map((j) => j.id);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-warn-wash py-1.5 pr-1.5 pl-3 inset-ring inset-ring-warn/30">
        <button type="button" aria-expanded={open} data-tip={open ? "Fold them" : "Each one with its error and its own retry"} onClick={() => setOpen(!open)} className="flex min-w-0 grow items-center gap-2.5 text-left">
          {open ? <ChevronDown size={14} className="shrink-0 text-warn-ink" /> : <ChevronRight size={14} className="shrink-0 text-warn-ink" />}
          <span className="shrink-0 text-[13px] font-bold text-warn-ink">{jobs.length} failed since {hourOf(since)}</span>
          <span className="min-w-0 truncate text-xs text-ink-2">{reasonsOf(jobs)}</span>
        </button>
        <Button size="sm" disabled={busy} data-tip="The same jobs again, unchanged, oldest first" onClick={() => run(() => bulk.retryAllFailed(ids))}>{overAll("Retry", jobs.length)}</Button>
        <Button size="sm" tone="quiet" disabled={busy} onClick={() => run(() => bulk.dismissAllFailed({ ids }))}>{overAll("Dismiss", jobs.length)}</Button>
      </div>
      {open && foldFailures(jobs).map((g) => <FailedRow key={g[0]!.id} jobs={g} />)}
    </div>
  );
}

/** The failures of an earlier day, folded under one line: how many, Show, and "Dismiss all failed…" (asked first). */
function FoldedFailures({ jobs, shown, onShow }: { jobs: HistoryJob[]; shown: boolean; onShow(): void }) {
  const bulk = useQueueBulk();
  return (
    <div className="flex items-center gap-2.5 px-3 py-0.5 text-xs text-ink-2">
      <span className="font-semibold text-warn-ink" data-tip={reasonsOf(jobs, 99)}>{jobs.length} failed from earlier days</span>
      <Button size="sm" className="h-6 px-2" aria-expanded={shown} onClick={onShow}>{shown ? "Hide" : "Show"}</Button>
      <Button size="sm" className="h-6 px-2" onClick={() => void bulk.dismissAllFailed({ ids: jobs.map((j) => j.id), ask: true })}>Dismiss all failed…</Button>
    </div>
  );
}

/**
 * What the queue has done, as a list in time order, by day: each finished job a row with a thumbnail of what it
 * made, its name, the model, how long it took and when. The failures since the last render done are pinned on top
 * in one strip (PinnedFailures); older ones stay where they happened, those of earlier days folded under one line
 * per day. Cancelled ones fold away. Jobs asked for together ("Make 4") are one row. A click on a thumbnail opens
 * the result as the library does. Held apart from the queue above it: a progress event redraws the running card, not these rows.
 */
export const History = memo(function History() {
  const [status, setStatus] = useState<Status>("all");
  const [typed, setTyped] = useState("");
  const [model, setModel] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  /** The earlier days whose failures were unfolded. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const q = useSettled(typed);
  const jobs = useJobs({ status: status === "all" ? undefined : status, q, model });
  const items = useMemo(() => jobs.data?.pages.flatMap((p) => p.items) ?? [], [jobs.data]);
  // the counts last known: another tab is another list to read, and its tabs keep their counts meanwhile rather than
  // blank them; before any is known each says "–" (never a "0" that reads as none)
  const known = useRef(jobs.data?.pages[0]?.counts);
  if (jobs.data?.pages[0]?.counts) known.current = jobs.data.pages[0].counts;
  const counts = known.current;
  const asset = useAsset(open);
  // a finished job's menu: its own section (its draft, Requeue, out of the history), then its result's list, as every
  // place shows an item's (itemActions.tsx); one menu for the whole history, read for the row right-clicked
  const client = useQueryClient();
  const jobActs = useJobActions();
  // the model's name, worked out from the recipes: the same function until they are read again, so the rows keep theirs
  const modelName = useModelName();
  const recipes = useRecipes();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the same function until the recipes are read again, so the rows keep their names
  const modelOf = useMemo(() => modelName, [recipes.data]);
  // what each row would run for itself, run once here: a hook per row was three mutations, a menu and a copy note for
  // each of the thousands of rows a long history holds
  const seedCopy = useCopyNote();
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const rowMenu = useMenu<HistoryJob[]>();
  const [menuJobs, setMenuJobs] = useState<HistoryJob[] | null>(null);
  const resultMenu = useTileMenu({
    onOpen: (a) => setOpen(a.id), place: "queue", listed: false,
    seed: menuJobs?.length === 1 ? menuJobs[0]!.seed : null,
    first: () => (menuJobs ? rowOwn(menuJobs, jobActs) : []),
  });
  const openResultMenu = (e: React.MouseEvent, rowJobs: HistoryJob[]) => {
    const first = rowJobs.flatMap((j) => j.made)[0];
    if (!first) return;
    e.preventDefault();
    const at = { clientX: e.clientX, clientY: e.clientY, currentTarget: e.currentTarget, preventDefault() {} };
    // the result read in full first (its file, its folder): the list acts on the item as it is
    void client.fetchQuery({ queryKey: assetKey(first.id), queryFn: ({ signal }) => api.asset(first.id, { signal }) }).then((a) => {
      setMenuJobs(rowJobs);
      resultMenu.open(at, a);
    }, () => {});
  };

  // what the rows are handed, the same at every draw (Row is memoised): read when called, through a ref
  const latest = useRef({ jobActs, openResultMenu, rowMenu });
  latest.current = { jobActs, openResultMenu, rowMenu };
  const acts = useMemo<RowActs>(() => ({
    open: (id) => setOpen(id),
    menu: (e, jobs) => (jobs.some((j) => j.made.length) ? latest.current.openResultMenu(e, jobs) : latest.current.rowMenu.open(e, jobs)),
    again: (jobs) => jobs.forEach((j) => latest.current.jobActs.again.mutate({ id: j.id })),
    dismiss: (jobs) => latest.current.jobActs.dismiss.mutate(jobs.map((j) => j.id)),
    toDraft: (id) => latest.current.jobActs.toDraft(id),
  }), []);
  // right-click on a row with no result (a cut, an export, a result deleted since): its own section and its seed
  const menuOf = (jobs: HistoryJob[]): MenuItem[] => {
    const head = jobs[0]!;
    return [
      ...rowOwn(jobs, jobActs).slice(0, -1),
      ...(head.seed !== null && jobs.length === 1 ? [{ label: "Copy the seed", icon: <Clipboard size={14} />, note: String(head.seed), run: () => { setCopiedFor(head.id); seedCopy.copy(String(head.seed)); } }] : []),
      "—",
      ...rowOwn(jobs, jobActs).slice(-1),
    ];
  };
  const menuHead = rowMenu.menu?.subject;
  const menuName = menuHead ? rowName(menuHead) : "";

  // the models seen in what is loaded: enough to narrow the list down
  const models = useMemo(() => {
    const seen = new Set(items.map((j) => j.model).filter((m): m is string => Boolean(m)));
    if (model) seen.add(model);
    return [...seen].sort((a, b) => fileLabel(a).localeCompare(fileLabel(b)));
  }, [items, model]);

  // the failures since the last render done pinned on top (with All picked: the others have no render done to count
  // from); cancelled jobs, and done ones whose result was deleted since, folded away unless asked for
  const gone = (j: HistoryJob) => j.status === "done" && j.kind === "render" && j.made.length === 0;
  const pins = useMemo(() => (status === "all" ? pinnedFailures(items) : null), [items, status]);
  const pinned = new Set(pins?.pinned.map((j) => j.id));
  const folded = status === "all" || status === "done" ? items.filter((j) => (status === "all" && j.status === "cancelled") || gone(j)) : [];
  const listed = items.filter((j) => !pinned.has(j.id) && (showCancelled || !folded.includes(j)));
  const foldedSaid = [
    folded.filter((j) => j.status === "cancelled").length ? `${folded.filter((j) => j.status === "cancelled").length} cancelled` : "",
    folded.filter(gone).length ? `${folded.filter(gone).length} whose result was deleted` : "",
  ].filter(Boolean).join(", ");
  // by day, in time order; jobs asked for together make one row, and so does the same failure several times in a
  // day (one row where its newest is, "×3"). An earlier day's failures fold under one line (not when the failures
  // are what was asked for)
  const today = dayOf({ finishedAt: new Date().toISOString(), createdAt: "" });
  const days: Array<{ key: string; groups: HistoryJob[][]; failed: HistoryJob[]; same: Map<string, HistoryJob[]> }> = [];
  for (const j of listed) {
    const key = dayOf(j);
    let day = days[days.length - 1];
    if (day?.key !== key) days.push((day = { key, groups: [], failed: [], same: new Map() }));
    if (j.status === "failed" && status === "all" && key !== today) {
      day.failed.push(j);
      if (!unfolded.has(key)) continue;
    }
    if (j.status === "failed") {
      const same = day.same.get(failureKey(j));
      if (same) {
        same.push(j);
        continue;
      }
      day.same.set(failureKey(j), [j]);
      day.groups.push(day.same.get(failureKey(j))!);
      continue;
    }
    const last = day.groups[day.groups.length - 1];
    if (last && last[0]!.status === "done" && j.status === "done" && last[0]!.batch === j.batch && last[0]!.kind === "render" && j.kind === "render") last.push(j);
    else day.groups.push([j]);
  }
  const toggleDay = (key: string) =>
    setUnfolded((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    // the history takes the room left under the queue (basis 0), and its list the room left in it: sized by their content,
    // each step of a running render had the browser measure the whole list again, thousands of rows, to place the queue over it
    <section className="flex min-h-0 grow basis-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="w-[380px] max-w-full">
          <Segmented<Status>
            label="Which jobs"
            value={status}
            onChange={setStatus}
            options={[
              { value: "all", label: "All" },
              { value: "done", label: <>Done · <Count n={counts?.done} /></> },
              { value: "failed", label: <>Failed · <Count n={counts?.failed} /></> },
              { value: "cancelled", label: <>Cancelled · <Count n={counts?.cancelled} /></> },
            ]}
          />
        </div>
        <label className="flex h-9 w-60 min-w-28 shrink items-center gap-2 rounded-lg border border-line bg-raised px-2.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-ink-3" />
          <input data-search aria-label="Search the history" placeholder="Search names and prompts" value={typed} onChange={(e) => setTyped(e.target.value)} className="min-w-0 grow bg-transparent placeholder:text-ink-3" />
          {typed && <button type="button" aria-label="Clear the search" onClick={() => setTyped("")} className="text-ink-3 hover:text-ink"><X size={13} /></button>}
        </label>
        {/* drawn from the start (only "Any model" until the models are known): it arriving later moved the whole list down */}
        <div className="w-56">
          <Select label="Model" value={model} onChange={setModel} options={[{ value: "", label: "Any model" }, ...models.map((m) => ({ value: m, label: fileLabel(m) }))]} className="h-9" />
        </div>
        <Help text={ORDER_HELP} />
        <span className="grow" />
        {jobs.isFetching && <Loader2 size={14} className="animate-spin text-ink-3" />}
      </div>

      {pins && pins.pinned.length > 0 && <PinnedFailures jobs={pins.pinned} since={pins.since} />}

      <div className="flex min-h-0 grow basis-0 flex-col gap-1 overflow-y-auto pr-1 pb-4">
        {(days.length > 0 || jobs.isLoading) && (
          <div aria-hidden className={cx(ROW, "sticky top-0 z-10 bg-ground py-1 text-[11px] tracking-[0.06em] text-ink-3 uppercase")}>
            <span /><span>Name</span><span>Model</span><span className="text-right">Took</span><span className="text-right">When</span>
          </div>
        )}
        {/* the first page on its way: rows as the list draws them, with the loading shine, so it lands in place */}
        {jobs.isLoading && Array.from({ length: 8 }, (_, i) => <PlaceholderRow key={i} />)}
        {days.length === 0 && !pins?.pinned.length && !jobs.isLoading && (
          <Empty title={q || model || status !== "all" ? "Nothing matches" : "Nothing finished yet"} />
        )}
        {days.map((d) => (
          <div key={d.key} className="flex flex-col gap-1">
            <div className="px-3 pt-2 pb-0.5 text-[11px] font-bold tracking-[0.08em] text-ink-3 uppercase">{dayLabel(d.key)}</div>
            {d.failed.length > 0 && <FoldedFailures jobs={d.failed} shown={unfolded.has(d.key)} onShow={() => toggleDay(d.key)} />}
            {d.groups.map((g) => (g[0]!.status === "failed"
              ? <FailedRow key={g[0]!.id} jobs={g} quiet={status === "all"} />
              : <Row key={g[0]!.id} jobs={g} acts={acts} modelOf={modelOf} requeueing={jobActs.again.isPending} note={copiedFor === g[0]!.id ? seedCopy.note : null} />))}
          </div>
        ))}
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

      {rowMenu.menu && menuHead && (
        <ContextMenu
          at={rowMenu.menu.at}
          label={`Actions on ${menuName}`}
          head={{ title: menuName, sub: `${STATUS_WORD[menuHead[0]!.status]}${menuHead.length > 1 ? ` · ${menuHead.length} jobs` : ""} · ${modelOf(menuHead[0]!)}` }}
          items={menuOf(menuHead)}
          onClose={rowMenu.close}
        />
      )}
      {asset.data && <Suspense fallback={null}><Viewer asset={asset.data} onClose={() => setOpen(null)} /></Suspense>}
      {resultMenu.element}
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

/** A tab's count: a dash until it is known; in figures of one width, in room for three, so the tabs keep their widths. */
function Count({ n }: { n: number | undefined }): ReactNode {
  return <span className="inline-block min-w-[3ch] text-left tabular-nums">{n ?? "–"}</span>;
}

/** A row while the history loads, laid out as Row is: the thumbnail, the name over its facts, the model, the time it took, when. */
function PlaceholderRow() {
  return (
    <div aria-hidden className={cx(ROW, "py-1.5")}>
      <span className="m-skeleton h-9 w-16 rounded-[7px]!" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13.5px]"><span className="m-skeleton inline-block h-[0.8em] w-2/5 align-middle" /></span>
        <span className="text-xs"><span className="m-skeleton inline-block h-[0.8em] w-3/5 align-middle" /></span>
      </span>
      <span className="text-[12.5px]"><span className="m-skeleton inline-block h-[0.8em] w-24 align-middle" /></span>
      <span className="text-right text-xs"><span className="m-skeleton inline-block h-[0.8em] w-10 align-middle" /></span>
      <span className="text-right text-xs"><span className="m-skeleton inline-block h-[0.8em] w-12 align-middle" /></span>
    </div>
  );
}

/** How a finished job ended, at the head of its menu. */
const STATUS_WORD = { queued: "Waiting", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" } as const;

/** A finished job's own section of its menu, before its result's list: back to its draft, the same job again, out of the history. */
function rowOwn(jobs: HistoryJob[], { again, dismiss, toDraft }: ReturnType<typeof useJobActions>): MenuItem[] {
  const head = jobs[0]!;
  return [
    ...(head.draftId ? [{ label: "Open its draft", icon: <Pencil size={14} />, run: () => toDraft(head.draftId!) }] : []),
    ...(head.kind === "render" ? [{ label: jobs.length > 1 ? `Requeue these ${jobs.length}` : "Requeue", icon: <RotateCcw size={14} />, note: "the same job again", disabled: again.isPending, run: () => jobs.forEach((j) => again.mutate({ id: j.id })) }] : []),
    { label: "Remove from the history", icon: <Trash2 size={14} />, danger: true, note: "what it made stays in the library", run: () => dismiss.mutate(jobs.map((j) => j.id)) },
  ];
}

/** What a row does, handed down from the history: one set for every row. */
interface RowActs {
  open(assetId: string): void;
  menu(e: React.MouseEvent, jobs: HistoryJob[]): void;
  again(jobs: HistoryJob[]): void;
  dismiss(jobs: HistoryJob[]): void;
  toDraft(draftId: string): void;
}

interface RowProps {
  jobs: HistoryJob[];
  acts: RowActs;
  modelOf: ReturnType<typeof useModelName>;
  /** A requeue is on its way: the row's own Requeue waits. */
  requeueing: boolean;
  /** How the copy of its seed went, from its menu, for a moment. */
  note: { ok: boolean; text: string } | null;
}

/** Whether a row is handed the same again: the list read anew (another page, a job that ended) gives new groups of mostly the same jobs. */
const sameRow = (a: RowProps, b: RowProps) =>
  a.acts === b.acts && a.modelOf === b.modelOf && a.requeueing === b.requeueing && a.note === b.note && a.jobs.length === b.jobs.length && a.jobs.every((j, i) => j === b.jobs[i]);

/**
 * One finished job, or several asked for together: what it made, under its name, and the facts of how. Drawn again only
 * when its jobs change, and laid out only near the view (content-visibility): with thousands of rows loaded, each step
 * of a running render laid the whole list out again.
 */
const Row = memo(function Row({ jobs, acts, modelOf, requeueing, note }: RowProps) {
  const head = jobs[0]!;
  const name = rowName(jobs);
  const tip = [head.prompt, name !== head.label ? head.label : "", head.seed !== null && jobs.length === 1 ? `seed ${head.seed}` : ""].filter(Boolean).join("\n");
  return (
    <div className={cx(ROW, "group rounded-xl py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto] hover:bg-hover", head.status === "cancelled" && "opacity-60 hover:opacity-100")} onContextMenu={(e) => acts.menu(e, jobs)}>
      <Thumb jobs={jobs} onOpen={acts.open} />
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex min-w-0 grow flex-col gap-0.5" data-tip={tip || undefined}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold">{name}</span>
            {note && <span aria-live="polite" className={cx("shrink-0 text-xs", note.ok ? "text-accent" : "text-warn-ink")}>{note.text}</span>}
          </span>
          <span className="truncate text-xs text-ink-2">
            {rowFacts(jobs)}
            {head.warning && <span className="text-warn-ink" data-tip={head.warning}> · {head.warning}</span>}
          </span>
        </span>
        {/* what the menu does, at hand on hover or focus */}
        <span className="flex shrink-0 items-center gap-0.5 text-ink-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {head.kind === "render" && (
            <button type="button" data-tip={jobs.length > 1 ? `Requeue these ${jobs.length}` : "Requeue: the same job again"} aria-label="Requeue" disabled={requeueing} onClick={() => acts.again(jobs)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised hover:text-ink"><RotateCcw size={13} /></button>
          )}
          {head.draftId && (
            <button type="button" data-tip="Open its draft" aria-label="Open its draft" onClick={() => acts.toDraft(head.draftId!)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised hover:text-ink"><Pencil size={13} /></button>
          )}
          <button type="button" data-tip="Remove from the history (what it made stays in the library)" aria-label="Remove from the history" onClick={() => acts.dismiss(jobs)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-raised hover:text-ink"><X size={13} /></button>
        </span>
      </span>
      <span className="truncate text-[12.5px] text-ink-2" data-tip={modelTip(modelOf(head), head.model)}>{modelOf(head)}</span>
      <span className="text-right font-mono text-xs text-ink-2">{head.tookMs !== null && head.status === "done" ? took(head.tookMs) : "—"}</span>
      <span className="text-right text-xs text-ink-2">{head.finishedAt ? when(head.finishedAt) : ""}</span>
    </div>
  );
}, sameRow);
