import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, Check, X } from "lucide-react";
import type { Job } from "./api";
import { useQueue } from "./data";
import { useDownloads } from "./GetFile";
import { useBanners } from "./store";
import { cx } from "./ui";

/** A finished render is only announced where its result does not show up by itself (the Queue lists it as it ends). */
const showsResults = (path: string) => path === "/create" || path === "/queue" || path.startsWith("/timelines/");

/** What ended while its banner is up, folded into it: a batch says "8 done" once, not eight times. */
interface Fold {
  count: number;
  labels: Set<string>;
  exports: number;
  last: string | null;
}
const noFold = (): Fold => ({ count: 0, labels: new Set(), exports: 0, last: null });
/** "Portrait done", "8 done", "8 done · Portrait" (one name for the whole batch). */
const foldTitle = (f: Fold, word: string) => (f.count === 1 ? `${[...f.labels][0]} ${word}` : `${f.count} ${word}`);
const foldText = (f: Fold) => (f.count > 1 && f.labels.size === 1 ? [...f.labels][0] : f.count > 1 ? `Last: ${f.last}` : undefined);

/**
 * What failed or finished, said on whatever screen is open: a render that failed (it stays until it is
 * closed), a render or a download that finished (it goes by itself). A click leads to where it is.
 */
export function Banners() {
  const { items, push, dismiss } = useBanners();
  const [path, go] = useLocation();
  const queue = useQueue();
  const downloads = useDownloads();
  // what was already finished when the page opened is old news
  const seenJobs = useRef<Set<string> | null>(null);
  const seenDownloads = useRef<Map<string, string> | null>(null);
  const folds = useRef({ done: noFold(), failed: noFold() });

  useEffect(() => {
    const recent = queue.data?.recent;
    if (!recent) return;
    const over = recent.filter((j) => j.status === "done" || j.status === "failed");
    if (seenJobs.current) {
      // a fold whose banner was closed (or went by itself) starts again from nothing
      const up = new Set(useBanners.getState().items.map((b) => b.id));
      if (!up.has("jobs:done")) folds.current.done = noFold();
      if (!up.has("jobs:failed")) folds.current.failed = noFold();
      const add = (f: Fold, j: Job) => {
        f.count++;
        f.labels.add(j.label);
        f.last = j.label;
        if (j.kind === "export") f.exports++;
      };
      for (const j of over) {
        if (seenJobs.current.has(j.id)) continue;
        if (j.status === "failed") {
          const f = folds.current.failed;
          add(f, j);
          // one failure says its error; several send to the Queue, where each one's is
          push({ id: "jobs:failed", tone: "bad", title: foldTitle(f, "failed"), text: f.count === 1 ? j.error ?? undefined : foldText(f), href: "/queue", go: "Open queue" });
        }
        // a model loaded ahead has nothing to show: the form says it is loaded
        else if (j.kind === "load") continue;
        else if (!showsResults(path)) {
          const f = folds.current.done;
          add(f, j);
          const allExports = f.exports === f.count;
          push({ id: "jobs:done", tone: "good", title: foldTitle(f, "done"), text: foldText(f), href: allExports ? "/timelines" : "/", go: allExports ? "Open timelines" : "Open library" });
        }
      }
    }
    seenJobs.current = new Set(over.map((j) => j.id));
  }, [queue.data, push, path]);

  useEffect(() => {
    const list = downloads.data?.items;
    if (!list) return;
    for (const d of list) {
      // once the page is open, every change of state; at first, only what failed (the server lists failures of the last hour only, so it is news)
      if (seenDownloads.current ? seenDownloads.current.get(d.id) === d.status : d.status !== "error") continue;
      const name = d.file.split(/[\\/]/).pop() ?? d.file;
      if (d.status === "done") push({ id: `download:${d.id}`, tone: "good", title: `${name} installed in ComfyUI`, href: "/settings/models", go: "Open settings" });
      if (d.status === "error") push({ id: `download:${d.id}`, tone: "bad", title: `Download of ${name} failed`, text: d.error, href: "/settings", go: "Open settings" });
    }
    seenDownloads.current = new Map(list.map((d) => [d.id, d.status]));
  }, [downloads.data, push]);

  // good news goes by itself; bad news waits to be read
  useEffect(() => {
    const good = items.filter((b) => b.tone === "good");
    if (!good.length) return;
    const t = setTimeout(() => dismiss(good[0]!.id), 6000);
    return () => clearTimeout(t);
  }, [items, dismiss]);

  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed top-3 left-1/2 z-[65] flex w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2">
      {items.map((b) => (
        <div key={b.id} role={b.tone === "bad" ? "alert" : "status"} className={cx("pointer-events-auto flex items-start gap-2.5 rounded-xl border py-2.5 pr-2 pl-3.5 shadow-2xl", b.tone === "bad" ? "border-warn bg-warn-wash text-warn-ink" : "border-line-strong bg-panel")}>
          <span className="pt-0.5">{b.tone === "bad" ? <AlertTriangle size={16} /> : <Check size={16} className="text-good" />}</span>
          <button
            type="button"
            onClick={() => {
              dismiss(b.id);
              if (b.act) b.act();
              else go(b.href);
            }}
            className="flex min-w-0 grow flex-col gap-0.5 text-left"
          >
            <span className="font-semibold break-words">{b.title}</span>
            {b.text && <span className="line-clamp-3 text-xs break-words">{b.text}</span>}
            <span className="text-xs font-semibold underline">{b.go}</span>
          </button>
          <button type="button" aria-label="Close" onClick={() => dismiss(b.id)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-hover"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
