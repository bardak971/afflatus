import { describe, expect, it } from "vitest";
import { dryContext, flowStartSigma, flux2StartSigma, fluxMu, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src";

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

describe("Upscale 2x starts from the real σ its denoise says on FLUX.1 and Klein (card #146, the owner's pick by eye)", () => {
  it("FLUX.1: the shift of 1536×2048, and the KSampler denoise whose simple schedule starts at 0.25, not 0.25 itself (0.81)", () => {
    const g = built("flux.sharper", {}, SOURCE);
    expect(of(g, "ModelSamplingFlux")[0]!.inputs).toMatchObject({ width: 1536, height: 2048 });
    const k = of(g, "KSampler")[0]!.inputs as { steps: number; denoise: number };
    expect(k.denoise).toBeLessThan(0.05);
    expect(flowStartSigma({ mu: fluxMu(1536, 2048) }, k.steps, k.denoise)).toBeCloseTo(0.25, 1);
  });
  it("FLUX.1 in tiles: each tile's pass starts at the field too", () => {
    const g = built("flux.sharper", { strength: 0.3 }, { source: { width: 1536, height: 2048 } });
    const k = of(g, "KSampler")[0]!.inputs as { steps: number; denoise: number };
    const tile = of(g, "ModelSamplingFlux")[0]!.inputs as { width: number; height: number };
    expect(flowStartSigma({ mu: fluxMu(tile.width, tile.height) }, k.steps, k.denoise)).toBeCloseTo(0.3, 1);
  });
  it("Klein: a longer Flux2Scheduler cut to ComfyUI's same 5 steps, from 0.25", () => {
    // 640×960 enlarged 2× is under Klein's 2.6 MP: gone over whole
    const g = built("klein.sharper", {});
    const sched = of(g, "Flux2Scheduler")[0]!.inputs as { steps: number; width: number; height: number };
    const split = of(g, "SplitSigmasDenoise")[0]!.inputs.denoise as number;
    expect(sched).toMatchObject({ width: 1280, height: 1920 });
    expect(sched.steps).toBeGreaterThan(20);
    expect(Math.round(sched.steps * split)).toBe(5);
    expect(flux2StartSigma(sched.steps, 1280, 1920, split)).toBeCloseTo(0.25, 1);
  });
  it("the families not tried keep ComfyUI's denoise: Z-Image's Upscale 2x is given 0.25 as it is", () => {
    expect(of(built("zimage.sharper", {}, SOURCE), "KSampler")[0]!.inputs.denoise).toBe(0.25);
  });
  it("hires fix stays ComfyUI's on both: the second pass takes the field as its denoise", () => {
    expect(of(built("flux.text-to-picture", { hires: true, hiresUpscaler: "u.pth" }), "KSampler").map((n) => n.inputs.denoise)).toEqual([1, 0.4]);
    const g = built("klein.picture", { hires: true, hiresUpscaler: "u.pth" });
    expect(of(g, "SplitSigmasDenoise")[0]!.inputs.denoise).toBe(0.35);
    expect(of(g, "Flux2Scheduler")[1]!.inputs).toMatchObject({ steps: 23, width: 1248, height: 1824 });
  });
  it("the \"?\" says it: the real σ on FLUX.1 and Klein, the real noise ComfyUI's 0.25 starts from elsewhere", () => {
    const note = (id: string, input: string) => ((recipeById(id) as Recipe<any>).inputs.find((i) => i.id === input) as { note?: string }).note ?? "";
    expect(note("flux.sharper", "strength")).toMatch(/^the real noise level \(σ\).*0\.81 on a 1536×2048/);
    expect(note("klein.sharper", "refine")).toMatch(/from 0\.25 of real noise \(σ\) at every size.*0\.73 of real noise/);
    expect(note("zimage.sharper", "strength")).toMatch(/^denoise at the model's shift: 0\.25 starts from 0\.50 of real noise at every size/);
  });
});
