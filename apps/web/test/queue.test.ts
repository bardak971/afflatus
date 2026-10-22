import { describe, expect, it } from "vitest";
import { bar, brushWindow, ceiling, curve, stackSeries, statOf } from "../src/screens/queue/chartMath";
import { betterPlace, byModel, dropped, groupingSaves, loadsAt, modelSwitches, moved, waitingEnds } from "../src/screens/queue/order";
import { dayLabel, foldFailures, pinnedFailures, readableError, reasonOf, reasonsOf } from "../src/screens/queue/failures";
import { StepClock } from "../src/screens/queue/stepRate";
import { brushSpan } from "../src/screens/queue/useBrush";
import { chartPointLabel, chartTimeLabel, DAY, presetOf, stretchOf, typedWindow } from "../src/screens/queue/useTimesView";
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
    // from the running job's model: the first waiting render of another model is a switch
    expect(modelSwitches([{ kind: "render", recipe: "y" }], { kind: "render", recipe: "x" })).toBe(1);
    expect(modelSwitches([{ kind: "render", recipe: "x" }], { kind: "load", recipe: "x" })).toBe(0);
    expect(modelSwitches([{ kind: "render", recipe: "y" }], { kind: "export", recipe: "e" })).toBe(0);
  });
  it("marks the rows that load another model, as many as the switches it counts", () => {
    const line = [{ kind: "render" as const, recipe: "x" }, { kind: "export" as const, recipe: "e" }, { kind: "render" as const, recipe: "y" }, { kind: "render" as const, recipe: "y" }, { kind: "render" as const, recipe: "x" }];
    expect(loadsAt(line)).toEqual([null, null, "y", null, "x"]);
    // the running job counts as the one before the first waiting row
    expect(loadsAt(line, { kind: "render", recipe: "y" })).toEqual(["x", null, "y", null, "x"]);
    expect(loadsAt(line, { kind: "load", recipe: "x" })).toEqual([null, null, "y", null, "x"]);
    expect(loadsAt(line, { kind: "export", recipe: "e" })).toEqual([null, null, "y", null, "x"]);
    for (const from of [null, { kind: "render" as const, recipe: "y" }]) expect(loadsAt(line, from).filter(Boolean).length).toBe(modelSwitches(line, from));
    expect(loadsAt([])).toEqual([]);
  });
  it("groups the waiting jobs by model, the first job's model first, each model's jobs in their order", () => {
    const w = (id: string, recipe: string, kind: "render" | "export" | "load" | "cut" = "render") => ({ id, recipe, kind });
    expect(byModel([w("a", "x"), w("b", "y"), w("c", "x"), w("d", "y"), w("e", "z")])).toEqual(["a", "c", "b", "d", "e"]);
    // a load goes with its model; an export stays a group of its own, where it first came
    expect(byModel([w("l", "y", "load"), w("a", "x"), w("e", "t", "export"), w("b", "y"), w("c", "x")])).toEqual(["l", "b", "a", "c", "e"]);
    expect(modelSwitches(byModel([w("a", "x"), w("b", "y"), w("c", "x")]).map((id) => ({ kind: "render" as const, recipe: id === "b" ? "y" : "x" })))).toBe(1);
    expect(byModel([])).toEqual([]);
  });
  it("puts the running job's model first when it groups, so that it is not loaded again", () => {
    const w = (id: string, recipe: string) => ({ id, recipe, kind: "render" as const, label: id, status: "queued" as const });
    expect(byModel([w("a", "x"), w("b", "y"), w("c", "x")], { kind: "render", recipe: "y" })).toEqual(["b", "a", "c"]);
    // a running model nothing waits for changes nothing
    expect(byModel([w("a", "x"), w("b", "y")], { kind: "render", recipe: "z" })).toEqual(["a", "b"]);
    expect(groupingSaves([w("a", "x"), w("b", "y"), w("c", "x")], { kind: "render", recipe: "y" })).toBe(2);
    expect(groupingSaves([w("a", "x"), w("c", "x")], null)).toBe(0);
  });
  it("finds where one job saves loads: a picture between two video clips goes after the video jobs", () => {
    const w = (id: string, recipe: string) => ({ id, recipe, kind: "render" as const });
    const line = [w("v1", "h3"), w("p", "sdxl"), w("v2", "h3")];
    expect(betterPlace(line, "p", { kind: "render", recipe: "h3" })).toEqual({ to: 2, after: line[2], saves: 1 });
    expect(betterPlace(line, "p", null)).toEqual({ to: 2, after: line[2], saves: 1 });
    // already in the best place, or not a render: nothing offered
    expect(betterPlace([w("a", "x"), w("b", "x"), w("c", "y")], "c", null)).toBeNull();
    expect(betterPlace([{ id: "e", recipe: "e", kind: "export" as const }, w("a", "x")], "e", null)).toBeNull();
  });
});

