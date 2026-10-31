import { describe, expect, it } from "vitest";
import { dryContext, OWN_MODEL, parseInput, type BuildContext, type Recipe } from "@afflatus/core";
import { recipeById } from "../src/index";
import { FACE_REFINE_FULL_STEPS, FACE_REFINE_OWN_SLOTS, FACE_REFINE_SLOTS } from "../src/h3/faceRefine";

/** Card #204: the Face refine model on the forms of SCAIL-2 (24 fps) and LTX 2.5, whose own model is not H3's. */
type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;

const FULL = "minimax_h3_ref2va.safetensors";
const face = { ...FACE_REFINE_SLOTS, ...FACE_REFINE_OWN_SLOTS };
const forms: Array<{ id: string; values: Record<string, unknown>; ctx: Partial<BuildContext> }> = [
  {
    id: "scail.motion24", values: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 141 / 24 },
    ctx: {
      slots: { unet: "wan2.1_14B_SCAIL_2_int8_convrot.safetensors", clip: "umt5.safetensors", vae: "wan_2.1_vae.safetensors", clipVision: "clip_vision_h.safetensors", sam: "sam3.1.safetensors", ...face },
      uploads: { picture: "picture.png", driving: "d.mp4" }, media: { picture: { width: 768, height: 1360 }, driving: { width: 480, height: 854, frames: 141, fps: 24, hasSound: true } },
    },
  },
  {
    id: "ltx25.video", values: { prompt: "a", references: [{ asset: "r1", role: "person" }] },
    ctx: {
      slots: { unet: "ltx-2.5-22b-distilled.safetensors", clip: "gemma.safetensors", videoVae: "ltx-2.5-video-vae.safetensors", audioVae: "ltx-2.5-audio-vae.safetensors", msr: "msr.safetensors", ...face },
      uploads: { "references.0": "r1.png" },
    },
  },
];

function build(form: (typeof forms)[number], values: Record<string, unknown>) {
  const recipe = recipeById(form.id)! as Recipe<unknown>;
  const built = recipe.build(parseInput(recipe, { ...form.values, faceRefine: true, ...values }), dryContext({ seed: 7, ...form.ctx }));
  return { built, graph: built.graph as Graph };
}
/** The face pass's sampler steps and the file its model chain starts from. */
function facePass(graph: Graph) {
  const sampler = of(graph, "SamplerCustomAdvanced").find((n) => node(graph, n.inputs.latent_image).class_type === "H3PerFrameDenoise")!;
  let model = node(graph, node(graph, sampler.inputs.latent_image).inputs.model);
  while (model.class_type !== "UNETLoader") model = node(graph, model.inputs.model);
  return { steps: node(graph, sampler.inputs.sigmas).inputs.steps, file: model.inputs.unet_name };
}

describe("SCAIL-2 and LTX 2.5 · Face refine model (card #204)", () => {
  for (const form of forms) {
    const recipe = recipeById(form.id)!;

    it(`${form.id}: is H3's input, after the toggle, without the clip's own`, () => {
      const at = recipe.inputs.findIndex((i) => i.id === "faceRefineModel");
      expect(recipe.inputs[at - 1]?.id).toBe("faceRefine");
      expect(recipe.inputs[at]).toMatchObject({ type: "model", label: "Face refine model", folder: "diffusion_models", slot: "faceRefineUnet", showWhen: "faceRefine", section: "out" });
      expect(recipe.inputs[at]).not.toHaveProperty("own");
      expect(String(recipe.inputs[at]!.note)).not.toContain(OWN_MODEL);
      expect(() => parseInput(recipe, { ...form.values, faceRefine: true, faceRefineModel: OWN_MODEL })).toThrow(/not offered here/);
    });

    it(`${form.id}: left out, the graph is the fused turbo's, as before the input`, () => {
      const left = build(form, {});
      expect(facePass(left.graph)).toEqual({ steps: 4, file: face.faceRefineUnet });
      expect(build(form, { faceRefineModel: face.faceRefineUnet }).graph).toEqual(left.graph);
    });

    it(`${form.id}: redraws with the file picked, at a full model's steps unless typed, and asks a pod for it instead of the slot's`, () => {
      const { built, graph } = build(form, { faceRefineModel: FULL });
      expect(facePass(graph)).toEqual({ steps: FACE_REFINE_FULL_STEPS, file: FULL });
      expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).not.toContain(face.faceRefineUnet);
      expect(built.loads).toContain(`diffusion_models/${FULL}`);
      expect(built.loads).not.toContain(`diffusion_models/${face.faceRefineUnet}`);
      expect(built.passes?.at(-1)).toMatchObject({ steps: FACE_REFINE_FULL_STEPS });
      expect(facePass(build(form, { faceRefineModel: FULL, faceRefineSteps: 6 }).graph).steps).toBe(6);
      const needs = (values: Record<string, unknown>) => recipe.needsWith!(parseInput(recipe, { ...form.values, faceRefine: true, ...values }), {});
      expect(needs({})).toContain("faceRefineUnet");
      expect(needs({ faceRefineModel: FULL })).not.toContain("faceRefineUnet");
      expect(needs({ faceRefineModel: FULL })).toEqual(expect.arrayContaining(["faceDetector", "faceClip", "faceVideoVae", "faceAudioVae"]));
    });
  }
});
