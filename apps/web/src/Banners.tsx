import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, Check, X } from "lucide-react";
import { useQueue } from "./data";
import { useDownloads } from "./GetFile";
import { useBanners } from "./store";
import { cx } from "./ui";

/** A finished render is only announced where its result does not show up by itself. */
const showsResults = (path: string) => path === "/create" || path.startsWith("/timelines/");

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

  useEffect(() => {
    const recent = queue.data?.recent;
    if (!recent) return;
    const over = recent.filter((j) => j.status === "done" || j.status === "failed");
    if (seenJobs.current) {
      for (const j of over) {
        if (seenJobs.current.has(j.id)) continue;
        if (j.status === "failed") push({ id: `job:${j.id}`, tone: "bad", title: `${j.label} failed`, text: j.error ?? undefined, href: "/queue", go: "Open the queue" });
        else if (!showsResults(path)) push({ id: `job:${j.id}`, tone: "good", title: `${j.label} is done`, href: j.kind === "export" ? "/timelines" : "/", go: j.kind === "export" ? "Open the timelines" : "Open the library" });
      }
    }
    seenJobs.current = new Set(over.map((j) => j.id));
  }, [queue.data, push, path]);

  useEffect(() => {
    const list = downloads.data?.items;
    if (!list) return;
    if (seenDownloads.current) {
      for (const d of list) {
        if (seenDownloads.current.get(d.id) === d.status) continue;
        const name = d.file.split(/[\\/]/).pop() ?? d.file;
        if (d.status === "done") push({ id: `download:${d.id}`, tone: "good", title: `${name} is in ComfyUI now`, href: "/settings", go: "Open Settings" });
        if (d.status === "error") push({ id: `download:${d.id}`, tone: "bad", title: `The download of ${name} failed`, text: d.error, href: "/settings", go: "Open Settings" });
      }
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
    <div className="pointer-events-none fixed right-4 bottom-14 z-[65] flex w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((b) => (
        <div key={b.id} role={b.tone === "bad" ? "alert" : "status"} className={cx("pointer-events-auto flex items-start gap-2.5 rounded-xl border py-2.5 pr-2 pl-3.5 shadow-2xl", b.tone === "bad" ? "border-warn bg-warn-wash text-warn-ink" : "border-line-strong bg-panel")}>
          <span className="pt-0.5">{b.tone === "bad" ? <AlertTriangle size={16} /> : <Check size={16} className="text-good" />}</span>
          <button
            type="button"
            onClick={() => {
              dismiss(b.id);
              go(b.href);
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