describe("the running render's s/it", () => {
  it("measures seconds per step from the step changes, not from the step first seen mid-way", () => {
    const c = new StepClock();
    c.note("j", 3, 0);
    expect(c.rate("j")).toBeNull();
    c.note("j", 4, 1000);
    expect(c.rate("j")).toBeNull();
    c.note("j", 4, 1400);
    c.note("j", 5, 3000);
    expect(c.rate("j")).toBeCloseTo(2);
    // over the last 5 steps only
    for (let s = 6; s <= 12; s++) c.note("j", s, 3000 + (s - 5) * 500);
    expect(c.rate("j")).toBeCloseTo(0.5);
    // several steps in one event count as what they are
    c.note("j", 16, 3000 + 7 * 500 + 1000);
    expect(c.rate("j")).toBeLessThan(0.5);
  });
  it("starts over for another job, and when the count goes back (a new pass)", () => {
    const c = new StepClock();
    c.note("a", 1, 0);
    c.note("a", 2, 1000);
    c.note("a", 3, 2000);
    expect(c.rate("a")).toBeCloseTo(1);
    expect(c.rate("b")).toBeNull();
    c.note("a", 0, 2500);
    expect(c.rate("a")).toBeNull();
    c.note("b", 1, 3000);
    expect(c.rate("a")).toBeNull();
  });
});

describe("the history's pinned failures", () => {
  const job = (id: string, status: "done" | "failed" | "cancelled", at: string, kind: "render" | "export" = "render") => ({ id, status, kind, finishedAt: at, createdAt: at, error: status === "failed" ? "CUDA out of memory. Tried to allocate 2 GiB" : null });
  it("pins only the failures since the last render done, or since the page opened when none is loaded", () => {
    const items = [
      job("f3", "failed", "2026-10-09T14:30:00Z"),
      job("x", "done", "2026-10-09T14:25:00Z", "export"),
      job("f2", "failed", "2026-10-09T14:20:00Z"),
      job("d", "done", "2026-10-09T14:02:00Z"),
      job("f1", "failed", "2026-10-09T11:10:00Z"),
    ];
    const pins = pinnedFailures(items);
    expect(pins.pinned.map((j) => j.id)).toEqual(["f3", "f2"]);
    expect(pins.since).toBe(Date.parse("2026-10-09T14:02:00Z"));
    const none = pinnedFailures([job("f1", "failed", "2026-10-09T11:10:00Z"), job("f0", "failed", "2026-10-09T09:00:00Z")], Date.parse("2026-10-09T10:00:00Z"));
    expect(none.pinned.map((j) => j.id)).toEqual(["f1"]);
  });
  it("says the reasons short, the most frequent first", () => {
    expect(reasonOf("CUDA out of memory. Tried to allocate 2 GiB")).toBe("CUDA out of memory");
    expect(reasonOf(null)).toBe("failed");
    expect(reasonsOf([{ error: "missing LoRA" }, { error: "out of memory." }, { error: "out of memory" }])).toBe("out of memory ×2 · missing LoRA");
    expect(reasonsOf([{ error: "a" }, { error: "b" }, { error: "c" }, { error: "d" }], 2)).toBe("a · b · +2");
  });
  it("says a failure in one readable sentence: a model file ComfyUI does not offer is a missing file, with where it was asked for", () => {
    const missing = readableError("ComfyUI rejected the job: Prompt outputs failed validation; UNETLoader: Value not in list unet_name: 'video\\DasiwaMinimaxH3_v3.safetensors' not in ['a.safetensors', 'b.gguf']");
    expect(missing).toEqual({ text: "Missing model file DasiwaMinimaxH3_v3.safetensors (UNETLoader · unet_name)", missing: { file: "DasiwaMinimaxH3_v3.safetensors", node: "UNETLoader", input: "unet_name" } });
    expect(readableError("ComfyUI rejected the job: Prompt outputs failed validation; KSampler: Value not in list sampler_name: 'x' not in ['euler']")).toEqual({ text: "KSampler does not offer sampler_name 'x'", missing: null });
    // Afflatus's own check before submitting, worded its way
    expect(readableError('this cannot run on your ComfyUI: 3 UNETLoader: ComfyUI has no file "DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors" for "unet_name".')).toEqual({
      text: "Missing model file DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors (UNETLoader · unet_name)",
      missing: { file: "DasiwaMinimaxH3_dasiwaHybridV3_int8.safetensors", node: "UNETLoader", input: "unet_name" },
    });
    expect(readableError("CUDA out of memory. Tried to allocate 2 GiB", "vram").text).toBe("Out of VRAM");
    expect(readableError("Joining clips needs ffmpeg. Install it.").text).toBe("Joining clips needs ffmpeg.");
    expect(readableError(null).text).toBe("Failed.");
  });
  it("folds the same failure (same error, workflow and model) into one group, in the order of its newest", () => {
    const f = (id: string, error: string, model: string | null = "m") => ({ id, error, recipe: "r", model });
    const groups = foldFailures([f("a", "missing"), f("b", "oom"), f("c", "missing"), f("d", "missing", "other"), f("e", "oom")]);
    expect(groups.map((g) => g.map((j) => j.id))).toEqual([["a", "c"], ["b", "e"], ["d"]]);
  });
  it("names a day Today, Yesterday or by its date", () => {
    const now = new Date(2026, 9, 9, 15);
    expect(dayLabel("2026-10-09", now)).toBe("Today");
    expect(dayLabel("2026-10-08", now)).toBe("Yesterday");
    // the When column's words, not "01/10" (review 4, finding 16: three date formats in one table)
    expect(dayLabel("2026-10-01", now)).toBe("1 Oct");
    expect(dayLabel("2025-12-31", now)).toBe("31 Dec 2025");
  });
});

