import { useContext, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Download as DownloadIcon, GripVertical } from "lucide-react";
import { Link } from "wouter";
import { api, type Download } from "./api";
import { ContextMenu, menuAt } from "./ContextMenu";
import { useQueue, useSettings } from "./data";
import { coming, inLine, lineOfFile, linesOf, msFor, ordinal, startsIn, type Line } from "./downloadLine";
import { FileWhere } from "./FileWhere";
import { est, fileLabel, hourMinute, leftWords, size } from "./format";
import { useNow } from "./hooks";
import { machineName } from "./machines";
import { Popover } from "./Popover";
import { queryKeys } from "./queryKeys";
import { useSayFailed } from "./sayFailed";
import { settingHref } from "./screens/settings/settingsIndex";
import { CloseButton, cx } from "./ui";
import { DownloadTo, useDownloads } from "./useGetFile";

/**
 * The downloads manager (card #60, mock-downloads-queue.html): the line of files coming into each ComfyUI, in one place.
 * The status bar's chip opens it as a popover; Settings › Models has it as a card under Model sets, with what was done
 * today and what failed. One list for both (LineList), read through downloadLine.ts, as each file's own state (FileState).
 */

/** Every ComfyUI's line, read again every half minute for "today" and the times. */
export function useLines() {
  const items = useDownloads().data?.items;
  const settings = useSettings().data;
  const first = settings?.machines[0]?.id;
  const now = useNow(30_000);
  const lines = useMemo(() => linesOf(items ?? [], first, now), [items, first, now]);
  return { lines, first };
}

/** What a ComfyUI is called in the line's head: "this PC" for one running here, else its name. */
function useWhere() {
  const settings = useSettings().data;
  const q = useQueue().data;
  return (machine: string | undefined) => {
    const m = settings?.machines.find((x) => x.id === machine);
    return m?.local ? "this PC" : machineName(q, machine) ?? m?.url ?? "ComfyUI";
  };
}

/** What a line comes to, in its head: "46.2 GB left · done ~21:40". */
function leftSaid(line: Line): string {
  // an end only when every size is known: one not known yet would make it a promise the line cannot keep
  const ms = line.unsized ? null : msFor(line.left, line.rate);
  const end = ms ? hourMinute(Date.now() + ms) : "";
  return [line.left ? `${line.unsized ? "over " : ""}${size(line.left)} left` : "", end ? `done ~${end}` : ""].filter(Boolean).join(" · ");
}

/** What is under way and still fetching: one whole, ComfyUI listing it, is shown but not counted. */
const fetching = (line: Line) => line.under.filter((d) => d.status !== "saving");

/** The file's name, without its sub-folders. */
const nameOf = (d: Download) => fileLabel(d.file);
/** What it is, when the title says more than its file's name (a Civitai model's name). */
const whatOf = (d: Download) => (d.title && d.title !== nameOf(d) && d.title !== d.file ? d.title : null);

/** Cancelling, moving and clearing, said when the server refuses. */
function useLineOps() {
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "downloads" });
  const again = () => client.invalidateQueries({ queryKey: queryKeys.downloads() });
  return {
    stop: useMutation({ mutationFn: (id: string) => api.stopDownload(id), onError: sayFailed("Not cancelled"), onSettled: again }),
    move: useMutation({ mutationFn: (m: { id: string; before: string | null }) => api.moveDownload(m.id, m.before), onError: sayFailed("Not moved"), onSettled: again }),
    cancelAll: useMutation({ mutationFn: (machine?: string) => api.cancelWaitingDownloads(machine), onError: sayFailed("The waiting downloads were not cancelled"), onSettled: again }),
    clear: useMutation({ mutationFn: (machine?: string) => api.clearDownloads(machine), onError: sayFailed("Not cleared"), onSettled: again }),
    tryAgain: useMutation({ mutationFn: (id: string) => api.downloadAgain(id), onError: sayFailed("Not started again"), onSettled: again }),
  };
}

const sec = "px-4 pt-2 pb-0.5 text-meta font-bold tracking-label text-ink-3 uppercase";
const row = "grid grid-cols-[18px_minmax(0,1fr)_auto_24px] items-center gap-2.5 px-4 py-2";
/** The waiting ones shown before "+ N more": the popover keeps short, the card shows a few more. */
const SHOWN = { pop: 4, card: 5 };

