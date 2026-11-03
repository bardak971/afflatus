import { lazy, Suspense, useMemo, useRef, useState } from "react";
import type { Download } from "./api";
import { useSettings } from "./data";
import { linesOf, type Line } from "./downloadLine";
import { fileLabel } from "./format";
import { useNow } from "./hooks";
import { useDownloads } from "./useGetFile";

// the line itself (its lists, menus and drag, DownloadsLine.tsx) is a chunk of its own, fetched the first time the chip is
// opened: in the status bar of every page, it came with the first load (card #246)
const DownloadsPopover = lazy(() => import("./DownloadsLine").then((m) => ({ default: m.DownloadsPopover })));

/** Every ComfyUI's line, read again every half minute for "today" and the times. */
export function useLines() {
  const items = useDownloads().data?.items;
  const settings = useSettings().data;
  const first = settings?.machines[0]?.id;
  const now = useNow(30_000);
  const lines = useMemo(() => linesOf(items ?? [], first, now), [items, first, now]);
  return { lines, first };
}

/** What is under way and still fetching: one whole, ComfyUI listing it, is shown but not counted. */
export const fetching = (line: Line) => line.under.filter((d) => d.status !== "saving");

/** The file's name, without its sub-folders. */
export const nameOf = (d: Download) => fileLabel(d.file);

/**
 * The status bar's chip: "2 ↓ · 8 waiting" with a ring of the first file's share (one file alone: its name and share), and
 * the line as a popover, one group per ComfyUI with several. Nothing while nothing comes.
 */
export function DownloadsChip() {
  const { lines } = useLines();
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
        className="inline-flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-chip border border-accent bg-raised px-2 text-xs text-ink hover:bg-hover"
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
        <Suspense fallback={null}>
          <DownloadsPopover anchor={anchor} busy={busy} rows={under.length + next.length} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
