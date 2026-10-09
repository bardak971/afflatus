import { describe, expect, it } from "vitest";
import { bar, brushWindow, ceiling, curve, stackSeries, statOf } from "../src/screens/queue/chartMath";
import { byModel, dropped, modelSwitches, moved } from "../src/screens/queue/order";
import { brushSpan } from "../src/screens/queue/useBrush";
import { presetOf, typedWindow } from "../src/screens/queue/useTimesView";
import { windowOf } from "../src/data";

describe("the charts' arithmetic", () => {
  it("rounds the top of the scale up to a figure that says something", () => {
    expect(ceiling(0)).toBe(1);
    expect(ceiling(-3)).toBe(1);
    expect(ceiling(7)).toBe(8);
    expect(ceiling(110)).toBe(150);
    expect(ceiling(1000)).toBe(1000);
    expect(ceiling(0.23)).toBeCloseTo(0.25);
  });
  it("draws straight lines through two points and a curve through more, never past the points", () => {
    expect(curve([])).toBe("");
    expect(curve([[0, 0], [10, 5]])).toBe("M0.0,0.0L10.0,5.0");
    const d = curve([[0, 10], [10, 0], [20, 10]]);
    expect(d.startsWith("M0.0,10.0C")).toBe(true);
    // the turning point is flat: its control points stay at its height
    expect(d).toContain(" 10.0,0.0C");
    for (const y of [...d.matchAll(/,(-?\d+\.\d)/g)].map((m) => Number(m[1]))) expect(y).toBeGreaterThanOrEqual(0);
  });
  it("says a series by its mean, sum, last or highest value, over the stretches that have one", () => {
    expect(statOf([1, null, 3], "mean")).toBe(2);
    expect(statOf([1, null, 3], "sum")).toBe(4);
    expect(statOf([1, 3, null], "last")).toBe(3);
    expect(statOf([1, 5, 3], "max")).toBe(5);
    expect(statOf([null, null], "mean")).toBeNull();
  });
  it("stacks each series on the ones before it, and leaves them alone otherwise", () => {
    const s = stackSeries([{ values: [1, 2] }, { values: [3, null] }], 2, true);
    expect(s[1]!.low).toEqual([1, 2]);
    expect(s[1]!.high).toEqual([4, 2]);
    const flat = stackSeries([{ values: [1, 2] }, { values: [3, null] }], 2, false);
    expect(flat[1]!.high).toEqual([3, null]);
  });
  it("turns a drag into the window of the stretches it touches", () => {
    const times = [0, 100, 200, 300, 400];
    // the plot from 0 to 400 pixels: a pixel per unit of time
    expect(brushWindow(110, 290, { left: 0, width: 400 }, times)).toEqual({ from: 100, to: 300 });
    // within one stretch: that stretch
    expect(brushWindow(120, 130, { left: 0, width: 400 }, times)).toEqual({ from: 100, to: 200 });
    // never past the end of the last stretch
    expect(brushWindow(350, 900, { left: 0, width: 400 }, times, 100)).toEqual({ from: 300, to: 400 });
    expect(brushWindow(0, 50, { left: 0, width: 400 }, [0])).toBeNull();
  });
  it("takes a drag across bars for the bars it touches, whole", () => {
    // four bars of 100 px each: the 2nd to the 3rd
    const times = [0, 100, 200, 300];
    expect(brushWindow(110, 290, { left: 0, width: 400 }, times, undefined, true)).toEqual({ from: 100, to: 300 });
    // within one bar: that stretch
    expect(brushWindow(120, 130, { left: 0, width: 400 }, times, undefined, true)).toEqual({ from: 100, to: 200 });
    expect(brushWindow(350, 900, { left: 0, width: 400 }, times, 100, true)).toEqual({ from: 300, to: 400 });
  });
  it("draws a bar with its top corners rounded, less when it is too short for them", () => {
    expect(bar(0, 10, 50, 50, 3)).toBe("");
    expect(bar(0, 10, 50, 20, 0)).toBe("M0.0,50.0V20.0H10.0V50.0Z");
    expect(bar(0, 10, 50, 20, 3)).toBe("M0.0,50.0V23.0Q0.0,20.0 3.0,20.0H7.0Q10.0,20.0 10.0,23.0V50.0Z");
    expect(bar(0, 10, 50, 49, 3)).toContain("V50.0Q0.0,49.0 1.0,49.0H9.0");
  });
  it("takes a short drag for a click", () => {
    expect(brushSpan(null)).toBeNull();
    expect(brushSpan({ x0: 10, x1: 14 })).toBeNull();
    expect(brushSpan({ x0: 40, x1: 10 })).toEqual([10, 40]);
  });
});

describe("the waiting jobs' order", () => {
  it("moves a job to a place, counted without it", () => {
    expect(moved(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
  });
  it("drops a dragged job before the one it was let go on", () => {
    expect(dropped(["a", "b", "c"], "a", 2)).toEqual(["b", "a", "c"]);
    expect(dropped(["a", "b", "c"], "a", 3)).toEqual(["b", "c", "a"]);
    expect(dropped(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });
  it("counts the model loads down the line of renders, not the exports between them", () => {
    expect(modelSwitches([{ kind: "render", recipe: "x" }, { kind: "export", recipe: "e" }, { kind: "render", recipe: "x" }, { kind: "render", recipe: "y" }])).toBe(1);
    expect(modelSwitches([])).toBe(0);
  });
  it("groups the waiting jobs by model, the first job's model first, each model's jobs in their order", () => {
    const w = (id: string, recipe: string, kind: "render" | "export" | "load" | "cut" = "render") => ({ id, recipe, kind });
    expect(byModel([w("a", "x"), w("b", "y"), w("c", "x"), w("d", "y"), w("e", "z")])).toEqual(["a", "c", "b", "d", "e"]);
    // a load goes with its model; an export stays a group of its own, where it first came
    expect(byModel([w("l", "y", "load"), w("a", "x"), w("e", "t", "export"), w("b", "y"), w("c", "x")])).toEqual(["l", "b", "a", "c", "e"]);
    expect(modelSwitches(byModel([w("a", "x"), w("b", "y"), w("c", "x")]).map((id) => ({ kind: "render" as const, recipe: id === "b" ? "y" : "x" })))).toBe(1);
    expect(byModel([])).toEqual([]);
  });
});

describe("the render times' window", () => {
  it("works a preset out when it is read, so that it still ends now", () => {
    expect(windowOf({ preset: "1H", ms: 3_600_000 }, 10_000_000)).toEqual({ from: 6_400_000, to: 10_000_000 });
    expect(windowOf({ preset: "All", ms: null }, 5)).toBe("all");
    expect(windowOf({ from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
    expect(presetOf("nope").label).toBe("7D");
  });
  it("applies a typed window only when it is one", () => {
    expect(typedWindow(null)).toBeNull();
    expect(typedWindow({ from: "2026-10-01T10:00", to: "2026-10-01T09:00" })).toBeNull();
    expect(typedWindow({ from: "x", to: "2026-10-01T09:00" })).toBeNull();
    const w = typedWindow({ from: "2026-10-01T09:00", to: "2026-10-01T10:00" })!;
    expect(w.to - w.from).toBe(3_600_000);
  });
});