/**
 * One ComfyUI's line: under way (each with its bar, size, speed and time left), next in order (dragged to come sooner),
 * and in the card (`full`) what was done today and what failed. ✕ cancels, as each file's own state does.
 */
export function LineList({ line, full, head }: { line: Line; full?: boolean; head?: string }) {
  const ops = useLineOps();
  const [all, setAll] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const shown = all ? line.next : line.next.slice(0, full ? SHOWN.card : SHOWN.pop);
  const more = line.next.length - shown.length;
  const drop = (index: number) => {
    if (!dragged) return;
    // before the one now at that place, the dragged one left out; past the last, to the end
    const rest = line.next.filter((d) => d.id !== dragged);
    const before = rest[index - (line.next.findIndex((d) => d.id === dragged) < index ? 1 : 0)]?.id ?? null;
    ops.move.mutate({ id: dragged, before });
    setDragged(null);
    setOver(null);
  };
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2.5 border-b border-line px-4 py-2.5">
        {head && <span className="font-bold text-ink-strong">{head}</span>}
        <span className="text-xs text-ink-2">{[fetching(line).length && `${fetching(line).length} under way`, line.next.length && `${line.next.length} waiting`].filter(Boolean).join(" · ") || "nothing coming"}</span>
        <span className="ml-auto font-mono text-xs text-ink-3">{leftSaid(line)}</span>
      </div>
      {line.under.length > 0 && <div className={sec}>Under way</div>}
      {line.under.map((d) => {
        const part = d.total ? Math.min(1, d.bytes / d.total) : 0;
        const left = d.rate && d.total > d.bytes ? msFor(d.total - d.bytes, d.rate) : null;
        return (
          <div key={d.id} className={row}>
            <DownloadIcon size={13} className="justify-self-center text-ink-3" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-body" data-tip={d.file}>{nameOf(d)}</span>
              <span className="truncate text-xs text-ink-3">{[whatOf(d), d.status === "saving" ? "ComfyUI is listing it" : `into ${d.shown ?? d.folder}`].filter(Boolean).join(" · ")}</span>
              <span className="mt-1 h-1 overflow-hidden rounded-key bg-line-strong"><span className="block h-full bg-accent" style={{ width: `${(d.status === "saving" ? 1 : part) * 100}%` }} /></span>
            </div>
            <span className="text-right font-mono text-xs whitespace-nowrap text-ink-2">
              {d.total ? `${size(d.bytes)} / ${size(d.total)}` : size(d.bytes)}
              <br />
              {[d.rate ? `${size(d.rate)}/s` : "", left ? est(left) : ""].filter(Boolean).join(" · ")}
            </span>
            {d.status !== "saving" ? <CloseButton size={24} label={`Cancel ${nameOf(d)}`} tip="Cancel it: nothing is kept of it" onClose={() => ops.stop.mutate(d.id)} /> : <span />}
          </div>
        );
      })}
      {line.next.length > 0 && <div className={sec}>Next · drag to change the order</div>}
      <div onDragOver={(e) => dragged && e.preventDefault()} onDrop={() => over !== null && drop(over)}>
        {shown.map((d, i) => (
          <div
            key={d.id}
            draggable={Boolean(d.turn)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              setDragged(d.id);
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!dragged) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setOver(e.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            className={cx(row, "border-y-2 border-transparent", Boolean(d.turn) && "cursor-grab", dragged === d.id && "bg-hover opacity-60", dragged && over === i && "border-t-accent", dragged && over === i + 1 && i === shown.length - 1 && "border-b-accent")}
          >
            <GripVertical size={13} className="justify-self-center text-ink-3" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-body" data-tip={d.file}><span className="mr-1.5 font-mono text-xs text-ink-3">{d.turn ?? "–"}</span>{nameOf(d)}</span>
              <span className="truncate text-xs text-ink-3">{[whatOf(d), d.shown ?? d.folder].filter(Boolean).join(" · ")}</span>
            </div>
            <span className="text-right font-mono text-xs text-ink-2">{d.total ? size(d.total) : "–"}</span>
            <CloseButton size={24} label={`Take ${nameOf(d)} out of the line`} tip="Take it out of the line" onClose={() => ops.stop.mutate(d.id)} />
          </div>
        ))}
      </div>
      {full && line.done.length > 0 && <div className={sec}>Done today</div>}
      {full && line.done.map((d) => (
        <div key={d.id} className={row}>
          <Check size={13} className="justify-self-center text-good" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-body" data-tip={d.file}>{nameOf(d)}</span>
            <span className="truncate text-xs text-ink-3">Here · {d.shown ?? d.folder}{d.at ? ` · ${hourMinute(d.at)}` : ""}</span>
            {/* the file on disk, with Show in folder or Copy (card #64) */}
            <FileWhere folder={d.folder} file={d.file} machine={d.machine} />
          </div>
          <span className="text-right font-mono text-xs text-ink-2">{d.total ? size(d.total) : ""}</span>
          <span />
        </div>
      ))}
      {full && line.failed.length > 0 && <div className={sec}>Failed</div>}
      {full && line.failed.map((d) => (
        <div key={d.id} className={row}>
          <span className="justify-self-center font-bold text-warn-ink">!</span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-body" data-tip={d.file}>{nameOf(d)}</span>
            <span className="text-xs text-warn-ink">
              {d.error ?? "Failed."}
              {d.again && <> · <button type="button" className="font-semibold underline" disabled={ops.tryAgain.isPending} onClick={() => ops.tryAgain.mutate(d.id)}>Try again</button></>}
            </span>
          </div>
          <span className="text-right font-mono text-xs text-ink-2">{d.total ? size(d.total) : ""}</span>
          <CloseButton size={24} label={`Dismiss ${nameOf(d)}`} tip="Dismiss" onClose={() => ops.stop.mutate(d.id)} />
        </div>
      ))}
      <div className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-xs text-ink-3">
        {more > 0 ? <button type="button" className="hover:text-ink" onClick={() => setAll(true)}>+ {more} more</button> : <span />}
        <span className="ml-auto flex items-center gap-3">
          {line.next.length > 0 && <button type="button" className="text-ink-2 hover:text-ink" disabled={ops.cancelAll.isPending} onClick={() => ops.cancelAll.mutate(line.machine)}>Remove all waiting</button>}
          {full && (line.done.length > 0 || line.failed.length > 0) && <button type="button" className="text-ink-2 hover:text-ink" disabled={ops.clear.isPending} onClick={() => ops.clear.mutate(line.machine)}>Clear done</button>}
          {!full && <Link href={settingHref("models.downloads")} className="text-ink-2 hover:text-ink">Settings › Models</Link>}
        </span>
      </div>
    </div>
  );
}

