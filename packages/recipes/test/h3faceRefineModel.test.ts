import { describe, expect, it } from "vitest";
import { dryContext, formDefaults, OWN_MODEL, parseInput, type BuildContext } from "@afflatus/core";
import { recipeById } from "../src/index";
import { FACE_REFINE_FULL_STEPS } from "../src/h3/faceRefine";
import { UPSCALE } from "../src/video/upscale";

/** Card #159: the Face refine model, the latent upscaler and SeedVR2's model chosen per clip. */
type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const node = (graph: Graph, ref: unknown) => graph[(ref as [string, number])[0]]!;

const TURBO = "minimax_h3_fused_refdelta_r1024_turbo8.safetensors";
const REF = "minimax_h3_ref2va.safetensors";
const slots = {
  unet: "minimax_h3_fl2va.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors", refUnet: REF, rife: "rife.pth",
  faceRefineUnet: TURBO, faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth",
};
const person = [{ asset: "r1", role: "person" }];
const uploads = { "references.0": "person.png" };
const video = recipeById("h3.video")!;
const swap = recipeById("h3.swap")!;

function build(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}) {
  const built = video.build(parseInput(video, { description: "a", faceRefine: true, references: person, ...values }), dryContext({ seed: 7, slots, uploads, ...ctx }));
  return { built, graph: built.graph as Graph };
}
function buildSwap(values: Record<string, unknown>, ctx: Partial<BuildContext> = {}) {
  const built = swap.build(parseInput(swap, { who: "the man", source: { asset: "v1" }, references: person, faceRefine: true, ...values }), dryContext({
    seed: 7, slots: { ...slots, swapLora: "swap.safetensors", swapUnet: REF }, uploads: { source: "src.mp4", "references.0": "person.png" },
    media: { source: { width: 576, height: 1024, frames: 141, fps: 24, hasSound: true } }, ...ctx,
  }));
  return { built, graph: built.graph as Graph };
}
/** The face pass's sampler (the one on the per-frame denoise), its steps, and the loader its model chain starts from. */
function facePass(graph: Graph) {
  const sampler = of(graph, "SamplerCustomAdvanced").find((n) => node(graph, n.inputs.latent_image).class_type === "H3PerFrameDenoise")!;
  const denoise = node(graph, sampler.inputs.latent_image);
  let model = node(graph, denoise.inputs.model);
  const loras: unknown[] = [];
  while (model.class_type !== "UNETLoader") {
    if (model.class_type === "LoraLoaderModelOnly") loras.push(model.inputs.lora_name);
    model = node(graph, model.inputs.model);
  }
  return { steps: node(graph, sampler.inputs.sigmas).inputs.steps, loader: model, loras };
}

