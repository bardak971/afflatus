import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { recipeFromWorkflow, workflowDef } from "../src";

/**
 * The sections the importer arranges: chapters of the form in their order, a switch at a section's
 * head that folds it and bypasses its nodes.
 */
const graph: Graph = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a parrot", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "10": { class_type: "LatentUpscaleBy", inputs: { samples: ["3", 0], upscale_method: "nearest-exact", scale_by: 1.5 } },
  "11": { class_type: "KSampler", inputs: { seed: 1, steps: 12, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.4, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["10", 0] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out" } },
};

const control = (id: string, node: string, input: string, label: string, value: number, extra: Record<string, unknown> = {}) =>
  ({ id, label, target: { node, input }, kind: "number", default: value, min: 0, max: 100, step: 1, ...extra });

const def = workflowDef.parse({
  id: "workflow.sections", title: "Sections", model: "SDXL", graph,
  wiring: {
    modes: {}, fallback: {}, frames: [{ title: "Upscale", nodes: ["10", "11"] }],
    // what each socket carries, as the reader writes it: a bypassed node passes its input of the same type through
    slots: {
      "10": { in: [["samples", "LATENT"]], out: ["LATENT"] },
      "11": { in: [["model", "MODEL"], ["positive", "CONDITIONING"], ["negative", "CONDITIONING"], ["latent_image", "LATENT"]], out: ["LATENT"] },
      "8": { in: [["samples", "LATENT"], ["vae", "VAE"]], out: ["IMAGE"] },
    },
  },
  bindings: {
    prompt: { node: "6", input: "text" },
    seeds: [{ node: "3", input: "seed" }, { node: "11", input: "seed" }],
    loras: [],
    controls: [
      control("ctl_3_steps", "3", "steps", "Steps", 20),
      control("ctl_3_cfg", "3", "cfg", "CFG", 7),
      control("ctl_10_scale_by", "10", "scale_by", "Scale by", 1.5, { step: 0.05, max: 4 }),
      control("ctl_11_denoise", "11", "denoise", "Second pass denoise", 0.4, { step: 0.05, max: 1 }),
    ],
    toggles: [{ id: "sw_made_1", label: "Upscale ×1.5", default: true, effects: [{ nodes: ["10", "11"], activeWhen: true, mode: "bypass" }], writes: [], front: true, made: true }],
    sections: [
      { id: "sec_1", label: "Sampling", items: ["ctl_3_cfg", "ctl_3_steps", "seed"] },
      { id: "sec_2", label: "Output", items: [{ toggle: "sw_made_1", items: ["ctl_10_scale_by", "ctl_11_denoise"] }] },
    ],
    result: { node: "9", kind: "image", sound: false },
  },
});

describe("the importer's sections", () => {
  const recipe = recipeFromWorkflow(def);

  it("become chapters of the form, in their order, with the switch at the head of the one that has it", () => {
    expect(recipe.chapters).toEqual([{ id: "sec_1", label: "Sampling" }, { id: "sec_2", label: "Output" }]);
    const ids = recipe.inputs.map((i) => i.id);
    // the section's own order, not the mapping's; the switch leads its section
    // the mapping's own inputs (the seed here) can be placed too
    expect(ids.slice(0, 6)).toEqual(["ctl_3_cfg", "ctl_3_steps", "seed", "sw_made_1", "ctl_10_scale_by", "ctl_11_denoise"]);
    const by = Object.fromEntries(recipe.inputs.map((i) => [i.id, i]));
    expect(by.seed).toMatchObject({ type: "seed", chapter: "sec_1" });
    expect(by.ctl_3_cfg).toMatchObject({ chapter: "sec_1", advanced: false });
    expect(by.ctl_3_cfg!.showWhen).toBeUndefined();
    // a setting of a switched section shows while the switch is on
    expect(by.ctl_10_scale_by).toMatchObject({ chapter: "sec_2", advanced: false, showWhen: "sw_made_1" });
    expect(by.ctl_11_denoise).toMatchObject({ chapter: "sec_2", showWhen: "sw_made_1" });
    expect(by.sw_made_1).toMatchObject({ type: "toggle", chapter: "sec_2", default: true, advanced: false });
    // what is in no section keeps its place
    expect(by.prompt!.chapter).toBeUndefined();
  });

  it("bypasses the section's nodes when its switch is off", () => {
    const on = recipe.build(parseInput(recipe, { prompt: "a parrot" }), dryContext());
    expect(on.graph["8"]!.inputs.samples).toEqual(["11", 0]);
    expect(on.totalSteps).toBe(32);
    const off = recipe.build(parseInput(recipe, { prompt: "a parrot", sw_made_1: false }), dryContext());
    // the upscale and the second pass are gone; the decoder reads the first pass
    expect(off.graph["10"]).toBeUndefined();
    expect(off.graph["11"]).toBeUndefined();
    expect(off.graph["8"]!.inputs.samples).toEqual(["3", 0]);
    expect(off.totalSteps).toBe(20);
  });

  it("puts the Advanced chapter where a section called \"advanced\" stands among the others", () => {
    const moved = recipeFromWorkflow(workflowDef.parse({
      ...def,
      bindings: { ...def.bindings, sections: [def.bindings.sections[0], { id: "advanced", label: "Advanced", items: [] }, def.bindings.sections[1]] },
    }));
    expect(moved.chapters!.map((c) => c.id)).toEqual(["sec_1", "advanced", "sec_2"]);
    // the prompt block too, by a section called "prompt"
    const promptLast = recipeFromWorkflow(workflowDef.parse({ ...def, bindings: { ...def.bindings, sections: [...def.bindings.sections, { id: "prompt", label: "Prompt", items: [] }] } }));
    expect(promptLast.chapters!.map((c) => c.id)).toEqual(["sec_1", "sec_2", "prompt"]);
    // without the mark, the form puts Advanced last: the recipe says nothing
    expect(recipe.chapters!.map((c) => c.id)).toEqual(["sec_1", "sec_2"]);
  });

  it("leaves out a switch that is not in the mapping and an item that is not a control; a section left empty stays a chapter (the form leaves it out)", () => {
    const odd = recipeFromWorkflow(workflowDef.parse({
      ...def,
      bindings: { ...def.bindings, toggles: [], sections: [{ id: "sec_x", label: "Gone", items: [{ toggle: "sw_nowhere", items: ["ctl_3_steps"] }] }, { id: "sec_y", label: "Half", items: ["ctl_3_cfg", "ctl_none"] }] },
    }));
    expect(odd.chapters).toEqual([{ id: "sec_x", label: "Gone" }, { id: "sec_y", label: "Half" }]);
    expect(odd.inputs.find((i) => i.id === "ctl_3_steps")!.chapter).toBeUndefined();
    expect(odd.inputs.find((i) => i.id === "ctl_3_cfg")!.chapter).toBe("sec_y");
  });
});
