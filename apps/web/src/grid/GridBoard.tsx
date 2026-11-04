import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Star } from "lucide-react";
import { plural } from "@afflatus/core";
import { api, thumbUrl, type Asset, type RunningJob } from "../api";
import { useAssetChange } from "../assetChange";
import { useAssets } from "../data";
import { Keys } from "../Keys";
import { queryKeys } from "../queryKeys";
import { useQueueOf } from "../screens/studio/queueOf";
import { LiveTile } from "../screens/studio/LiveTile";
import { useSayFailed } from "../sayFailed";
import { useBanners } from "../store";
import { Button, CloseButton, cx, Failed, Help, IconButton } from "../ui";
import { askViewer } from "../viewer/ask";
import { Viewer } from "../viewer/LazyViewer";
import { boardDone, boardPage, boardWaits, cellKey, lineOf, restOf, type BoardCell } from "./boardLayout";

/** The width of the rows' labels, and the gap between cells (px). */
const LABEL_W = 112;
const GAP = 6;
/** A cell is never drawn narrower than this: a board of many columns scrolls rather than shrinking to dots. */
const LEAST_CELL = 72;

/**
 * An X/Y/Z grid on the Stage (card #21, the mock's 6b): its cells as one labelled board, X across, Y down, Z as pages, each
 * cell as it arrives (its render live while it runs). A click opens a cell as any picture; Ctrl/⌘ or Shift + click, or a
 * row's or column's label, picks; then Keep, Compare (two), Save as a picture (one labelled sheet of the page), or move
 * the rest to the bin. The cells are normal library items under the 24 h rule unless kept.
 */
