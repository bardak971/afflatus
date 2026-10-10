import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, X } from "lucide-react";
import type { Job } from "./api";
import { useQueue } from "./data";
import { useDownloads } from "./useGetFile";
import { moves } from "./leave";
import { Kbd } from "./Keys";
import { OUT_MS } from "./motion";
import { useBanners, useHandover, useNotify, type Banner } from "./store";
import { cx } from "./ui";
import { askViewer, passFrom } from "./viewer/ask";
import { queryKeys } from "./queryKeys";

/**
 * A finished render is only announced where its result does not show up by itself (the Queue lists it as it ends). The
 * Studio announces it, form open (/create) or not: the owner keeps those (E16), only without "Open library" there.
 */
const showsResults = (path: string) => path === "/queue" || path.startsWith("/timelines/");

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
 * The banners drawn: those up, and those just taken away (gone by themselves, closed, clicked) for the length of their
 * exit, each in the place it had: the ones under it move up once it has faded. Nothing waits on it, the banner is out of
 * the store at once and its copy takes no click (m-out, inert).
 */
function useLeaving(items: Banner[]): Array<{ b: Banner; leaving: boolean }> {
  const [gone, setGone] = useState<Array<{ b: Banner; at: number }>>([]);
  const before = useRef(items);
  useLayoutEffect(() => {
    const was = before.current;
    before.current = items;
    if (!moves()) return;
    const left = was.flatMap((b, at) => (items.some((x) => x.id === b.id) ? [] : [{ b, at }]));
    if (!left.length) return;
    setGone((g) => [...g.filter((x) => !left.some((l) => l.b.id === x.b.id)), ...left]);
    setTimeout(() => setGone((g) => g.filter((x) => !left.includes(x))), OUT_MS);
  }, [items]);
  const out = items.map((b) => ({ b, leaving: false }));
  // one said again while it was fading (the same id) is simply up again
  for (const { b, at } of [...gone].sort((x, y) => x.at - y.at)) if (!items.some((x) => x.id === b.id)) out.splice(Math.min(at, out.length), 0, { b, leaving: true });
  return out;
}

/**
 * What failed or finished, said on whatever screen is open: a render that failed (it stays until it is
 * closed), a render or a download that finished (it goes by itself). A click leads to where it is.
 */
export function Banners() {
  const { items, push, dismiss } = useBanners();
  const [path, go] = useLocation();
  const queue = useQueue();
  const client = useQueryClient();
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
        else {
          // a pass of an item: the item's details are read again (what was made from it is in them, for Compare)
          const from = passFrom.get(j.id);
          if (from) void client.invalidateQueries({ queryKey: queryKeys.assets.one(from) });
          if (showsResults(path)) continue;
          // switched off in Settings › Interface: what finished is not announced (a failure still is, below)
          if (!useNotify.getState().banner) continue;
          const f = folds.current.done;
          add(f, j);
          const allExports = f.exports === f.count;
          // on the library itself what was made is already in sight: nowhere to send it
          const there = allExports ? path === "/timelines" : path === "/" || path === "/create";
          // one pass done: Compare puts the item and what it made side by side (the viewer opens on the item, Compare asked)
          const compare = f.count === 1 && from ? { action: { label: "Compare", run: () => {
            askViewer(from, "compare");
            useHandover.getState().set({ show: from });
            if (path !== "/" && path !== "/create") go("/");
          } } } : {};
          push({ id: "jobs:done", tone: "good", title: foldTitle(f, "done"), text: foldText(f), ...compare, ...(there || compare.action ? {} : allExports ? { href: "/timelines", go: "Open timelines" } : { href: "/", go: "Open library" }) });
        }
      }
    }
    seenJobs.current = new Set(over.map((j) => j.id));
  }, [queue.data, push, path, client, go]);

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

  // Ctrl+Z undoes what the newest banner with an Undo said was done, but where Ctrl+Z is the screen's own (the timeline
  // editor's history, a dialog such as the mask painter) or the cursor is in a field, whose own undo it is
  const undoable = [...items].reverse().find((b) => b.action?.undo);
  useEffect(() => {
    if (!undoable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("[role=dialog][aria-modal=true]") || path.startsWith("/timelines/")) return;
      e.preventDefault();
      dismiss(undoable.id);
      undoable.action!.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoable, dismiss, path]);

  const drawn = useLeaving(items);
  if (!drawn.length) return null;
  return (
    // top centre, under the screens' headers: over the stage's or the player's empty top, never over a header's
    // controls (as it was at the very top) nor the stage's action bar and the status bar at the foot
    <div className="pointer-events-none fixed top-16 left-1/2 z-[65] flex w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-2">
      {drawn.map(({ b, leaving }) => {
        const said = (
          <>
            <span className="font-semibold break-words">{b.title}</span>
            {b.text && <span className="line-clamp-3 text-xs break-words">{b.text}</span>}
            {b.go && <span className="text-xs font-semibold underline">{b.go}</span>}
          </>
        );
        return (
        <div key={b.id} role={b.tone === "bad" ? "alert" : "status"} inert={leaving} className={cx(leaving ? "m-out" : "m-toast", "pointer-events-auto flex items-start gap-2.5 rounded-xl border py-2.5 pr-2 pl-3.5 shadow-2xl", b.tone === "bad" ? "border-warn bg-warn-wash text-warn-ink" : "border-line-strong bg-panel")}>
          <span className="pt-0.5">{b.tone === "bad" ? <AlertTriangle size={16} /> : <Check size={16} className="text-good" />}</span>
          {b.act || b.href ? (
            <button
              type="button"
              onClick={() => {
                dismiss(b.id);
                if (b.act) b.act();
                else if (b.href) go(b.href);
              }}
              className="flex min-w-0 grow flex-col gap-0.5 text-left"
            >
              {said}
            </button>
          ) : (
            <div className="flex min-w-0 grow flex-col gap-0.5 pt-px">{said}</div>
          )}
          {b.action && (
            <button
              type="button"
              onClick={() => {
                dismiss(b.id);
                b.action!.run();
              }}
              className="flex h-7 shrink-0 items-center gap-1.5 self-center rounded-md border border-line-strong px-2.5 text-xs font-semibold hover:bg-hover"
            >
              {b.action.label} {b.action.key && <Kbd>{b.action.key}</Kbd>}
            </button>
          )}
          <button type="button" aria-label="Close" onClick={() => dismiss(b.id)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-hover"><X size={14} /></button>
        </div>
        );
      })}
    </div>
  );
}