describe("H3 · Face refine model (card #159)", () => {
  it("is the same input, in the same place, on every H3 form, and on no other model's", () => {
    for (const id of ["h3.video", "h3.lipsync", "h3.swap", "h3.motion"]) {
      const inputs = recipeById(id)!.inputs;
      const at = inputs.findIndex((i) => i.id === "faceRefineModel");
      expect(inputs[at - 1]?.id, id).toBe("faceRefine");
      expect(inputs[at], id).toMatchObject({ type: "model", label: "Face refine model", folder: "diffusion_models", slot: "faceRefineUnet", own: true, showWhen: "faceRefine", section: "out" });
      // the "?" says what another model costs
      expect(String(inputs[at]!.note), id).toMatch(/second model to load.*RAM/);
    }
    for (const id of ["scail.motion24", "ltx25.video"]) expect(recipeById(id)?.inputs.some((i) => i.id === "faceRefineModel"), id).toBe(false);
  });

  it("starts on the clip's own model on Swap, on the fused turbo elsewhere, and on the clip's own where that file is missing", () => {
    const start = (id: string, options: string[]) => formDefaults(recipeById(id)! as never, { options: { faceRefineModel: options } }, [], {}).defaults.faceRefineModel;
    expect(start("h3.swap", [TURBO, OWN_MODEL, REF])).toBe(OWN_MODEL);
    for (const id of ["h3.video", "h3.lipsync", "h3.motion"]) {
      // the setup lists the slot's file first, then the clip's own (capabilities); without the file, the clip's own first
      expect(start(id, [TURBO, OWN_MODEL, REF]), id).toBe(TURBO);
      expect(start(id, [OWN_MODEL, REF]), id).toBe(OWN_MODEL);
    }
  });

  it("starts SeedVR2's and the latent upscaler's model on a file of their kind, or none: never another model of the folder", () => {
    const start = (options: Record<string, string[]>) => formDefaults(video as never, { options }, [], {}).defaults;
    expect(start({ seedvrModel: [REF, TURBO] }).seedvrModel).toBe("");
    expect(start({ seedvrModel: ["seedvr2_3b.safetensors", REF] }).seedvrModel).toBe("seedvr2_3b.safetensors");
    expect(start({ upscaleLatentModel: ["minimax_h3_latent_upscaler_3d_v1.safetensors"] }).upscaleLatentModel).toBe("minimax_h3_latent_upscaler_3d_v1.safetensors");
  });

  it("runs on the clip's own loader: one model in memory, a full model's steps", () => {
    const { built, graph } = build({ faceRefineModel: OWN_MODEL });
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF]);
    const pass = facePass(graph);
    expect(pass.loader.inputs.unet_name).toBe(REF);
    expect(pass.steps).toBe(FACE_REFINE_FULL_STEPS);
    // none of the clip's LoRAs on the face pass's chain, and its file is counted once
    expect(built.loads.filter((f) => f === `diffusion_models/${REF}`)).toHaveLength(1);
    expect(built.passes?.at(-1)?.steps).toBe(FACE_REFINE_FULL_STEPS);
  });

  it("is the clip's loader too when the file picked is the clip's", () => {
    const { graph } = build({ faceRefineModel: REF });
    expect(of(graph, "UNETLoader")).toHaveLength(1);
  });

  it("left out (a clip made before), runs on the fused turbo at 4 steps, as before", () => {
    const { built, graph } = build({});
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF, TURBO]);
    expect(facePass(graph)).toMatchObject({ steps: 4, loader: { inputs: { unet_name: TURBO } } });
    expect(built.loads).toContain(`diffusion_models/${TURBO}`);
    // a draft that saved the old default (4) runs it, as typed
    expect(facePass(build({ faceRefineSteps: 4, faceRefineModel: OWN_MODEL }).graph).steps).toBe(4);
  });

  it("takes the steps typed over the model's", () => {
    expect(facePass(build({ faceRefineSteps: 6 }).graph).steps).toBe(6);
    expect(facePass(build({ faceRefineSteps: 12, faceRefineModel: OWN_MODEL }).graph).steps).toBe(12);
  });

  it("left out with no fused turbo here, runs on the clip's own model", () => {
    const { graph } = build({}, { slots: { ...slots, faceRefineUnet: undefined as never } });
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF]);
    expect(of(graph, "H3FaceStitch")).toHaveLength(1);
  });

  it("on a clip made by the frames model (no person picture, a first frame), takes the fused turbo, else the reference model, and says so", () => {
    const opening = { references: [], start: "s1" };
    const ctx = { uploads: { start: "s.png" } };
    const turbo = build({ ...opening, faceRefineModel: OWN_MODEL }, ctx);
    expect(facePass(turbo.graph).loader.inputs.unet_name).toBe(TURBO);
    expect(turbo.built.warnings?.join(" ")).toMatch(/ran on minimax_h3_fused_refdelta_r1024_turbo8\.safetensors: the clip's own model follows no picture/);
    const ref = build({ ...opening, faceRefineModel: OWN_MODEL }, { ...ctx, slots: { ...slots, faceRefineUnet: undefined as never } });
    expect(facePass(ref.graph)).toMatchObject({ steps: FACE_REFINE_FULL_STEPS, loader: { inputs: { unet_name: REF } } });
  });

  it("on a swap, runs on the swap's model by default, and on the turbo for a swap made before", () => {
    const own = buildSwap({ faceRefineModel: OWN_MODEL });
    expect(of(own.graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF]);
    expect(facePass(own.graph).steps).toBe(FACE_REFINE_FULL_STEPS);
    const before = buildSwap({});
    expect(of(before.graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF, TURBO]);
    // a swap model that is a fused turbo itself: its own 4 steps
    const fused = buildSwap({ faceRefineModel: OWN_MODEL, swapModel: TURBO });
    expect(facePass(fused.graph)).toMatchObject({ steps: 4, loader: { inputs: { unet_name: TURBO } } });
    expect(of(fused.graph, "UNETLoader")).toHaveLength(1);
  });

  it("keeps the clip's turbo LoRA on its own model with Turbo on, at 4 steps; the swap's LoRA and the user's stay out", () => {
    const turbo = { refTurbo: "minimax_h3_ref2v_turbo_4step.safetensors" };
    const on = buildSwap({ faceRefineModel: OWN_MODEL, fast: true, loras: [{ file: "zz-test-style.safetensors", weight: 0.5 }] }, { slots: { ...slots, swapLora: "swap.safetensors", swapUnet: REF, ...turbo } });
    expect(of(on.graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF]);
    expect(facePass(on.graph)).toMatchObject({ steps: 4, loras: [turbo.refTurbo] });
    const off = buildSwap({ faceRefineModel: OWN_MODEL, fast: false }, { slots: { ...slots, swapLora: "swap.safetensors", swapUnet: REF, ...turbo } });
    expect(facePass(off.graph)).toMatchObject({ steps: FACE_REFINE_FULL_STEPS, loras: [] });
    // a clip of H3's own forms the same: its reference model with the turbo it ran with
    const clip = build({ faceRefineModel: OWN_MODEL, fast: true }, { slots: { ...slots, ...turbo } });
    expect(facePass(clip.graph)).toMatchObject({ steps: 4, loras: [turbo.refTurbo] });
    // and a Finish › Face refine of such a clip, which samples nothing, loads that model and that LoRA, and asks for both
    const finish = build({ faceRefineModel: OWN_MODEL, fast: true, faceRefineOnly: true }, { slots: { ...slots, ...turbo }, uploads: { ...uploads, "self.latent": "own.safetensors" } });
    expect(facePass(finish.graph)).toMatchObject({ steps: 4, loras: [turbo.refTurbo], loader: { inputs: { unet_name: REF } } });
    expect(finish.built.loads).toContain(`loras/${turbo.refTurbo}`);
    expect(video.needsWith!(parseInput(video, { description: "a", faceRefine: true, references: person, faceRefineModel: OWN_MODEL, fast: true, faceRefineOnly: true }), { ...slots, ...turbo })).toEqual(expect.arrayContaining(["refUnet", "refTurbo"]));
    // on a fresh pod, with neither turbo LoRA, the reference one it was made with is asked for, never the usual one
    const fresh = video.needsWith!(parseInput(video, { description: "a", faceRefine: true, references: person, faceRefineModel: OWN_MODEL, fast: true, faceRefineOnly: true }), slots);
    expect(fresh).toEqual(expect.arrayContaining(["refUnet", "refTurbo"]));
    expect(fresh).not.toContain("turbo");
    // (with only the usual one there, the clip ran on it, and that one is kept)
    expect(video.needsWith!(parseInput(video, { description: "a", faceRefine: true, references: person, faceRefineModel: OWN_MODEL, fast: true, faceRefineOnly: true }), { ...slots, turbo: "minimax_h3_turbo.safetensors" })).toContain("turbo");
    // another file picked runs as it is: no LoRA of the clip's on it
    expect(facePass(build({ fast: true }, { slots: { ...slots, ...turbo } }).graph)).toMatchObject({ steps: 4, loras: [], loader: { inputs: { unet_name: TURBO } } });
  });

  it("in a Finish › Face refine, which samples nothing, loads only the clip's own file", () => {
    const { graph } = build({ faceRefineOnly: true, faceRefineModel: OWN_MODEL }, { uploads: { ...uploads, "self.latent": "own.safetensors" } });
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([REF]);
    expect(of(graph, "SamplerCustomAdvanced")).toHaveLength(1);
  });

  it("asks a machine for the file it runs on, and nothing more for the clip's own", () => {
    const needs = (values: Record<string, unknown>) => video.needsWith!(parseInput(video, { description: "a", faceRefine: true, references: person, ...values }), slots);
    expect(needs({})).toContain("faceRefineUnet");
    expect(needs({ faceRefineModel: OWN_MODEL })).not.toContain("faceRefineUnet");
    // a file picked is asked by its own input, as any model input's
    expect(needs({ faceRefineModel: "other_h3_ref.safetensors" })).not.toContain("faceRefineUnet");
    // a Finish › Face refine on the clip's own asks for the reference model it loads (referenceNeeds asks none for it)
    expect(needs({ faceRefineModel: OWN_MODEL, faceRefineOnly: true })).toContain("refUnet");
    // the frames model follows no picture: the fused turbo is asked for
    expect(video.needsWith!(parseInput(video, { description: "a", faceRefine: true, start: "s1", faceRefineModel: OWN_MODEL }), slots)).toContain("faceRefineUnet");
  });
});

