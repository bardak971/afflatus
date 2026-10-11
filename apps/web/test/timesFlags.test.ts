import { describe, expect, it } from "vitest";
import type { RenderItem, TimesSummary } from "../src/api";
import { change, flagsOf, paceDrift } from "../src/screens/queue/flagRules";
import { busyShare, pct } from "../src/screens/queue/SummaryTiles";

const DAY = 86_400_000;
const times = Array.from({ length: 10 }, (_x, i) => Date.UTC(2026, 9, 1) + i * DAY);

type Model = TimesSummary["models"][number];
const model = (over: Partial<Model> = {}): Model => ({
  key: "ltx.video", name: "LTX 2.3 · Video", kind: "video", renders: 40, usualMs: 60_000, slowMs: 90_000, stepMs: 1_800, loadMs: 24_000, gpuMs: 3_600_000,
  failed: 0, cancelled: 0, lostMs: 0, oom: 0, loads: 2, trend: [], usual: [], slow: [], cold: [], pace: times.map(() => 100),
  phases: { loading: 0, sampling: 0, refining: 0, finishing: 0 }, setting: null, files: [], ...over,
});
const summary = (over: { tiles?: Partial<TimesSummary["tiles"]>; models?: Model[] } = {}): TimesSummary => ({
  period: "window", from: times[0]!, to: times.at(-1)! + DAY, step: DAY, times, buckets: [], keepDays: 90, since: null, spanMs: 10 * DAY,
  tiles: {
    done: 100, images: 60, videos: 40, failed: 0, cancelled: 0, videoMs: 0, lostMs: 0, gpuMs: 10 * 3_600_000, longestMs: 0,
    loadMs: 3_600_000 / 2, loads: 20, loadUsualMs: null, waitedUsualMs: null, waitedSlowMs: null, off: null,
    vramPeak: 80, vramUsual: 70, heatPeak: 70, heatUsual: 65, ...over.tiles,
  },
  finished: { images: [], videos: [], bad: [] }, phases: { loading: [], sampling: [], refining: [], finishing: [] },
  wait: { usual: [], slow: [] }, gpu: { vram: [], heat: [] }, models: over.models ?? [model()],
});

describe("a model's s/it against its own p50", () => {
  it("says a slow run at the end with when it began", () => {
    expect(paceDrift([100, 98, 101, null, 99, 100, 120, 117, null, 118], times)).toEqual({ pct: 18, since: times[6] });
  });
  it("needs two slow stretches: one slow day is not a flag, the later half says the pace", () => {
    expect(paceDrift([100, 100, 100, 100, 100, 100, 100, 100, 100, 130], times)).toEqual({ pct: 6, since: null });
    expect(paceDrift([null, null, 96, 95, null, null, null, null, null, null], times)).toEqual({ pct: -5, since: null });
    expect(paceDrift(times.map(() => null), times)).toBeNull();
  });
});

describe("the change against the period before", () => {
  it("in percent, nothing when there was nothing before", () => {
    expect(change(138, 100)).toBe(38);
    expect(change(96, 100)).toBe(-4);
    expect(change(5, 0)).toBeNull();
    expect(change(5, null)).toBeNull();
  });
});

describe("the flags of a period", () => {
  it("none when all is as usual", () => {
    expect(flagsOf(summary())).toEqual([]);
  });
  it("a model slower than its own p50 since a day", () => {
    const pace = [100, 98, 101, 99, 100, 100, 120, 117, 118, 116];
    expect(flagsOf(summary({ models: [model({ pace })] }))).toEqual([{ kind: "slow", model: "ltx.video", name: "LTX 2.3", pct: 18, since: times[6] }]);
  });
  it("model swaps from a tenth of the GPU time", () => {
    expect(flagsOf(summary({ tiles: { loadMs: 3_600_000, loads: 120 } }))).toEqual([{ kind: "swaps", loads: 120, loadMs: 3_600_000, share: 0.1 }]);
  });
  it("a model's failures: an OOM always, else two or more that are one render in twenty; the costliest first", () => {
    const flags = flagsOf(summary({ models: [
      model({ key: "a", name: "A", failed: 1, oom: 1, lostMs: 60_000 }),
      model({ key: "b", name: "B · Video", failed: 4, oom: 3, lostMs: 600_000 }),
      model({ key: "c", name: "C", failed: 1, renders: 10 }),
      model({ key: "d", name: "D", failed: 2, renders: 100 }),
    ] }));
    expect(flags.map((f) => (f.kind === "failures" ? [f.model, f.name, f.failed, f.oom] : f.kind))).toEqual([["b", "B", 4, 3], ["a", "A", 1, 1]]);
  });
  it("the VRAM at its ceiling, with the render that hit it and whether it spilled", () => {
    const item = { name: "MiniMax H3 · Video", width: 1024, height: 576, vram: 99 } as RenderItem;
    expect(flagsOf(summary({ tiles: { vramPeak: 99.4 } }), [{ ...item, vram: 80, name: "x" }, item])).toEqual([{ kind: "vram", peak: 99, spills: 0, spillLostMs: 0, where: "MiniMax H3 @ 1024×576" }]);
    expect(flagsOf(summary({ tiles: { vramPeak: 94 } }))).toEqual([]);
  });
});

describe("the GPU busy share", () => {
  it("is the GPU time over the window, never past all of it (a render that began before the window counts whole)", () => {
    expect(pct(busyShare(30 * 60_000, 60 * 60_000))).toBe("50 %");
    expect(pct(busyShare(80 * 60_000, 10 * 60_000))).toBe("100 %");
    expect(busyShare(1_000, 0)).toBe(1);
  });
});
