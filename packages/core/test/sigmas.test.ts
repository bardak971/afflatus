import { describe, expect, it } from "vitest";
import { denoiseForSigma, flowStartSigma, flux2ForSigma, flux2Sigmas, flux2StartSigma, fluxMu, karrasSigmas, sigmaOfOldDenoise, simpleStartSigma } from "../src";

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

describe("the σ a flow model's img2img pass starts at (card #146, ComfyUI's formulas worked on paper)", () => {
  it("on FLUX.1 follows the size: Upscale 2x's 0.25 starts at 0.81 on a 1536×2048 gone over whole, 0.51 at 1 MP", () => {
    expect(r3(fluxMu(1024, 1024))).toBe(1.15);
    expect(r3(flowStartSigma({ mu: fluxMu(1536, 2048) }, 10, 0.25))).toBe(0.808);
    expect(r3(flowStartSigma({ mu: fluxMu(1024, 1024) }, 10, 0.25))).toBe(0.513);
    // hires fix 1.5× of 896×1152 at 0.40
    expect(r3(flowStartSigma({ mu: fluxMu(1344, 1728) }, 10, 0.4))).toBe(0.83);
  });
  it("on Z-Image's shift 3: Redraw's 0.55 starts at 0.80, 0.18 at 0.40 (the pod's faces)", () => {
    expect(r3(flowStartSigma({ shift: 3 }, 8, 0.55))).toBe(0.8);
    expect(r3(flowStartSigma({ shift: 3 }, 8, 0.18))).toBe(0.4);
    expect(flowStartSigma({ shift: 8 }, 2, 0.15)).toBe(simpleStartSigma(0.15, 2, 8));
  });
  it("on Klein's Flux2Scheduler: hires 0.35 starts at 0.80, Upscale 2x's 0.25 at 0.81 whole", () => {
    expect(r3(flux2StartSigma(23, 1344, 1728, 0.35))).toBe(0.796);
    expect(r3(flux2StartSigma(20, 1536, 2048, 0.25))).toBe(0.808);
    const s = flux2Sigmas(4, 1024, 1024);
    expect(s).toHaveLength(5);
    expect(s[0]).toBe(1);
    expect(s[4]).toBe(0);
  });
});

describe("a denoise read as the real σ it means (card #146's variant)", () => {
  it("gives the KSampler denoise whose simple schedule starts there, and ComfyUI's int(steps / denoise) the steps laid out", () => {
    for (const [s, steps, sigma] of [[{ mu: fluxMu(1536, 2048) }, 10, 0.25], [{ shift: 3 }, 4, 0.3], [{ mu: 1.15 }, 4, 0.35]] as const) {
      const d = denoiseForSigma(s, steps, sigma);
      expect(d).toBeLessThan(sigma);
      expect(Math.abs(flowStartSigma(s, steps, d) - sigma)).toBeLessThan(0.02);
    }
    expect(denoiseForSigma({ shift: 3 }, 8, 1)).toBe(1);
  });
  it("gives Klein the schedule and the split that run the same steps from the field's σ", () => {
    const { steps, denoise } = flux2ForSigma(5, 1536, 2048, 0.25);
    expect(Math.round(steps * denoise)).toBe(5);
    expect(Math.abs(flux2StartSigma(steps, 1536, 2048, denoise) - 0.25)).toBeLessThan(0.02);
  });
});