/**
 * The status bar's chip: "2 ↓ · 8 waiting" with a ring of the first file's share (one file alone: its name and share), and
 * the line as a popover, one group per ComfyUI with several. Nothing while nothing comes.
 */
export function DownloadsChip({ className }: { className?: string }) {
  const { lines } = useLines();
  const where = useWhere();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const busy = lines.filter((l) => l.under.length || l.next.length);
  // whole and being listed by ComfyUI: no longer counted as coming (the line says them until they are listed)
  const under = busy.flatMap(fetching);
  const next = busy.flatMap((l) => l.next);
  if (!under.length && !next.length) return null;
  const lead = under[0];
  const share = lead?.total ? Math.min(1, lead.bytes / lead.total) : 0;
  const alone = under.length === 1 && !next.length ? lead! : null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-tip="Model files coming into ComfyUI: they go on if this page is closed. Click for the line, its order and what is left."
        className={cx("inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-chip border border-accent bg-raised px-2 text-xs text-ink hover:bg-hover", className)}
      >
        <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: `conic-gradient(var(--color-accent) 0 ${share * 100}%, var(--color-line-strong) ${share * 100}% 100%)` }} />
        {alone ? (
          <>
            <span className="truncate">{nameOf(alone)}</span>
            {alone.total > 0 && <span className="shrink-0 font-mono">{Math.floor(share * 100)} %</span>}
          </>
        ) : (
          <span className="whitespace-nowrap">{under.length} ↓{next.length > 0 && <span className="text-ink-3"> · {next.length} waiting</span>}</span>
        )}
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label="Downloads" width={560} height={Math.min(620, 140 + (under.length + Math.min(next.length, SHOWN.pop)) * 56)}>
          <div className="min-h-0 overflow-y-auto">
            {busy.map((l, i) => (
              <div key={l.machine ?? "first"} className={cx(i > 0 && "border-t border-line-strong")}>
                <LineList line={l} head={i === 0 ? `Downloads · on ${where(l.machine)}` : `On ${where(l.machine)}`} />
              </div>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/**
 * Settings › Models' Downloads card, under Model sets: the full manager for a ComfyUI (`machine`, a machine's tab) or for
 * each, with what was done today and what failed. Shown only when there is something to show.
 */
export function DownloadsCard({ machine }: { machine?: string }) {
  const { lines } = useLines();
  const where = useWhere();
  const settings = useSettings().data;
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "download-place" });
  const reset = useMutation({
    mutationFn: (c: { machine: string; folder: string }) => api.setDownloadPlace({ ...c, path: null }),
    onError: sayFailed("The place was not reset"),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.downloadPlaces() });
      void client.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
  const shown = lines.filter((l) => (!machine || l.machine === machine) && (l.under.length || l.next.length || l.done.length || l.failed.length));
  // the places chosen for a folder's downloads (GoesTo's menu), each with a way back to ComfyUI's own folder
  const chosen = Object.entries(settings?.downloadPlaces ?? {}).filter(([m]) => !machine || m === machine)
    .flatMap(([m, folders]) => Object.entries(folders).map(([folder, path]) => ({ machine: m, folder, path })));
  if (!shown.length && !chosen.length) return null;
  return (
    <section data-setting="models.downloads" aria-label="Downloads" className="overflow-hidden rounded-card border border-line-strong bg-panel shadow-card">
      {shown.map((l, i) => (
        <div key={l.machine ?? "first"} className={cx(i > 0 && "border-t border-line-strong")}>
          <LineList line={l} full head={shown.length > 1 || lines.length > 1 ? `Downloads · on ${where(l.machine)}` : "Downloads"} />
        </div>
      ))}
      {!shown.length && <div className="border-b border-line px-4 py-2.5 font-bold text-ink-strong">Downloads <span className="ml-1.5 text-xs font-normal text-ink-2">nothing coming</span></div>}
      {chosen.length > 0 && (
        <div className={cx("flex flex-col", shown.length > 0 && "border-t border-line-strong")}>
          <div className={sec}>Places chosen{(settings?.machines.length ?? 0) > 1 ? "" : " on this ComfyUI"}</div>
          {chosen.map((c) => (
            <div key={`${c.machine}:${c.folder}`} className="flex items-center gap-2.5 px-4 py-2 text-xs">
              <span className="w-32 shrink-0 font-semibold text-ink">{c.folder}</span>
              <span className="min-w-0 grow truncate font-mono text-ink-2" data-tip={c.path}>→ {c.path}{(settings?.machines.length ?? 0) > 1 ? ` · on ${where(c.machine)}` : ""}</span>
              <button type="button" className="shrink-0 text-ink-2 hover:text-ink" disabled={reset.isPending} onClick={() => reset.mutate({ machine: c.machine, folder: c.folder })} data-tip="Downloads into this folder go to ComfyUI's own models folder again">Reset</button>
            </div>
          ))}
          <div className="h-1.5" />
        </div>
      )}
    </section>
  );
}

/** Each place's kind, in the menu. */
const KIND: Record<"own" | "older" | "other", string> = { own: "ComfyUI", older: "ComfyUI, older name", other: "extra_model_paths.yaml" };

/** Where each model folder's downloads go on the ComfyUI downloads go to here (DownloadTo; the first otherwise). */
export function usePlaces() {
  const machine = useContext(DownloadTo);
  return useQuery({ queryKey: queryKeys.downloadPlaces(machine), queryFn: ({ signal }) => api.downloadPlaces({ signal }, machine), staleTime: 60_000 });
}

/**
 * Where a folder's downloads go, said beside its Download ("→ models\loras"); when ComfyUI reads the folder from several
 * places, a menu of them all, the choice kept for that folder on that ComfyUI (card #59). Nothing for a ComfyUI that does
 * not say its folders.
 */
export function GoesTo({ folder, className }: { folder: string; className?: string }) {
  const machine = useContext(DownloadTo);
  const places = usePlaces();
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "download-place" });
  const [at, setAt] = useState<ReturnType<typeof menuAt> | null>(null);
  const set = useMutation({
    mutationFn: (path: string | null) => api.setDownloadPlace({ ...(machine ? { machine } : {}), folder, path }),
    onError: sayFailed("The place was not kept"),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.downloadPlaces() });
      void client.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
  const f = places.data?.folders[folder];
  if (!f?.goes) return null;
  const several = f.places.length > 1 && !f.fixed;
  const said = <span className="truncate font-mono">→ {f.goes}</span>;
  if (!several) {
    const tip = f.fixed && f.places.length > 1 ? "Where the file goes on disk. Downloads reach this ComfyUI through ComfyUI-Manager or an older Afflatus node pack, which cannot be told another of its places." : "Where the file goes on disk";
    return <span className={cx("inline-flex min-w-0 items-center text-xs text-ink-3", className)} data-tip={tip}>{said}</span>;
  }
  const current = f.chosen ?? f.places.find((p) => p.shown === f.goes)?.path;
  return (
    <>
      <button
        type="button"
        onClick={(e) => setAt(menuAt(e, e.currentTarget))}
        className={cx("inline-flex min-w-0 items-center gap-0.5 rounded-control text-xs text-ink-3 hover:text-ink", className)}
        data-tip={`ComfyUI reads ${folder} from ${f.places.length} places: choose where downloads go. Kept for ${folder} on this ComfyUI (Settings › Models).`}
      >
        {said}
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {at && (
        <ContextMenu
          at={at}
          label={`Where ${folder} downloads go`}
          head={{ title: `${folder} downloads go to`, sub: f.chosen ? "chosen" : "ComfyUI's own folder first" }}
          items={[
            ...f.places.map((p) => ({
              label: p.shown,
              note: p.ok === false ? `${KIND[p.kind]} · cannot be written` : KIND[p.kind],
              checked: p.path === current,
              disabled: p.ok === false,
              run: () => set.mutate(p.kind === "own" && !f.chosen ? null : p.path),
            })),
            ...(f.chosen ? ["—" as const, { label: "Back to ComfyUI's own folder", run: () => set.mutate(null) }] : []),
          ]}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}

/**
 * One file's download, where its Download shows (card #60): In line · 3rd (and the time before it starts), Downloading
 * 38 % · 4 min with a thin bar, Here · models\loras once done; ✕ cancels. Never a second Download while it comes. Null for
 * a file with no download, or one that failed or was stopped (its Download shows again, with why).
 */
export function FileState({ d }: { d: Download | undefined }) {
  const { lines } = useLines();
  const ops = useLineOps();
  if (!d || !(coming(d) || d.status === "done")) return null;
  const tag = "relative inline-flex h-7 items-center overflow-hidden rounded-control border px-2.5 text-xs font-semibold whitespace-nowrap";
  if (d.status === "done") {
    return <span className={cx(tag, "border-good/35 bg-good/10 text-good")} data-tip={d.into ?? d.folder}>Here · {d.shown ?? d.folder}</span>;
  }
  const line = lineOfFile(lines, d);
  const cancel = <CloseButton size={24} label={`Cancel ${nameOf(d)}`} tip={inLine(d) ? "Take it out of the line" : "Cancel it: nothing is kept of it"} onClose={() => ops.stop.mutate(d.id)} />;
  if (inLine(d)) {
    const wait = line ? startsIn(line, d) : null;
    return (
      <span className="inline-flex items-center gap-1">
        <span className={cx(tag, "border-accent/35 bg-accent/10 text-accent")} data-tip={`Waiting its turn, ${d.waiting}`}>In line{d.turn ? ` · ${ordinal(d.turn)}` : ""}{wait ? ` · ${est(wait)}` : ""}</span>
        {cancel}
      </span>
    );
  }
  const part = d.total ? Math.min(1, d.bytes / d.total) : 0;
  const left = d.rate && d.total > d.bytes ? msFor(d.total - d.bytes, d.rate) : null;
  const words = d.status === "saving" ? "Saving…" : d.status === "starting" ? "Starting…" : `Downloading${d.total ? ` ${Math.floor(part * 100)} %` : ` ${size(d.bytes)}`}${left ? ` · ${leftWords(left)}` : ""}`;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cx(tag, "border-line-strong bg-raised text-ink")} data-tip={`into ${d.into ?? d.folder}`}>
        {words}
        <i aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-accent" style={{ width: `${(d.status === "saving" ? 1 : part) * 100}%` }} />
      </span>
      {d.status !== "saving" && cancel}
    </span>
  );
}
