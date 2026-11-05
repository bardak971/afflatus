import { describe, expect, it } from "vitest";
import type { Asset, GridView } from "../src/api";
import { boardDone, boardPage, boardWaits, lineOf, restOf } from "../src/grid/boardLayout";

/** X/Y/Z grids on the web (card #21): the board's layout, and what Keep and the bin take (what it costs is the server's plan: grids.ts planGrid). */
const view: GridView = {
  id: "g1", draftId: "d1", recipe: "sdxl.text-to-picture", count: 12, createdAt: "2026-11-04T10:00:00Z",
  axes: [{ field: "sr", label: "Prompt S/R", labels: ["red coat", "blue coat", "green coat"] }, { field: "seed", label: "Seed", labels: ["1", "2"] }, { field: "steps", label: "Steps", labels: ["20", "30"] }],
  jobs: { "0.0.0": { id: "j0", status: "done", error: null }, "1.0.0": { id: "j1", status: "running", error: null }, "2.0.0": { id: "j2", status: "queued", error: null }, "0.1.0": { id: "j3", status: "failed", error: "out of memory" } },
};
const cell = (id: string, x: number, y: number, z: number, over: Partial<Asset> = {}) => ({ id, kind: "image", kept: false, inBin: false, createdAt: "2026-11-04T10:01:00Z", grid: { id: "g1", x, y, z }, ...over }) as Asset;

describe("the board", () => {
  it("lays a page out: X's values over the columns, Y's beside the rows, each place as it stands", () => {
    const page = boardPage(view, [cell("a", 0, 0, 0), cell("b", 2, 1, 1)], 0);
    expect(page.cols).toEqual(["red coat", "blue coat", "green coat"]);
    expect(page.rows).toEqual(["1", "2"]);
    expect(page.cells[0]!.map((c) => c.state)).toEqual(["done", "running", "waiting"]);
    expect(page.cells[1]!.map((c) => c.state)).toEqual(["failed", "gone", "gone"]);
    expect(page.cells[1]![0]).toMatchObject({ error: "out of memory" });
    // the second page holds its own cell
    expect(boardPage(view, [cell("b", 2, 1, 1)], 1).cells[1]![2]).toMatchObject({ state: "done" });
  });

  it("takes a cell done again at its newest picture, and leaves a binned one out", () => {
    const page = boardPage(view, [cell("old", 0, 0, 0), cell("new", 0, 0, 0, { createdAt: "2026-11-04T11:00:00Z" }), cell("binned", 1, 0, 0, { inBin: true })], 0);
    expect(page.cells[0]![0]).toMatchObject({ asset: { id: "new" } });
    expect(page.cells[0]![1]!.state).toBe("running");
  });

  it("with one axis: one row, no row label", () => {
    const one = boardPage({ axes: [view.axes[0]!], jobs: {} }, [cell("a", 1, 0, 0)], 0);
    expect(one.rows).toEqual([""]);
    expect(one.cells[0]!.map((c) => c.state)).toEqual(["gone", "done", "gone"]);
  });

  it("picks a row or a column by its label: its pictures", () => {
    const page = boardPage(view, [cell("a", 0, 0, 0), cell("b", 0, 1, 0), cell("c", 1, 1, 0)], 0);
    expect(lineOf(page, { col: 0 })).toEqual(["a", "b"]);
    expect(lineOf(page, { row: 1 })).toEqual(["b", "c"]);
  });

  it("counts what is done and reads again while a cell waits or runs", () => {
    expect(boardDone(view, [cell("a", 0, 0, 0), cell("b", 0, 0, 0), cell("c", 1, 0, 1)])).toEqual({ done: 2, of: 12 });
    expect(boardWaits(view)).toBe(true);
    expect(boardWaits({ jobs: { "0.0.0": { id: "j", status: "done", error: null } } })).toBe(false);
  });

  it("moves to the bin the cells neither picked nor kept, on every page", () => {
    const items = [cell("a", 0, 0, 0), cell("b", 1, 0, 0, { kept: true }), cell("c", 2, 0, 1), cell("d", 0, 1, 1, { inBin: true })];
    expect(restOf(items, new Set(["a"]))).toEqual(["c"]);
    expect(restOf(items, new Set())).toEqual(["a", "c"]);
  });
});
