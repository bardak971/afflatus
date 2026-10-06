import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { recipeFromWorkflow, workflowDef } from "../src";

/**
 * A switch made in Afflatus steps over its part as one: a pass that goes picture → latent → picture
 * (encode, upscale, sample, decode) can be switched off, the reader after it taking the picture that
 * went in, where ComfyUI's own bypass finds no input of the right type on the decoder and gives up.
 */
const graph: Graph = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a parrot", clip: ["4", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["5", 0] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  // the second pass: picture in, picture out, latent in between
  "69": { class_type: "VAEEncode", inputs: { pixels: ["8", 0], vae: ["4", 2] } },
  "71": { class_type: "LatentUpscaleBy", inputs: { samples: ["69", 0], upscale_method: "nearest-exact", scale_by: 1.5 } },
  "81": { class_type: "KSampler", inputs: { seed: 1, steps: 12, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.4, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["71", 0] } },
  "87": { class_type: "VAEDecode", inputs: { samples: ["81", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { images: ["87", 0], filename_prefix: "out" } },
};
const slots = {
  "69": { in: [["pixels", "IMAGE"], ["vae", "VAE"]], out: ["LATENT"] },
  "71": { in: [["samples", "LATENT"]], out: ["LATENT"] },
  "81": { in: [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]], out: ["LATENT"] },
  "87": { in: [["samples", "LATENT"], ["vae", "VAE"]], out: ["IMAGE"] },
  "8": { in: [["samples", "LATENT"], ["vae", "VAE"]], out: ["IMAGE"] },
  "9": { in: [["images", "IMAGE"]], out: [] },
};
const defWith = (mode: "bypass" | "skip") => workflowDef.parse({
  id: "workflow.skipmode", title: "Skip", model: "SDXL", graph,
  wiring: { modes: {}, slots, fallback: {} },
  bindings: {
    prompt: { node: "6", input: "text" }, seeds: [{ node: "3", input: "seed" }], loras: [], controls: [],
    toggles: [{ id: "sw_made_pass2", label: "2nd pass", default: true, effects: [{ nodes: ["69", "71", "81", "87"], activeWhen: true, mode }], writes: [], front: true, made: true }],
    sections: [{ id: "sec_out", label: "Output", items: [{ toggle: "sw_made_pass2", items: [] }] }],
    result: { node: "9", kind: "image", sound: false },
  },
});

describe("a part stepped over as one", () => {
  it("hands the reader after it the picture that went in", () => {
    const recipe = recipeFromWorkflow(defWith("skip"));
    const on = recipe.build(parseInput(recipe, { prompt: "a parrot" }), dryContext());
    expect(on.graph["9"]!.inputs.images).toEqual(["87", 0]);
    expect(on.totalSteps).toBe(32);
    const off = recipe.build(parseInput(recipe, { prompt: "a parrot", sw_made_pass2: false }), dryContext());
    expect(off.graph["9"]!.inputs.images).toEqual(["8", 0]);
    expect(off.graph["81"]).toBeUndefined();
    expect(off.totalSteps).toBe(20);
  });

  it("is what ComfyUI's bypass cannot do here: the decoder has no picture to hand on", () => {
    const recipe = recipeFromWorkflow(defWith("bypass"));
    const off = recipe.build(parseInput(recipe, { prompt: "a parrot", sw_made_pass2: false }), dryContext());
    // the saver lost its picture: the graph is left without the output's link
    expect(off.graph["9"]?.inputs.images).toBeUndefined();
  });
});
