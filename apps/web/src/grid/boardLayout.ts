import { create } from "zustand";
import type { Asset, GridView } from "../api";

/** Which grid's board a draft's Stage shows (card #21), by draft; none: the Stage shows its results as usual. */
export const useGridBoard = create<{ of: Record<string, string>; show(draft: string, grid: string): void; close(draft: string): void }>((set) => ({
  of: {},
  show: (draft, grid) => set((s) => ({ of: { ...s.of, [draft]: grid } })),
  close: (draft) => set((s) => {
    const { [draft]: _gone, ...rest } = s.of;
    return { of: rest };
  }),
}));

/** What one place of a board holds: the cell's picture, its render under way or waiting, a failure, or nothing left. */
export type BoardCell =
  | { state: "done"; asset: Asset }
  | { state: "running"; job: string }
  | { state: "waiting"; job: string }
  | { state: "failed"; job: string; error: string | null }
  | { state: "gone" };

/** A board's page laid out: its columns' and rows' labels, and each place, row by row. */
export interface BoardPage {
  /** X's values over the columns ([""] with no X axis), Y's left of the rows. */
  cols: string[];
  rows: string[];
  cells: BoardCell[][];
}

/** The cell's place as its key: "x.y.z". */
export const cellKey = (x: number, y: number, z: number) => `${x}.${y}.${z}`;

/**
 * Page `z` of a grid: each place its picture when one is in the library (the newest, a cell done again making a second),
 * else what its job says, else gone (dismissed from the queue, or its picture binned).
 */
export function boardPage(view: Pick<GridView, "axes" | "jobs">, items: readonly Asset[], z: number): BoardPage {
  const [x, y] = view.axes;
  const cols = x?.labels ?? [""];
  const rows = y?.labels ?? [""];
  const made = new Map<string, Asset>();
  for (const a of items) {
    if (!a.grid || a.inBin) continue;
    const key = cellKey(a.grid.x, a.grid.y, a.grid.z);
    const was = made.get(key);
    if (!was || a.createdAt > was.createdAt) made.set(key, a);
  }
  const cells = rows.map((_, r) =>
    cols.map((_, c): BoardCell => {
      const key = cellKey(c, r, z);
      const asset = made.get(key);
      if (asset) return { state: "done", asset };
      const job = view.jobs[key];
      if (!job) return { state: "gone" };
      if (job.status === "running") return { state: "running", job: job.id };
      if (job.status === "queued") return { state: "waiting", job: job.id };
      if (job.status === "failed") return { state: "failed", job: job.id, error: job.error };
      return { state: "gone" };
    }),
  );
  return { cols, rows, cells };
}

/** How many cells of the whole grid are done (a picture there), of how many. */
export function boardDone(view: Pick<GridView, "count">, items: readonly Asset[]): { done: number; of: number } {
  const places = new Set(items.filter((a) => a.grid && !a.inBin).map((a) => cellKey(a.grid!.x, a.grid!.y, a.grid!.z)));
  return { done: places.size, of: view.count };
}

/** Whether the board still waits for any of its cells: it is read again while it does. */
export const boardWaits = (view: Pick<GridView, "jobs"> | undefined) => Object.values(view?.jobs ?? {}).some((j) => j.status === "queued" || j.status === "running");

/**
 * What "Move the rest to the bin" takes: every cell of the grid not picked and not kept, on every page. Kept ones stay
 * (they were kept on purpose), and so do those picked.
 */
export const restOf = (items: readonly Asset[], picked: ReadonlySet<string>): string[] => items.filter((a) => a.grid && !a.inBin && !a.kept && !picked.has(a.id)).map((a) => a.id);

/** The pictures of a row or a column of a page, to pick them all at once by its label. */
export function lineOf(page: BoardPage, line: { row: number } | { col: number }): string[] {
  const cells = "row" in line ? page.cells[line.row] ?? [] : page.cells.map((r) => r[line.col]).filter((c): c is BoardCell => Boolean(c));
  return cells.flatMap((c) => (c.state === "done" ? [c.asset.id] : []));
}
