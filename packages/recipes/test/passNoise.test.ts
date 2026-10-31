import { describe, expect, it } from "vitest";
import { dryContext, flowStartSigma, flux2StartSigma, fluxMu, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src";
import { PASS_NOISE } from "../src/shared/passNoise";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const of = (g: Graph, cls: string) => Object.values(g).filter((n) => n.class_type === cls);

/** A recipe built from its first variant with these inputs changed. */
function built(id: string, change: Record<string, unknown>, media?: Record<string, unknown>): Graph {
  const recipe = recipeById(id) as Recipe<any>;
  const v = recipe.variants[0]!;
  const input = parseInput(recipe, { ...v.input, ...change });
  const ctx = dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: { ...(v.media ?? {}), ...(media ?? {}) } as Record<string, any>, has: () => true });
  return (recipe.build(input as never, ctx) as { graph: Graph }).graph;
}

// a 768×1024 enlarged 2×: gone over whole
const SOURCE = { source: { width: 768, height: 1024 } };

describe("the second pass's noise (card #146): ComfyUI's way unless asked", () => {
  it("FLUX.1 Upscale 2x: by default the shift of 1536×2048 and the field as KSampler's denoise", () => {
    const g = built("flux.sharper", {}, SOURCE);
    expect(of(g, "ModelSamplingFlux")[0]!.inputs).toMatchObject({ width: 1536, height: 2048 });
    expect(of(g, "KSampler")[0]!.inputs.denoise).toBe(0.25);
  });
  it("FLUX.1 Upscale 2x at the 1 MP shift: ModelSamplingFlux is told 1024×1024, the denoise is the field", () => {
    const g = built("flux.sharper", { passNoise: PASS_NOISE.oneMp }, SOURCE);
    expect(of(g, "ModelSamplingFlux")[0]!.inputs).toMatchObject({ width: 1024, height: 1024 });
    expect(of(g, "KSampler")[0]!.inputs.denoise).toBe(0.25);
  });
  it("FLUX.1 Upscale 2x at the real σ: the denoise whose schedule starts at 0.25", () => {
    const g = built("flux.sharper", { passNoise: PASS_NOISE.real }, SOURCE);
    const k = of(g, "KSampler")[0]!.inputs;
    expect(k.denoise as number).toBeLessThan(0.05);
    expect(flowStartSigma({ mu: fluxMu(1536, 2048) }, k.steps as number, k.denoise as number)).toBeCloseTo(0.25, 1);
  });
  it("FLUX.1 hires fix at the real σ: the second KSampler alone moves", () => {
    const base = built("flux.text-to-picture", { hires: true, hiresUpscaler: "u.pth" });
    const real = built("flux.text-to-picture", { hires: true, hiresUpscaler: "u.pth", passNoise: PASS_NOISE.real });
    const [a1, a2] = of(base, "KSampler").map((n) => n.inputs.denoise);
    const [b1, b2] = of(real, "KSampler").map((n) => n.inputs.denoise);
    expect([a1, a2]).toEqual([1, 0.4]);
    expect(b1).toBe(1);
    expect(b2 as number).toBeLessThan(0.2);
  });
  it("Klein Upscale 2x: ComfyUI's 20 steps cut at 0.25; the 1 MP schedule; or a longer schedule cut to the same 5 steps from 0.25", () => {
    const sched = (g: Graph) => of(g, "Flux2Scheduler")[0]!.inputs;
    const split = (g: Graph) => of(g, "SplitSigmasDenoise")[0]!.inputs.denoise as number;
    // 640×960 enlarged 2× is under Klein's 2.6 MP: gone over whole
    const comfy = built("klein.sharper", {});
    expect(sched(comfy)).toMatchObject({ steps: 20, width: 1280, height: 1920 });
    expect(split(comfy)).toBe(0.25);
    expect(sched(built("klein.sharper", { passNoise: PASS_NOISE.oneMp }))).toMatchObject({ steps: 20, width: 1024, height: 1024 });
    const real = built("klein.sharper", { passNoise: PASS_NOISE.real });
    const { steps } = sched(real) as { steps: number };
    expect(Math.round(steps * split(real))).toBe(5);
    expect(flux2StartSigma(steps, 1280, 1920, split(real))).toBeCloseTo(0.25, 1);
  });
  it("Klein hires fix at the real σ runs the hires steps from the field", () => {
    const g = built("klein.picture", { hires: true, hiresUpscaler: "u.pth", passNoise: PASS_NOISE.real });
    const second = of(g, "Flux2Scheduler")[1]!.inputs as { steps: number; width: number; height: number };
    const d = of(g, "SplitSigmasDenoise")[0]!.inputs.denoise as number;
    expect(Math.round(second.steps * d)).toBe(8);
    expect(flux2StartSigma(second.steps, second.width, second.height, d)).toBeCloseTo(0.35, 1);
  });
});
