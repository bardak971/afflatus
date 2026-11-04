import { describe, expect, it } from "vitest";
import type { GridAxisValues } from "@afflatus/core";
import type { Asset, GridView, MachineState } from "../src/api";
import { boardDone, boardPage, boardWaits, lineOf, restOf } from "../src/grid/boardLayout";
import { planOf } from "../src/grid/gridPlan";

/** X/Y/Z grids on the web (card #21): the board's layout, what Keep and the bin take, and what the card says it costs. */
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

describe("what a grid will take, said before it is queued", () => {
  const axes = (n: number[]): GridAxisValues[] => n.map((k, i) => ({ field: ["cfg", "steps", "seed"][i]!, label: "", values: Array.from({ length: k }, (_, v) => (i === 1 ? [20, 30, 40][v] : v)), labels: [] }));
  const estimate = { ms: 12_000, loadMs: 2_000, on: null, loadOn: null, auto: null };
  const pod = { id: "pod-1", pace: 1, rented: { rate: 0.9 } } as unknown as MachineState;
  const pc = { id: "pc", pace: 1, rented: null } as unknown as MachineState;

  it("counts every combination and its time on this PC: one model load, then each render", () => {
    expect(planOf(axes([3, 3]).map((a, i) => (i === 1 ? { ...a, field: "x" } : a)), estimate, { machines: [] })).toMatchObject({ count: 9, said: "3 × 3 = 9 renders", ms: 2_000 + 9 * 10_000, pod: null });
  });

  it("scales the sampling by a steps axis against the form's steps", () => {
    // 20, 30, 40 against 30: the mean is the form's own, the time unchanged; against 15, twice the sampling
    expect(planOf(axes([1, 3]), estimate, { machines: [], steps: { id: "steps", base: 30 } }).ms).toBe(2_000 + 3 * 10_000);
    expect(planOf(axes([1, 3]), estimate, { machines: [], steps: { id: "steps", base: 15 } }).ms).toBe(2_000 + 3 * 20_000);
  });

  it("loads each model of a model axis once more", () => {
    expect(planOf([{ field: "ckpt", label: "", values: ["a", "b", "c"], labels: [] }], estimate, { machines: [], models: ["ckpt"] }).ms).toBe(3 * 2_000 + 3 * 10_000);
  });

  it("on a pod: its time and the money at its rate; at worst when Auto may give it to a pod", () => {
    const picked = planOf(axes([4]), estimate, { picked: pod, machines: [pc, pod] });
    expect(picked.pod).toEqual({ ms: 42_000, usd: (42_000 / 3_600_000) * 0.9 });
    expect(planOf(axes([4]), { ...estimate, auto: ["pc"] }, { machines: [pc, pod] }).pod).toBeNull();
    expect(planOf(axes([4]), { ...estimate, auto: ["pc", "pod-1"] }, { machines: [pc, pod] }).pod?.usd).toBeCloseTo(0.0105);
  });

  it("says the money cannot be told without the pod's rate or a forecast, never nothing", () => {
    const noRate = { ...pod, rented: { rate: null } } as unknown as MachineState;
    expect(planOf(axes([2]), estimate, { picked: noRate, machines: [noRate] }).pod).toEqual({ ms: 22_000, usd: null });
    expect(planOf(axes([2]), null, { picked: pod, machines: [pod] }).pod).toEqual({ ms: null, usd: null });
  });
});
