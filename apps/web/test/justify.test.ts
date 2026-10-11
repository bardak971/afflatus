import { describe, expect, it } from "vitest";
import { aspectOf, FALLBACK_ASPECT, justify, SOUND_ASPECT } from "../src/screens/library/justify";
import { barsOf } from "../src/screens/library/SoundWave";

describe("the library's justified rows", () => {
  it("fills every full row to the width exactly, at one height per row near the target", () => {
    const shapes = [16 / 9, 16 / 9, 9 / 16, 16 / 9, 1, 3 / 4, 16 / 9, 2.2, 9 / 16, 16 / 9];
    const rows = justify(shapes, 1000, 200, 8);
    for (const r of rows.slice(0, -1)) {
      expect(r.widths.reduce((s, w) => s + w, 0) + 8 * (r.widths.length - 1)).toBe(1000);
      expect(r.height).toBeGreaterThan(140);
      expect(r.height).toBeLessThan(280);
      // each tile keeps its shape, to a pixel or two of rounding
      r.widths.slice(0, -1).forEach((w, i) => expect(Math.abs(w - shapes[r.start + i]! * r.height)).toBeLessThan(2));
    }
    // every item is placed once, in order
    expect(rows.flatMap((r) => r.widths.map((_, i) => r.start + i))).toEqual(shapes.map((_, i) => i));
  });

  it("keeps the last row, not full, at the target height without stretching it", () => {
    const rows = justify([1, 1, 1, 1, 1, 1, 1], 1000, 200, 8);
    expect(rows).toHaveLength(2);
    const last = rows.at(-1)!;
    expect(last.height).toBe(200);
    expect(last.widths.every((w) => w === 200)).toBe(true);
    expect(last.widths.reduce((s, w) => s + w, 0)).toBeLessThan(1000);
  });

  it("gives a very wide item a row of its own, as wide as the grid", () => {
    const rows = justify([3, 1], 400, 200, 8);
    expect(rows[0]).toMatchObject({ start: 0, end: 1, widths: [400] });
    expect(rows[0]!.height).toBe(133);
  });

  it("lays out nothing before the width is known", () => {
    expect(justify([1, 1], 0, 200, 8)).toEqual([]);
  });

  it("falls back to the old tile's shape for an item of unknown size, and keeps shapes within bounds", () => {
    expect(aspectOf({ kind: "image", width: null, height: null })).toBe(FALLBACK_ASPECT);
    expect(aspectOf({ kind: "audio", width: null, height: null })).toBe(SOUND_ASPECT);
    expect(aspectOf({ kind: "video", width: 1024, height: 576 })).toBeCloseTo(16 / 9);
    expect(aspectOf({ kind: "image", width: 5000, height: 100 })).toBe(3);
  });

  it("lays out a page of thousands quickly", () => {
    const shapes = Array.from({ length: 5000 }, (_, i) => [16 / 9, 9 / 16, 1, 3 / 4][i % 4]!);
    const t = performance.now();
    const rows = justify(shapes, 1600, 210, 8);
    expect(performance.now() - t).toBeLessThan(50);
    expect(rows.reduce((n, r) => n + r.widths.length, 0)).toBe(5000);
  });
});

describe("a sound's waveform", () => {
  it("makes bars of the loudest of each stretch, the loudest at the top", () => {
    const bars = barsOf([-60, -30, -30, 0, -60, -60, -15, -15], 4)!;
    expect(bars).toHaveLength(4);
    expect(bars[1]).toBe(1);
    expect(bars[0]).toBeCloseTo(0.5);
    expect(bars[2]).toBe(0.06);
    expect(barsOf(null)).toBeNull();
  });
});