describe("H3 · upscale models per clip (card #159)", () => {
  it("enlarges with the latent upscaler picked, and asks for the family's only when none is", () => {
    const up = "minimax_h3_latent_upscaler_3d_v2.safetensors";
    const { graph } = build({ faceRefine: false, upscale: UPSCALE.latent, upscaleLatentModel: up }, { slots: { ...slots, latentUpscaler: "minimax_h3_latent_upscaler_3d_v1.safetensors" } });
    expect(of(graph, "MMH3LatentUpscaleWithModelParams").map((n) => n.inputs.model_name)).toEqual([up]);
    const needs = (values: Record<string, unknown>) => video.needsWith!(parseInput(video, { description: "a", upscale: UPSCALE.latent, ...values }), slots);
    expect(needs({})).toContain("latentUpscaler");
    expect(needs({ upscaleLatentModel: up })).not.toContain("latentUpscaler");
    // the re-sampling stays on the clip's own model
    expect(video.inputs.find((i) => i.id === "upscaleLatentModel")).toMatchObject({ type: "model", slot: "latentUpscaler", showWhen: { input: "upscaleWith" } });
  });

  it("restores with the SeedVR2 model picked, on every video form", () => {
    const seven = "seedvr2_7b_int8.safetensors";
    const { graph } = build({ faceRefine: false, upscale: UPSCALE.seedvr, seedvrModel: seven }, { slots: { ...slots, seedvr: "seedvr2_3b_int8.safetensors", seedvrVae: "seedvr2_vae.safetensors" }, vram: 48 });
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).toContain(seven);
    expect(of(graph, "UNETLoader").map((n) => n.inputs.unet_name)).not.toContain("seedvr2_3b_int8.safetensors");
    // the 7B's window (49 frames, 2 shared, on a card that holds it), read from the file picked
    expect(of(graph, "SeedVR2TemporalChunk")[0]!.inputs.temporal_overlap).toBe(2);
    const needs = video.needsWith!(parseInput(video, { description: "a", upscale: UPSCALE.seedvr, seedvrModel: seven }), slots);
    expect(needs).toContain("seedvrVae");
    expect(needs).not.toContain("seedvr");
    for (const id of ["h3.video", "h3.swap", "wan.video", "ltx.video"]) {
      expect(recipeById(id)!.inputs.find((i) => i.id === "seedvrModel"), id).toMatchObject({ type: "model", slot: "seedvr" });
    }
  });
});