describe("the render times' window", () => {
  it("works a preset out when it is read, so that it still ends now", () => {
    expect(windowOf({ preset: "1H", ms: 3_600_000 }, 10_000_000)).toEqual({ from: 6_400_000, to: 10_000_000 });
    expect(windowOf({ preset: "All", ms: null }, 5)).toBe("all");
    expect(windowOf({ from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
    expect(presetOf("nope").label).toBe("7D");
  });
  it("says a long window's weeks as weeks: per week, and the first and last days at the crosshair", () => {
    expect([3_600_000, 6 * 3_600_000, DAY, 7 * DAY].map(stretchOf)).toEqual(["hour", "6 h", "day", "week"]);
    // midday, so that the day is the same in any time zone
    const at = Date.parse("2026-10-05T12:00:00.000Z");
    const weeks = chartPointLabel(700 * DAY, 7 * DAY);
    expect(weeks(at, true)).toBe("5 Oct – 11 Oct 2026");
    expect(weeks(at)).toBe(chartTimeLabel(700 * DAY, DAY)(at));
    // a moment (a render in the lanes, the window's ends) is a day, and a chart of days says its days
    expect(chartTimeLabel(700 * DAY, 7 * DAY)(at, true)).toBe(chartTimeLabel(700 * DAY, DAY)(at, true));
    expect(chartPointLabel(30 * DAY, DAY)(at, true)).toBe(chartTimeLabel(30 * DAY, DAY)(at, true));
  });
  it("applies a typed window only when it is one", () => {
    expect(typedWindow(null)).toBeNull();
    expect(typedWindow({ from: "2026-10-01T10:00", to: "2026-10-01T09:00" })).toBeNull();
    expect(typedWindow({ from: "x", to: "2026-10-01T09:00" })).toBeNull();
    const w = typedWindow({ from: "2026-10-01T09:00", to: "2026-10-01T10:00" })!;
    expect(w.to - w.from).toBe(3_600_000);
  });
});

describe("the waiting list's \"about N in all\"", () => {
  // 40 jobs of 7.5 s on 4 machines: 10 each, done in about 75 s, not the 5 min they add up to
  const waiting = Array.from({ length: 40 }, (_, i) => ({ estimateMs: 7500, startsInMs: Math.floor(i / 4) * 7500 }));
  it("is the plan's last end, the machines sharing the jobs, not their sum", () => {
    expect(waitingEnds(waiting, null)).toBe(75_000);
    expect(waitingEnds(waiting, null, 80_000)).toBe(80_000);
  });
  it("with nothing planned (one machine), the jobs one after another after the running one", () => {
    expect(waitingEnds([{ estimateMs: 1000, startsInMs: null }, { estimateMs: 2000, startsInMs: null }], { eta: 3 })).toBe(6000);
  });
  it("paused, with nothing planned, shares the jobs between the machines up that can take them", () => {
    // 6 jobs of a minute on 3 machines: 2 min, not the 6 they add up to; the running one's 30 s on the first
    const paused = Array.from({ length: 6 }, () => ({ estimateMs: 60_000, startsInMs: null }));
    expect(waitingEnds(paused, null, null, ["a", "b", "c"])).toBe(120_000);
    expect(waitingEnds(paused, { eta: 30 }, null, ["a", "b", "c"])).toBe(150_000);
    // a model only two of them have: shared between those two; one pinned goes where it is pinned
    expect(waitingEnds(paused.map((w) => ({ ...w, runsOn: ["a", "c"] })), null, null, ["a", "b", "c"])).toBe(180_000);
    expect(waitingEnds([{ estimateMs: 60_000, startsInMs: null, pinned: "b" }, { estimateMs: 60_000, startsInMs: null, pinned: "b" }], null, null, ["a", "b"])).toBe(120_000);
    // none up: nothing said
    expect(waitingEnds(paused, null, null, [])).toBe(0);
  });
});
