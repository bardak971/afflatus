import { describe, expect, it } from "vitest";
import { gridAtOrBefore } from "../src/frameGrid";
import type { InputSpec } from "../src/inputs";
import { sourceWindows, windowBounds, windowPlaysSeconds, type WindowShape } from "../src/sourceWindows";

/** A long source made window by window: SCAIL-2's shape (16 fps, 321 frames a job, 5 carried) and a model's whose job is short (24 fps, 81, 1). */
const SCAIL = { fps: 16, most: 321, least: 9, carried: 5 };
const SHORT = { fps: 24, most: 81, least: 9, carried: 1 };
/** MiniMax H3's swap: 24 fps, 141 frames a window on H3's 17k + 5, 5 carried. */
const SWAP = { fps: 24, most: 141, least: 90, carried: 5, grid: { step: 17, offset: 5 } };

/**
 * Every source length from 3 s to 60 s, a window asked at the shortest, 5 s and the longest: what is left out at the end is
 * under a step of the grid, unless the last window already holds a job's most (then the rest was too short for a job).
 */
function leftOutBadly(shape: WindowShape): string[] {
  const grid = shape.grid ?? { step: 4, offset: 1 };
  const most = gridAtOrBefore(shape.most, grid);
  const bounds = windowBounds(shape);
  const bad: string[] = [];
  for (const windowMs of [bounds.leastMs, 5000, bounds.mostMs]) {
    for (let toMs = 3000; toMs <= 60000; toMs += 7) {
      const w = sourceWindows({ fromMs: 0, toMs, windowMs, shape });
      const last = w.at(-1);
      if (!last) continue;
      const n = Math.round(last.seconds * shape.fps - 0.5);
      if (toMs - last.toMs > (grid.step * 1000) / shape.fps && n < most) bad.push(`${windowMs} ms windows to ${toMs}: ${toMs - last.toMs} ms left out after ${n} frames`);
    }
  }
  return bad;
}

describe("a source's windows", () => {
  it("leave out no more of the end than taking the last window whole would, for every shape (review K-7)", () => {
    // H3's swap to 25.7 s ended at 21.5 s: the last two shared what was left, and the rest was too short for a job
    for (const shape of [SWAP, SCAIL, SHORT]) expect(leftOutBadly(shape).slice(0, 3), JSON.stringify(shape)).toEqual([]);
  });
  it("are on the model's own grid when it has one: H3's swap windows are 17k + 5 frames, the carried 5 among them", () => {
    const w = sourceWindows({ fromMs: 3000, toMs: 28000, windowMs: 5000, shape: SWAP });
    const frames = (x: { seconds: number }) => Math.round(x.seconds * 24 - 0.5);
    for (const x of w) expect((frames(x) - 5) % 17).toBe(0);
    // the first window opens: 107 frames of its own; the next ones carry 5 and show 119
    expect(frames(w[0]!)).toBe(107);
    expect(frames(w[1]!)).toBe(124);
    expect(w[1]!.start).toBeCloseTo(3 + 107 / 24 - 5 / 24, 4);
    expect(Math.abs(w[1]!.toMs - w[1]!.fromMs - (119 / 24) * 1000)).toBeLessThan(1);
    // a last stretch shorter than the fewest frames a swap takes (90) is left out
    expect(w.length).toBe(5);
    expect(28000 - w.at(-1)!.toMs).toBeLessThan(3750);
  });
  it("cover the stretch end to end: each shows from where the one before stopped", () => {
    const w = sourceWindows({ fromMs: 3000, toMs: 28000, windowMs: 5000, shape: SCAIL });
    expect(w[0]!.fromMs).toBe(3000);
    for (let k = 1; k < w.length; k++) expect(w[k]!.fromMs).toBe(w[k - 1]!.toMs);
    expect(w.at(-1)!.toMs).toBeLessThanOrEqual(28000);
    expect(28000 - w.at(-1)!.toMs).toBeLessThan(1000);
    expect(w.length).toBe(5);
  });
  it("start each part the carried frames before the stretch it shows, on the model's grid", () => {
    const [a, b] = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, shape: SCAIL });
    expect(a!.opens).toBe(true);
    expect(a!.start).toBe(0);
    // 5 s at 16 fps: 80 frames, 77 on the grid; the part holds them (half a frame more)
    expect(Math.round(a!.seconds * 16 - 0.5)).toBe(77);
    expect(a!.toMs).toBe(Math.round((77 / 16) * 1000));
    expect(b!.opens).toBe(false);
    expect(b!.start * 1000).toBeCloseTo(a!.toMs - (5 / 16) * 1000, -1);
    // 80 new frames and 5 carried: 85, 85 on the grid, 80 shown
    expect(b!.toMs - b!.fromMs).toBe(5000);
  });
  it("hold one job's most: a model of 81 frames at 24 fps makes about 3.3 s a window", () => {
    const w = sourceWindows({ fromMs: 0, toMs: 10000, windowMs: 5000, shape: SHORT });
    expect(Math.round(w[0]!.seconds * 24 - 0.5)).toBe(81);
    expect(w[1]!.toMs - w[1]!.fromMs).toBe(Math.round((80 / 24) * 1000));
  });
  it("end a window exactly on a scene cut within ± of the length, its overshoot hidden, the next one opening the new shot there", () => {
    const w = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, withinMs: 1500, shape: SWAP, cutsMs: [4657, 9957] });
    expect(w[0]).toMatchObject({ toMs: 4657, on: "cut" });
    // its part runs to H3's next count past the cut (17k + 5), the take hiding the rest
    const frames = Math.round(w[0]!.seconds * 24 - 0.5);
    expect((frames - 5) % 17).toBe(0);
    expect(w[0]!.hideMs).toBe(Math.round((frames * 1000) / 24 - 4657));
    expect(w[1]).toMatchObject({ opens: true, fromMs: 4657, toMs: 9957, on: "cut" });
    expect(w[1]!.start * 1000).toBeCloseTo(4657, 0);
  });
  it("carry through a scene cut further than ± from the length, and through every cut at ± 0", () => {
    // 2.5 s in: under 5 - 1.5 s, carried through
    const near = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, withinMs: 1500, shape: SWAP, cutsMs: [2500] });
    expect(near.every((x, k) => k === 0 || !x.opens)).toBe(true);
    expect(near[0]!.on).toBe("length");
    const exact = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, withinMs: 0, shape: SWAP, cutsMs: [4657, 9957] });
    expect(exact).toEqual(sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, shape: SWAP }));
    expect(exact.slice(1).every((x) => !x.opens && x.hideMs === undefined)).toBe(true);
  });
  it("end a window that carries on at a pause in the speech, else at its quietest moment, on the model's frame count nearest it", () => {
    const paused = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, withinMs: 1500, shape: SCAIL, pauses: [{ start: 4.1, end: 4.3 }] });
    expect(paused[0]!.on).toBe("pause");
    expect(Math.abs(paused[0]!.toMs - 4200)).toBeLessThanOrEqual((4 / 16) * 1000);
    // loud but for a dip at 5.8 s
    const db = Array.from({ length: 200 }, (_, i) => (i === 58 ? -50 : -10));
    const quiet = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, withinMs: 1500, shape: SCAIL, levels: { rate: 10, db } });
    expect(quiet[0]!.on).toBe("quiet");
    expect(Math.abs(quiet[0]!.toMs - 5850)).toBeLessThanOrEqual((4 / 16) * 1000);
    // the last window ends where the stretch does: at none of them
    expect(quiet.at(-1)!.on).toBeUndefined();
  });
  it("leave out a last stretch too short for a job, and give none for a stretch too short", () => {
    expect(sourceWindows({ fromMs: 0, toMs: 300, windowMs: 5000, shape: SCAIL })).toEqual([]);
    const w = sourceWindows({ fromMs: 0, toMs: 5100, windowMs: 5000, shape: SCAIL });
    expect(w.length).toBe(1);
  });
  it("run to the source's end: no short last clip (the meme's 26.6 s in 5 s windows ended on a 2.1 s one)", () => {
    for (const shape of [SCAIL, SHORT]) {
      const frameMs = 1000 / shape.fps;
      const w = sourceWindows({ fromMs: 0, toMs: 26_600, windowMs: 5000, shape });
      // to the end, within a grid step
      expect(26_600 - w.at(-1)!.toMs).toBeLessThan(4 * frameMs + 1);
      // no window shows less than half of the one before it, and none holds more than one job takes
      for (let k = 1; k < w.length; k++) expect(w[k]!.toMs - w[k]!.fromMs).toBeGreaterThanOrEqual((w[k - 1]!.toMs - w[k - 1]!.fromMs) / 2 - frameMs);
      for (const x of w) expect(Math.round(x.seconds * shape.fps - 0.5)).toBeLessThanOrEqual(shape.most);
    }
    // SCAIL-2 holds 20 s a job: the last 5 s window takes the 1.6 s left
    expect(sourceWindows({ fromMs: 0, toMs: 26_600, windowMs: 5000, shape: SCAIL }).length).toBe(5);
  });
});