export function GridBoard({ grid, draft, folder, onClose }: { grid: string; draft?: string; folder?: string; onClose(): void }) {
  const client = useQueryClient();
  const view = useQuery({
    queryKey: queryKeys.grids.one(grid),
    queryFn: ({ signal }) => api.grid(grid, { signal }),
    // read again while cells wait or run: each lands in its place as it ends
    refetchInterval: (q) => (boardWaits(q.state.data) ? 2_000 : false),
  });
  const list = useAssets({ grid, limit: 200 }, true);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // a cell that ended (its job left "running") brings its picture in: the library's list of the grid read again
  const ended = Object.values(view.data?.jobs ?? {}).filter((j) => j.status === "done").length;
  useEffect(() => {
    if (ended) void client.invalidateQueries({ queryKey: queryKeys.assets.lists() });
  }, [ended, client]);
  // the renders of this grid under way now, by their place (every machine's)
  const running = useQueueOf((q) => [q.running, ...(q.machines ?? []).map((m) => m.running)].filter((j): j is RunningJob => Boolean(j && j.grid?.id === grid)));
  const live = useMemo(() => new Map((running ?? []).map((j) => [j.grid!.cell, j])), [running]);
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Asset | null>(null);
  const change = useAssetChange();
  const say = useBanners((b) => b.push);
  const sayFailed = useSayFailed({ id: "grid-sheet", href: "/", go: "Open the Studio" });
  const sheet = useMutation({
    mutationFn: () => api.gridSheet(grid, page),
    onSuccess: (a) => {
      void client.invalidateQueries({ queryKey: queryKeys.assets.lists() });
      say({ id: `grid-sheet:${a.id}`, tone: "good", title: "Saved as a picture", text: `${a.name}, kept beside the cells.`, go: "Open it", act: () => setOpen(a) });
    },
    onError: sayFailed("The sheet was not saved"),
  });

  // a click that closes a list or a menu opened over the board (a field picker, a tile's menu) closes it alone: it never
  // opens or picks the cell under it. Read as the press starts, before the list's own handler takes it away
  const swallow = useRef(false);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const over = '[role="listbox"], [data-context-menu], [role="dialog"]';
      swallow.current = Boolean(document.querySelector(over)) && !(e.target as Element | null)?.closest?.(over);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, []);
  const once = () => {
    const was = swallow.current;
    swallow.current = false;
    return was;
  };

  // the board fits the Stage: each cell as large as both the width and the height let it, at the cells' own shape
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 800, h: 500 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setRoom({ w: el.clientWidth, h: el.clientHeight }));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const g = view.data;
  const pages = g?.axes[2]?.labels ?? [""];
  const at = Math.min(page, pages.length - 1);
  const laid = g ? boardPage(g, items, at) : null;
  const first = items.find((a) => a.width && a.height);
  const shape = first ? first.width! / first.height! : 1;
  const cols = laid?.cols.length ?? 1;
  const rows = laid?.rows.length ?? 1;
  // an axis kept only for its place (Y left empty under a Z) has no labels
  const labelW = g?.axes[1]?.field ? LABEL_W : 0;
  // the columns' labels: a value over its axis's name, two lines
  const headH = 46;
  const fitW = (room.w - labelW - GAP * cols) / cols;
  const fitH = ((room.h - headH - GAP * rows) / rows) * shape;
  const cell = Math.max(LEAST_CELL, Math.floor(Math.min(fitW, fitH)));
  const done = g ? boardDone(g, items) : { done: 0, of: 0 };

  const pageItems = (laid?.cells.flat() ?? []).flatMap((c) => (c.state === "done" ? [c.asset] : []));
  const toggle = (ids: string[]) =>
    setPicked((was) => {
      const next = new Set(was);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) if (all) next.delete(id); else next.add(id);
      return next;
    });
  const pickedItems = items.filter((a) => picked.has(a.id));
  const rest = restOf(items, picked);
  const keep = () => {
    if (pickedItems.length) void change({ kind: "keep", ids: pickedItems.map((a) => a.id), kept: true });
  };
  const binRest = () => {
    if (rest.length) void change({ kind: "bin", ids: rest });
  };
  const compare = () => {
    const [a, b] = pickedItems;
    if (!a || !b) return;
    askViewer(b.id, "compare", a);
    setOpen(b);
  };

  // K keeps the picked, Esc leaves the board (a cell open over it takes its own Esc first)
  const keys = useRef({ keep, onClose });
  keys.current = { keep, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || open || (e.target as Element | null)?.closest?.("input, textarea, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "Escape") keys.current.onClose();
      else if (e.key.toLowerCase() === "k" && !e.ctrlKey && !e.metaKey && !e.altKey) keys.current.keep();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onCell = (e: MouseEvent, c: BoardCell) => {
    if (once() || c.state !== "done") return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) toggle([c.asset.id]);
    else setOpen(c.asset);
  };
  const title = g ? g.axes.slice(0, 2).map((a) => a.label).filter(Boolean).join(" × ") || (g.axes[2]?.label ?? "Grid") : "Grid";

  return (
    <div data-grid-board className="flex min-h-0 grow flex-col gap-2">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2.5 text-sm">
        <span className="rounded-md bg-accent-wash px-1.5 py-0.5 text-meta font-bold tracking-label text-accent uppercase">Grid</span>
        <span className="min-w-0 truncate font-semibold" data-tip={title}>{title}</span>
        <span className="font-mono text-xs text-ink-2">{done.done} of {done.of} done</span>
        {pages.length > 1 && g?.axes[2] && (
          <span role="group" aria-label={`Z · ${g.axes[2].label}: the pages`} className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-ink-3">
            Z · {g.axes[2].label}
            {pages.map((p, i) => (
              <button key={i} type="button" aria-pressed={i === at} onClick={() => !once() && setPage(i)} className={cx("rounded-full border px-2 py-0.5 font-mono outline-none focus-visible:border-accent", i === at ? "border-accent bg-accent-wash text-accent" : "border-line-strong text-ink-2 hover:text-ink")}>
                {p}
              </button>
            ))}
          </span>
        )}
        <span className="grow" />
        <CloseButton size={28} label="Leave the board" tip="Back to the results (Esc)" onClose={onClose} />
      </div>
      {view.isError && <Failed what="The grid could not be read" error={view.error} />}
      <div ref={box} className="relative min-h-0 grow overflow-auto">
        {laid && (
          <div role="grid" aria-label={`Grid, ${title}`} className="mx-auto grid items-center" style={{ gap: GAP, width: "max-content", gridTemplateColumns: `${labelW ? `${labelW}px ` : ""}repeat(${cols}, ${cell}px)` }}>
            {labelW > 0 && <span />}
            {laid.cols.map((c, x) => (
              <LineLabel key={`c${x}`} axis={g?.axes[0]?.label} value={c} picked={lineOf(laid, { col: x }).length > 0 && lineOf(laid, { col: x }).every((id) => picked.has(id))} onPick={() => !once() && toggle(lineOf(laid, { col: x }))} />
            ))}
            {laid.rows.map((r, y) => [
              labelW > 0 && <LineLabel key={`r${y}`} axis={g?.axes[1]?.label} value={r} side picked={lineOf(laid, { row: y }).length > 0 && lineOf(laid, { row: y }).every((id) => picked.has(id))} onPick={() => !once() && toggle(lineOf(laid, { row: y }))} />,
              ...laid.cells[y]!.map((c, x) => (
                <Cell key={cellKey(x, y, at)} cell={c} live={live.get(cellKey(x, y, at)) ?? null} shape={shape} picked={c.state === "done" && picked.has(c.asset.id)} said={`${laid.cols[x]}${laid.rows[y] ? ` · ${laid.rows[y]}` : ""}`} onClick={(e) => onCell(e, c)} onTick={() => c.state === "done" && !once() && toggle([c.asset.id])} />
              )),
            ])}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" disabled={!pickedItems.length} onClick={keep} data-tip="Keep the picked cells: they stay past the day" data-tip-keys="K">
          <Star size={13} /> Keep the picked{pickedItems.length ? ` · ${pickedItems.length}` : ""} <Keys keys="K" size="sm" />
        </Button>
        <Button size="sm" disabled={pickedItems.length !== 2} onClick={compare} data-tip={pickedItems.length === 2 ? "The two picked side by side, zoomed together" : "Pick two cells to compare them"}>Compare the picked</Button>
        <Button size="sm" disabled={!pageItems.length || sheet.isPending} onClick={() => sheet.mutate()} data-tip="This page as one labelled sheet, saved as a new picture">
          {sheet.isPending ? "Saving…" : "Save as a picture"}
        </Button>
        <Help text="One labelled sheet of this page, like A1111's grid image: the values over the columns and beside the rows. It is saved as a new picture, kept, next to the cells." />
        <Button size="sm" disabled={!rest.length} onClick={binRest} data-tip={rest.length ? `${plural(rest.length, "cell")} not picked and not kept, on every page` : "Every cell is picked or kept"}>
          Move the rest to the bin{rest.length ? ` · ${rest.length}` : ""}
        </Button>
        <span className="grow" />
        <span className="text-meta text-ink-3">Click opens a cell · Ctrl+click or a label picks · unkept cells expire like any render</span>
      </div>
      {open && <Viewer asset={items.find((a) => a.id === open.id) ?? open} items={pageItems.some((a) => a.id === open.id) ? pageItems : [open]} onOpen={setOpen} onClose={() => setOpen(null)} into={{ draft, folder }} />}
    </div>
  );
}

/** A column's or a row's label: the axis's value, the axis under it; a click picks every cell of the line. */
function LineLabel({ axis, value, side, picked, onPick }: { axis?: string; value: string; side?: boolean; picked: boolean; onPick(): void }) {
  if (!axis) return <span />;
  return (
    <button type="button" onClick={onPick} aria-pressed={picked} data-tip={`Pick this ${side ? "row" : "column"}`} className={cx("flex min-w-0 flex-col rounded-lg px-1.5 py-1 text-xs font-bold outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]", side ? "items-end text-right" : "items-center text-center", picked ? "bg-accent-wash text-accent" : "text-ink hover:bg-hover")}>
      <span className="max-w-full truncate">{value}</span>
      <span className="max-w-full truncate text-meta font-normal text-ink-3">{axis}</span>
    </button>
  );
}

/** One place of the board: its picture, its render live, waiting, failed (why in its tip) or nothing left. */
function Cell({ cell, live, shape, picked, said, onClick, onTick }: { cell: BoardCell; live: RunningJob | null; shape: number; picked: boolean; said: string; onClick(e: MouseEvent): void; onTick(): void }) {
  const frame = "relative overflow-hidden rounded-md";
  if (live) return <div role="gridcell" aria-label={`${said}, rendering`} style={{ aspectRatio: shape }} className={frame}><LiveTile job={live} fill title={said} /></div>;
  if (cell.state !== "done") {
    const word = cell.state === "failed" ? "failed" : cell.state === "gone" ? "not here" : cell.state;
    const tip = cell.state === "failed" ? cell.error ?? "This cell failed: the others go on." : cell.state === "gone" ? "Binned, or taken off the queue before it rendered" : undefined;
    return (
      <div role="gridcell" aria-label={`${said}, ${word}`} data-tip={tip} style={{ aspectRatio: shape }} className={cx(frame, "flex items-center justify-center border border-dashed text-meta", cell.state === "failed" ? "border-warn text-warn-ink" : "border-line-strong text-ink-3")}>
        {word}
      </div>
    );
  }
  return (
    <div role="gridcell" aria-selected={picked} className={cx(frame, "group border-2", picked ? "border-accent" : "border-transparent")} style={{ aspectRatio: shape }}>
      <button type="button" onClick={onClick} aria-label={`${said}: open`} data-tip={said} className="absolute inset-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]">
        <img src={thumbUrl(cell.asset.id)} alt="" draggable={false} className="h-full w-full object-cover" />
      </button>
      {cell.asset.kept && <Star size={14} fill="currentColor" aria-label="kept" className="pointer-events-none absolute top-1 right-1 text-accent drop-shadow" />}
      <IconButton size={24} tone="outline" pressed={picked} onClick={onTick} label={picked ? `${said}: unpick` : `${said}: pick`} className={cx("absolute top-1 left-1 bg-ground/70 outline-none focus-visible:opacity-100", picked ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
        <Check size={12} />
      </IconButton>
    </div>
  );
}
