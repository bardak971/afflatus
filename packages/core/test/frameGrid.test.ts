import { describe, expect, it } from "vitest";
import { chunkAtOrAfter, chunkStartAtOrAfter, FRAME_SLACK_MS, gridAtLeast, gridAtOrBefore, gridIndex, gridNearest, isChunkStart, JOIN_FADE_MS, joinFade, LATENT_GRID, latentFrameAtOrBefore, MIN_FADE_MS, onGrid } from "../src";

/** The sums each place wrote by hand before frameGrid.ts, kept here to hold the grid to them. */
const before = {
  latentFrameAtOrBefore: (frame: number) => Math.floor((frame - 5) / 17) * 17 + 5,
  chunkAtOrAfter: (frame: number) => Math.ceil(frame / 17) * 17,
  videoTokensOf: (frames: number) => (frames < 5 || (frames - 5) % 17 !== 0 ? 0 : ((frames - 5) / 17) * 5 + 2),
  h3Nearest: (wanted: number) => Math.max(5, Math.round((wanted - 5) / 17) * 17 + 5),
  guideOk: (n: number) => !(n % 17 !== 5 || n > 39),
  trimOk: (atFrames: number) => atFrames % 17 === 5,
  landing: (nextAt: number) => nextAt % 17 === 0,
  atLeast: (frames: number, g: { step: number; offset: number }) => Math.max(g.offset, Math.ceil((frames - g.offset) / g.step) * g.step + g.offset),
};

describe("a video model's frame grid", () => {
  const frames = Array.from({ length: 420 }, (_x, i) => i - 20);

  it("rounds each way as the place that uses it always did: down for a cut, up for a length asked for, to the nearest for a length typed", () => {
    for (const f of frames) {
      expect(latentFrameAtOrBefore(f)).toBe(before.latentFrameAtOrBefore(f));
      expect(gridAtOrBefore(f, LATENT_GRID)).toBe(before.latentFrameAtOrBefore(f));
      expect(chunkAtOrAfter(f)).toBe(before.chunkAtOrAfter(f));
      expect(chunkStartAtOrAfter(f, LATENT_GRID)).toBe(before.chunkAtOrAfter(f));
      expect(gridNearest(f, LATENT_GRID)).toBe(before.h3Nearest(f));
      const tokens = gridIndex(f, LATENT_GRID);
      expect(tokens < 0 ? 0 : tokens * 5 + 2).toBe(before.videoTokensOf(f));
      expect(onGrid(f, LATENT_GRID) && f <= 39).toBe(before.guideOk(f));
      expect(onGrid(f, LATENT_GRID)).toBe(before.trimOk(f));
      expect(isChunkStart(f, LATENT_GRID)).toBe(before.landing(f));
      for (const g of [{ step: 8, offset: 1 }, { step: 4, offset: 1 }, LATENT_GRID]) expect(gridAtLeast(f, g)).toBe(before.atLeast(f, g));
    }
  });

  it("names the three ways apart on one count", () => {
    // 100 frames on H3's 17k + 5: 90 below, 107 above; 100 is nearer 107
    expect([gridAtOrBefore(100, LATENT_GRID), gridNearest(100, LATENT_GRID), gridAtLeast(100, LATENT_GRID)]).toEqual([90, 107, 107]);
    expect([gridAtOrBefore(95, LATENT_GRID), gridNearest(95, LATENT_GRID), gridAtLeast(95, LATENT_GRID)]).toEqual([90, 90, 107]);
    // never under the offset going up or to the nearest; going down, a frame before the first count is under it
    expect(gridNearest(0, LATENT_GRID)).toBe(5);
    expect(gridAtLeast(-3, LATENT_GRID)).toBe(5);
    expect(gridAtOrBefore(3, LATENT_GRID)).toBe(-12);
  });
});

describe("a join's fade", () => {
  it("is the named lengths: four frames, none under the shortest worth making", () => {
    expect(joinFade({ joined: true, seamless: false, sharedMs: MIN_FADE_MS })).toEqual({ ms: JOIN_FADE_MS, mode: "hold" });
    expect(joinFade({ joined: true, seamless: false, sharedMs: MIN_FADE_MS - 1 })).toBeNull();
    expect(joinFade({ landedMs: 120, joined: false, seamless: false, sharedMs: 0 })).toEqual({ ms: 120, mode: "overlap" });
    expect(joinFade({ landedMs: 400, joined: false, seamless: false, sharedMs: 0 })).toEqual({ ms: JOIN_FADE_MS, mode: "overlap" });
    expect([JOIN_FADE_MS, MIN_FADE_MS, FRAME_SLACK_MS]).toEqual([170, 80, 40]);
  });
});
