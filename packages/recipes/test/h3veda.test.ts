import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src/index";

/**
 * Veda's sparse attention on every H3 form (card #28, "every H3 form alike"): the predictor made for the model the clip is
 * sampled with, the reference model's (R2VA) or the text-and-frames one (T2VA); without it, the full attention, said.
 */
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const R2VA = "minimax_h3_r2va_veda_preview_fp8.safetensors";
const T2VA = "minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors";

/** A form's first variant, its input changed, built with or without the predictors. */
function built(id: string, over: Record<string, unknown>, predictors: Record<string, string>) {
  const recipe = recipeById(id) as Recipe<any>;
  const v = recipe.variants[0]!;
  const input = parseInput(recipe, { ...(v.input as Record<string, unknown>), ...over });
  const out = recipe.build(input, dryContext({ ...v, slots: { ...v.slots, ...predictors } }));
  const veda = Object.values(out.graph as Graph).find((n) => n.class_type === "VedaSparseAttention");
  return { veda: veda?.inputs.predictor ?? null, warnings: out.warnings ?? [] };
}

describe("Veda on the H3 forms", () => {
  it("is offered on all five, in their speed settings, off by default", () => {
    for (const id of ["h3.video", "h3.lipsync", "h3.swap", "h3.swapMotion", "h3.motion"]) {
      const spec = recipeById(id)!.inputs.find((i) => i.id === "veda");
      expect(spec, id).toMatchObject({ type: "toggle", default: false });
    }
  });

  it("a clip from words takes the text-and-frames predictor; one with reference pictures the reference model's", () => {
    const both = { veda: R2VA, vedaT2va: T2VA };
    expect(built("h3.video", { veda: true }, both).veda).toBe(T2VA);
    expect(built("h3.video", { veda: true, references: [{ asset: "r1", role: "person" }] }, { ...both, refUnet: "minimax_h3_ref2va.safetensors" }).veda).toBe(R2VA);
    // the swap runs the reference model as its own file: always its predictor
    expect(built("h3.swap", { veda: true }, both).veda).toBe(R2VA);
  });

  it("off, or its predictor missing: the full attention, the missing predictor said on the job", () => {
    expect(built("h3.video", { veda: false }, { vedaT2va: T2VA }).veda).toBeNull();
    const without = built("h3.video", { veda: true }, {});
    expect(without.veda).toBeNull();
    expect(without.warnings.join(" ")).toMatch(/predictor for text and frames \(T2VA\) is not in ComfyUI's models\/veda folder/);
    expect(built("h3.swap", { veda: true }, {}).warnings.join(" ")).toMatch(/predictor for the reference model is not/);
  });

  it("asks a rented pod for the predictor the clip takes", () => {
    const video = recipeById("h3.video")!;
    expect(video.needsWith!(parseInput(video, { ...(video.variants[0]!.input as object), veda: true }), {})).toContain("vedaT2va");
    expect(video.needsWith!(parseInput(video, { ...(video.variants[0]!.input as object), veda: false }), {})).not.toContain("vedaT2va");
  });
});
