import { describe, expect, it } from "vitest";
import { karrasSigmas, sigmaOfOldDenoise, simpleStartSigma } from "../src";

const r3 = (x: number) => Math.round(x * 1000) / 1000;

describe("BasicScheduler's start on a shifted flow model", () => {
  it("is far above the denoise it was given: 0.15 over 2 steps at shift 8 starts at 0.593 (card #138)", () => {
    expect(r3(simpleStartSigma(0.15, 2, 8))).toBe(0.593);
    // denoise 0.10 at shift 8 (card #106): 0.47
    expect(r3(simpleStartSigma(0.1, 2, 8))).toBe(0.471);
    expect(r3(simpleStartSigma(0.2, 2, 1))).toBe(0.2);
    expect(simpleStartSigma(1, 4, 8)).toBe(1);
  });
});

describe("the karras tail", () => {
  it("runs from its start to its floor on ρ 7, then 0, one level a step", () => {
    expect(karrasSigmas(3, 0.25, 0.012).map(r3)).toEqual([0.25, 0.064, 0.012, 0]);
    expect(karrasSigmas(4, 0.593, 0.012).map(r3)).toEqual([0.593, 0.202, 0.057, 0.012, 0]);
    expect(karrasSigmas(1, 0.3, 0.012).map(r3)).toEqual([0.3, 0]);
  });
});

describe("an older denoise read as a σ", () => {
  it("gives the σ it started at, rounded to the form's step", () => {
    expect(sigmaOfOldDenoise({ denoise: 0.2, steps: 2, shift: 7 }, { denoise: 0.15, steps: 2 })).toBe(0.64);
  });
  it("gives nothing for the pair the form started on: the new defaults apply", () => {
    expect(sigmaOfOldDenoise({ denoise: 0.15, steps: 2, shift: 8 }, { denoise: 0.15, steps: 2 })).toBeNull();
  });
});
