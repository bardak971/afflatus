import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { api, type Asset } from "../../api";
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
export function JustifiedRows({ places, rowHeight, className }: { places: Placed[]; rowHeight: number; className?: string }) {
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
        at.push({ left, top, width: w, height: r.height });
        left += w + GAP;
      }
      top += r.height + GAP;
    }
    return { at, height: Math.max(0, top - GAP) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, width, rowHeight]);
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
export function NotKeptLine({ items, only, onOnly }: {
  /** What the grid shows now (the pages read). */
  items: Asset[];
  /** Only the items not kept are shown (the filter this line turns on). */
  only: boolean;
  onOnly(on: boolean): void;
}) {
  const unkept = items.filter((a) => !a.kept && !a.inBin);
  const client = useQueryClient();
  const keep = useMutation({
    mutationFn: (ids: string[]) => api.bulkAssets(ids, "keep"),
    onSuccess: () => {
      // nothing is left to show only: the whole view comes back
      onOnly(false);
      return client.invalidateQueries({ queryKey: ["assets"] });
    },
  });
  if (!unkept.length && !only) return null;
  const keepAll = async () => {
    const ids = unkept.map((a) => a.id);
    if (ids.length > ASK_OVER && !(await ask({ title: `Keep all ${ids.length}?`, text: `The ${ids.length} items not kept in this view stay until you bin them. Unkeep any of them later to put it back on its day.`, yes: `Keep ${ids.length}` }))) return;
    keep.mutate(ids);
  };
  const range = binRange(unkept.map((a) => leftOf(a)));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-panel px-3.5 py-2 text-sm">
      <Clock size={15} className="shrink-0 text-warn" aria-hidden />
      {unkept.length ? (
        <span>
          <span className="font-bold">{unkept.length} not kept</span>
          <span className="text-ink-2"> · they go to the bin in {range}</span>
        </span>
      ) : (
        <span className="text-ink-2">Nothing here is waiting to go to the bin.</span>
      )}
      <span className="grow" />
      {keep.isError && <ErrorNote>{keep.error.message}</ErrorNote>}
      {unkept.length > 0 && (
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
