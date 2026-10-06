import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { recipeFromWorkflow, workflowDef } from "../src";

/**
 * A preview on a branch the result does not need (a comparison, an upscale shown but not saved): kept
 * as ComfyUI would run it, unless the importer left it out, with the branch that only served it.
 */
const graph: Graph = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a parrot", clip: ["4", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["5", 0] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out" } },
  // a second pass shown as a preview only: its sampler runs for nothing kept
  "10": { class_type: "LatentUpscaleBy", inputs: { samples: ["3", 0], upscale_method: "nearest-exact", scale_by: 2 } },
  "11": { class_type: "KSampler", inputs: { seed: 1, steps: 12, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.5, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["10", 0] } },
  "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["4", 2] } },
  "13": { class_type: "PreviewImage", inputs: { images: ["12", 0] } },
};

const def = (skip: Array<{ node: string; nodes: string[] }>) => workflowDef.parse({
  id: "workflow.skip", title: "Skip", model: "SDXL", graph,
  bindings: { prompt: { node: "6", input: "text" }, seeds: [{ node: "3", input: "seed" }], loras: [], controls: [], skip, result: { node: "9", kind: "image", sound: false } },
});

describe("a preview on a dead end", () => {
  it("runs as ComfyUI would, unless left out with the branch that only served it", () => {
    const kept = recipeFromWorkflow(def([])).build(parseInput(recipeFromWorkflow(def([])), { prompt: "a parrot" }), dryContext());
    expect(Object.keys(kept.graph).sort()).toEqual(["10", "11", "12", "13", "3", "4", "5", "6", "8", "9"]);
    // the step count only follows what the result is made from: the dead end's sampler runs, uncounted (as before)
    expect(kept.totalSteps).toBe(20);
    const recipe = recipeFromWorkflow(def([{ node: "13", nodes: ["10", "11", "12"] }]));
    const out = recipe.build(parseInput(recipe, { prompt: "a parrot" }), dryContext());
    expect(Object.keys(out.graph).sort()).toEqual(["3", "4", "5", "6", "8", "9"]);
    expect(out.totalSteps).toBe(20);
  });

  it("never takes the result out, whatever the list says", () => {
    const recipe = recipeFromWorkflow(def([{ node: "13", nodes: ["9", "8"] }]));
    const out = recipe.build(parseInput(recipe, { prompt: "a parrot" }), dryContext());
    expect(out.graph["9"]).toBeDefined();
    expect(out.outputs[0]!.node).toBe("9");
  });
});
