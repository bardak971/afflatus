import { describe, expect, it } from "vitest";
import { sourceWindows } from "../src/sourceWindows";

/** A long source made window by window: SCAIL-2's shape (16 fps, 321 frames a job, 5 carried) and Wan Animate 2's (24 fps, 81, 1). */
const SCAIL = { fps: 16, most: 321, least: 9, carried: 5 };
const WAN = { fps: 24, most: 81, least: 9, carried: 1 };

describe("a source's windows", () => {
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
});
