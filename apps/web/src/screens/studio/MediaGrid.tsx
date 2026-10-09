import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { api, type Asset } from "../../api";
import { useProject } from "../../project";
import { ask } from "../../Confirm";
import { cx, ErrorNote } from "../../ui";
import { binRange, justify, leftOf } from "../library/justify";

/** The height a row aims for, by the display's size; the gap between tiles. */
export const ROW_HEIGHT = { S: 140, M: 210, L: 310 } as const;
const GAP = 8;

/** One place in the rows: a tile at a shape (width over height), drawn when its row is. */
export interface Placed {
  key: string;
  aspect: number;
  render(): ReactNode;
}

/**
 * Tiles in justified rows (justify.ts): each at its item's own shape, every row as high as the others and
 * as wide as the grid; the last row, not full, at the target height. In the list's order, row after row,
 * so Tab and the screen readers go through them as before.
 */
export function JustifiedRows({ places, rowHeight, className, under = 0 }: {
  places: Placed[];
  rowHeight: number;
  className?: string;
  /** Room under every tile, in pixels, for a line its render draws there (the media shelf's captions); the shapes are the tiles' own. */
  under?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const seen = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const shapes = places.map((p) => p.aspect).join();
  // where each tile goes: worked out again only when the shapes, the width or the size change
  const laid = useMemo(() => {
    const rows = justify(places.map((p) => p.aspect), width, rowHeight, GAP);
    const at: Array<{ left: number; top: number; width: number; height: number }> = [];
    let top = 0;
    for (const r of rows) {
      let left = 0;
      for (const w of r.widths) {
        at.push({ left, top, width: w, height: r.height + under });
        left += w + GAP;
      }
      top += r.height + under + GAP;
    }
    return { at, height: Math.max(0, top - GAP) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, width, rowHeight, under]);
  // one box, every tile placed in it: a tile keeps its element when a new item pushes it to another row (no image read again)
  return (
    <div ref={box} className={cx("relative min-w-0", className)} style={{ height: laid.height }}>
      {places.map((p, i) => {
        const at = laid.at[i];
        return at ? <div key={p.key} className="absolute" style={at}>{p.render()}</div> : null;
      })}
    </div>
  );
}

/** Beyond this many, Keep all asks first. */
const ASK_OVER = 20;

/**
 * The items of the view that nobody kept, said once above the grid rather than on every tile: how many,
 * when they go to the bin, Keep all (those shown), and Show only these. Each tile has only a small clock.
 */
export function NotKeptLine({ items, filter, whole, only, onOnly }: {
  /** What the grid shows now (the pages read). */
  items: Asset[];
  /** The view's filter, and whether the grid has pages it has not read: then the items not kept are asked for across the whole view. */
  filter: Parameters<typeof api.assets>[0];
  whole: boolean;
  /** Only the items not kept are shown (the filter this line turns on). */
  only: boolean;
  onOnly(on: boolean): void;
}) {
  const project = useProject((s) => s.id);
  const view = { ...filter, kept: undefined, unkept: true, after: undefined, before: undefined };
  // across the whole view, summed up by the server (how many, when they go); under the "assets" key: a "library"
  // event reads it again, as it reads the grid
  const all = useQuery({
    queryKey: ["assets", "unkept", project, filter],
    queryFn: ({ signal }) => api.unkept(view, false, { signal }),
    enabled: whole && !filter.kept,
  });
  const shown = items.filter((a) => !a.kept && !a.inBin);
  const summed = whole && all.data ? all.data : null;
  const count = summed ? summed.count : shown.length;
  const client = useQueryClient();
  const keep = useMutation({
    // the ids across the view asked for only now; a few hundred at a time, as the server takes them
    mutationFn: async (across: boolean) => {
      const ids = across ? (await api.unkept(view, true)).ids ?? [] : shown.map((a) => a.id);
      for (let i = 0; i < ids.length; i += 500) await api.bulkAssets(ids.slice(i, i + 500), "keep");
    },
    onSuccess: () => {
      // nothing is left to show only: the whole view comes back
      onOnly(false);
      return client.invalidateQueries({ queryKey: ["assets"] });
    },
  });
  if (!count && !only) return null;
  const keepAll = async () => {
    if (count > ASK_OVER && !(await ask({ title: `Keep all ${count}?`, text: `The ${count} items not kept in this view stay until you bin them. Unkeep any of them later to put it back on its day.`, yes: `Keep ${count}` }))) return;
    keep.mutate(Boolean(summed));
  };
  const range = summed
    ? binRange([summed.from, summed.to].flatMap((at) => (at ? [leftOf({ countdownFrom: null, createdAt: at })] : [])))
    : binRange(shown.map((a) => leftOf(a)));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2 text-sm">
      <Clock size={15} className="shrink-0 text-warn" aria-hidden />
      {count ? (
        <span>
          <span className="font-bold">{count} not kept</span>
          <span className="text-ink-2"> · they go to the bin in {range}</span>
        </span>
      ) : (
        <span className="text-ink-2">Nothing here is waiting to go to the bin.</span>
      )}
      <span className="grow" />
      {keep.isError && <ErrorNote>{keep.error.message}</ErrorNote>}
      {count > 0 && (
        <button type="button" disabled={keep.isPending} onClick={() => void keepAll()} data-tip="Keep every item of this view that is not kept: they stay until you bin them" className="h-7 rounded-lg bg-warn px-3 text-xs font-bold text-warn-on hover:brightness-110 disabled:opacity-45">
          {keep.isPending ? "Keeping…" : "Keep all"}
        </button>
      )}
      <button type="button" aria-pressed={only} onClick={() => onOnly(!only)} className={cx("h-7 rounded-lg border px-3 text-xs", only ? "border-accent text-accent" : "border-line-strong text-ink hover:bg-hover")}>
        {only ? "Show everything" : "Show only these"}
      </button>
    </div>
  );
}
