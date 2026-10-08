import { describe, expect, it } from "vitest";
import { latentUpscaleSize, roundTo } from "../src";

describe("roundTo", () => {
  it("takes the nearest multiple of the grid, never under the least", () => {
    expect([roundTo(1000, 16), roundTo(1003, 8, 64), roundTo(20, 8, 64), roundTo(10, 32)]).toEqual([1008, 1000, 64, 32]);
  });
});

describe("latentUpscaleSize", () => {
  it("is the clip's frame times the factor on the latent's 32-pixel grid, as H3's re-sample makes it", () => {
    expect(latentUpscaleSize({ width: 576, height: 1024 }, 1.5)).toEqual({ width: 864, height: 1536 });
    expect(latentUpscaleSize({ width: 544, height: 960 }, 1.25)).toEqual({ width: 672, height: 1216 });
  });
});
