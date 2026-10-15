import { describe, expect, it } from "vitest";
import { sourceWindows } from "../src/sourceWindows";

/** A long source made window by window: SCAIL-2's shape (16 fps, 321 frames a job, 5 carried) and Wan Animate 2's (24 fps, 81, 1). */
const SCAIL = { fps: 16, most: 321, least: 9, carried: 5 };
const WAN = { fps: 24, most: 81, least: 9, carried: 1 };
/** MiniMax H3's swap: 24 fps, 141 frames a window on H3's 17k + 5, 5 carried. */
const SWAP = { fps: 24, most: 141, least: 90, carried: 5, grid: { step: 17, offset: 5 } };

describe("a source's windows", () => {
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
  it("hold one job's most: Wan Animate 2 makes about 3.3 s a window", () => {
    const w = sourceWindows({ fromMs: 0, toMs: 10000, windowMs: 5000, shape: WAN });
    expect(Math.round(w[0]!.seconds * 24 - 0.5)).toBe(81);
    expect(w[1]!.toMs - w[1]!.fromMs).toBe(Math.round((80 / 24) * 1000));
  });
  it("end a window at a scene cut, the next one a new shot", () => {
    const w = sourceWindows({ fromMs: 0, toMs: 20000, windowMs: 5000, shape: SCAIL, cutsMs: [7300] });
    const at = w.findIndex((x) => x.toMs >= 7000 && x.toMs <= 7300);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(w[at + 1]!.opens).toBe(true);
    expect(w[at + 1]!.start * 1000).toBeCloseTo(w[at + 1]!.fromMs, -1);
  });
  it("leave out a last stretch too short for a job, and give none for a stretch too short", () => {
    expect(sourceWindows({ fromMs: 0, toMs: 300, windowMs: 5000, shape: SCAIL })).toEqual([]);
    const w = sourceWindows({ fromMs: 0, toMs: 5100, windowMs: 5000, shape: SCAIL });
    expect(w.length).toBe(1);
  });
  it("run to the source's end: no short last clip (the meme's 26.6 s in 5 s windows ended on a 2.1 s one)", () => {
    for (const shape of [SCAIL, WAN]) {
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