describe("the window lengths a source takes", () => {
  it("start where a window that carries on still has the fewest frames its recipe takes: H3's swap at 4.25 s, not 3.75", () => {
    const swap = windowBounds({ fps: 24, most: 141, least: 90, carried: 5, grid: { step: 17, offset: 5 } });
    expect(swap.leastMs).toBeCloseTo((102 / 24) * 1000, 3);
    expect(swap.mostMs).toBeCloseTo((136 / 24) * 1000, 3);
  });
});

describe("windowPlaysSeconds", () => {
  // H3's swap with its Normal run-up: 22 frames carried, its part of the source given as start and seconds
  const recipe = {
    traits: { fps: 24, frameGrid: { step: 17, offset: 5 }, windows: { most: 141, least: 90, carried: 22 } },
    inputs: [{ id: "source", type: "clip", role: "source", label: "Source", window: { start: "sourceStart", seconds: "sourceSeconds" } }] as unknown as InputSpec[],
  };

  it("plays what each window shows: the planned windows of a source add up to the source, not the carried frames twice", () => {
    const windows = sourceWindows({ fromMs: 0, toMs: 110_759, windowMs: 5000, shape: { fps: 24, most: 141, least: 90, carried: 22, grid: { step: 17, offset: 5 } } });
    const plays = windows.map((w) => windowPlaysSeconds(recipe, { sourceStart: w.start, sourceSeconds: w.seconds }, w.opens ? "cut" : "continue")!);
    windows.forEach((w, k) => expect(plays[k]! * 1000).toBeCloseTo(w.toMs - w.fromMs, -1));
    expect(plays.reduce((a, b) => a + b, 0) * 1000).toBeCloseTo(windows.at(-1)!.toMs - windows[0]!.fromMs, -2);
  });

  it("is null for a clip not made window by window", () => {
    expect(windowPlaysSeconds({ traits: null, inputs: [] }, { seconds: 5 }, "continue")).toBeNull();
  });
});
