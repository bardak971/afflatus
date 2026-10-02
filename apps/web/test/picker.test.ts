import { describe, expect, it } from "vitest";
import type { InputSpec } from "@studai/core";
import type { RecipeInfo } from "../src/api";
import { carryAcross, carryOver, followOn, modelGroups, usedLast } from "../src/picker";

const recipe = (id: string, family: string, title: string, inputs: InputSpec[] = [], output: RecipeInfo["output"] = "image"): RecipeInfo =>
  ({ id, family, version: 1, title, summary: `${title}.`, output, inputs, traits: null });

const base: InputSpec[] = [
  { id: "model", type: "model", label: "Model", folder: "diffusion_models" },
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 8 },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler" },
  { id: "seed", type: "seed", label: "Seed" },
];
const txt2img = recipe("k.txt2img", "k", "txt2img", [
  { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" },
  { id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048, shapes: [{ id: "tall", label: "Portrait", width: 896, height: 1152 }] },
  { id: "hires", type: "toggle", label: "Hires fix", default: false },
  ...base,
]);
const img2img = recipe("k.img2img", "k", "img2img", [
  { id: "source", type: "image", role: "source", label: "Image" },
  { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" },
  { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 1, step: 0.05, default: 0.55 },
  ...base,
]);
const inpaint = recipe("k.inpaint", "k", "Inpaint", [
  { id: "source", type: "image", role: "source", label: "Image" },
  { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" },
  { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" },
  { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 1, step: 0.05, default: 0.8 },
  ...base,
]);

describe("what a form keeps when the operation changes", () => {
  const set = { prompt: "a lighthouse", model: "mine.safetensors", loras: [{ file: "l.safetensors", weight: 0.8 }], steps: 25, sampler: "er_sde", seed: 42, size: { width: 1152, height: 1536 }, hires: true };

  it("takes along the prompt, the model, the LoRAs and how it samples; what the other form has no place for stays behind", () => {
    expect(carryOver(txt2img, img2img, set, undefined)).toEqual({ prompt: "a lighthouse", model: "mine.safetensors", loras: [{ file: "l.safetensors", weight: 0.8 }], steps: 25, sampler: "er_sde", seed: 42 });
  });

  it("leaves each operation its own denoising strength, and takes the picture along", () => {
    const there = { ...set, source: "asset-1", strength: 0.3 };
    // img2img starts at 0.55 and inpaint at 0.8: 0.3 was chosen for the one, not for the other
    expect(carryOver(img2img, inpaint, there, undefined)).toMatchObject({ source: "asset-1", prompt: "a lighthouse", steps: 25 });
    expect(carryOver(img2img, inpaint, there, undefined)).not.toHaveProperty("strength");
    expect(carryOver(img2img, inpaint, there, undefined)).not.toHaveProperty("mask");
  });

  it("never replaces what the form it goes to already holds, and takes nothing that was not set", () => {
    expect(carryOver(txt2img, img2img, { prompt: "a lighthouse", steps: 25 }, { prompt: "a harbour" })).toEqual({ steps: 25 });
    expect(carryOver(txt2img, img2img, undefined, undefined)).toEqual({});
    expect(carryOver(txt2img, img2img, {}, undefined)).toEqual({});
  });

  it("keeps a number within what the other form takes, and reference pictures of the kinds it takes", () => {
    const few = recipe("k.few", "k", "Few", [{ id: "steps", type: "number", label: "Steps", min: 1, max: 20, step: 1, default: 8 }, { id: "references", type: "references", label: "Refs", max: 1, roles: ["person"] }]);
    const many = recipe("k.many", "k", "Many", [{ id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 8 }, { id: "references", type: "references", label: "Refs", max: 6, roles: ["person", "place"] }]);
    const refs = [{ asset: "p", role: "place" }, { asset: "a", role: "person" }, { asset: "b", role: "person" }];
    expect(carryOver(many, few, { steps: 45, references: refs }, undefined)).toEqual({ steps: 20, references: [{ asset: "a", role: "person" }] });
  });
});

describe("the models to choose from", () => {
  const families = [
    { id: "sdxl", name: "SDXL", summary: "Tags." },
    { id: "krea2", name: "Krea 2", summary: "Sentences." },
    { id: "workflow-krea2", name: "Krea2", summary: "From your own workflow." },
    { id: "workflow-wan-2-2", name: "Wan 2.2", summary: "From your own workflow." },
  ];
  const recipes = [
    recipe("sdxl.t", "sdxl", "txt2img"), recipe("krea2.t", "krea2", "txt2img"), recipe("krea2.i", "krea2", "img2img"),
    recipe("workflow.mine", "workflow-krea2", "My Krea workflow"), recipe("workflow.wan", "workflow-wan-2-2", "Picture to video"),
    recipe("orphan.x", "gone", "Left over"),
  ];

  it("are the families, each with its operations: a workflow imported under a built-in model's name is listed with it", () => {
    const groups = modelGroups(recipes, families);
    expect(groups.map((g) => [g.name, g.builtIn, g.recipes.map((r) => r.id)])).toEqual([
      ["SDXL", true, ["sdxl.t"]],
      // "Krea2" and "Krea 2" are one name: the built-in operations, then the workflow
      ["Krea 2", true, ["krea2.t", "krea2.i", "workflow.mine"]],
      ["Wan 2.2", false, ["workflow.wan"]],
      // a recipe whose family is not listed is not lost
      ["gone", false, ["orphan.x"]],
    ]);
  });

  it("take the built-in model's name whichever comes first", () => {
    const groups = modelGroups(recipes, [families[2]!, families[1]!]);
    expect(groups.map((g) => [g.name, g.builtIn, g.recipes.map((r) => r.id)])[0]).toEqual(["Krea 2", true, ["krea2.t", "krea2.i", "workflow.mine"]]);
  });
});

describe("a clip that carries on from another", () => {
  const clipInputs = (steps: number): InputSpec[] => [
    { id: "model", type: "model", label: "Model", folder: "diffusion_models" },
    { id: "description", type: "prompt", label: "What happens", style: "sentences" },
    { id: "soundscape", type: "prompt", label: "Sounds", style: "sentences", optional: true },
    { id: "start", type: "image", role: "start", label: "Start image", optional: true },
    { id: "previous", type: "clip", role: "previous", label: "Continues from", optional: true, frames: 5, fps: 24 },
    { id: "seconds", type: "number", label: "Length", min: 2, max: 15, step: 0.5, default: 5 },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: steps },
    { id: "fast", type: "toggle", label: "Turbo", default: true },
    { id: "loras", type: "loras", label: "LoRAs", max: 6 },
    { id: "seed", type: "seed", label: "Seed" },
  ];
  const video = recipe("v.video", "v", "Video", clipInputs(15), "video");
  const made = {
    model: "fine-tune.safetensors", description: "she walks to the window", soundscape: "rain on the glass", start: "picture-1",
    previous: { asset: "clip-0" }, seconds: 8, steps: 22, fast: false, loras: [{ name: "motion.safetensors", strength: 0.8 }], seed: 1234, gone: "an input the form no longer has",
  };

  it("starts with the settings the other was made with, on the same model", () => {
    expect(followOn(video, video, made)).toEqual({
      model: "fine-tune.safetensors", soundscape: "rain on the glass", seconds: 8, steps: 22, fast: false, loras: [{ name: "motion.safetensors", strength: 0.8 }],
    });
  });

  it("leaves behind what was the other clip's own: what happened in it, its pictures, the clip it joined, its seed", () => {
    const kept = followOn(video, video, made);
    for (const id of ["description", "start", "previous", "seed", "gone"]) expect(kept).not.toHaveProperty(id);
  });

  it("on another model, only what describes the clip goes along: never the model file, the LoRAs, or how the first model was run", () => {
    const run: InputSpec[] = [
      { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "BasicScheduler", input: "scheduler" }, default: "simple", advanced: true },
      { id: "shift", type: "number", label: "Shift", min: 0, max: 30, step: 0.5, default: 0, perModel: true },
    ];
    const first = recipe("v.video", "v", "Video", [...clipInputs(15), ...run], "video");
    const other = recipe("w.video", "w", "Video", [...clipInputs(15), ...run], "video");
    const kept = followOn(first, other, { ...made, scheduler: "linear_quadratic", shift: 9 });
    // a form of one model holding the file of another renders nothing
    expect(kept).not.toHaveProperty("model");
    expect(kept).not.toHaveProperty("loras");
    expect(kept).not.toHaveProperty("scheduler");
    expect(kept).not.toHaveProperty("shift");
    expect(kept).toMatchObject({ seconds: 8, soundscape: "rain on the glass" });
    expect(kept).not.toHaveProperty("description");
    expect(kept).not.toHaveProperty("seed");
    // on the same model, all of it stays
    expect(followOn(first, first, { ...made, scheduler: "linear_quadratic", shift: 9 })).toMatchObject({ model: "fine-tune.safetensors", scheduler: "linear_quadratic", shift: 9 });
  });

  it("starts empty when how the clip was made is not known", () => {
    expect(followOn(undefined, video, made)).toEqual({});
    expect(followOn(video, video, undefined)).toEqual({});
  });
});

describe("picking another model in the form", () => {
  const one = recipe("a.video", "a", "Video", [
    { id: "model", type: "model", label: "Model", folder: "diffusion_models" },
    { id: "description", type: "prompt", label: "What happens", style: "sentences" },
    { id: "soundscape", type: "prompt", label: "Sounds", style: "sentences", optional: true },
    { id: "start", type: "image", role: "start", label: "Start image", optional: true },
    { id: "end", type: "image", role: "end", label: "End image", optional: true },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 15 },
    { id: "loras", type: "loras", label: "LoRAs", max: 6 },
    { id: "seed", type: "seed", label: "Seed" },
  ], "video");
  const other = recipe("b.video", "b", "Video", [
    { id: "model", type: "model", label: "High-noise model", folder: "diffusion_models" },
    { id: "prompt", type: "prompt", label: "What happens", style: "sentences" },
    { id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true },
    { id: "startImage", type: "image", role: "start", label: "Start image", optional: true },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 15 },
    { id: "loras", type: "loras", label: "LoRAs", max: 6 },
    { id: "seed", type: "seed", label: "Seed" },
  ], "video");
  const filled = { model: "one.safetensors", description: "she turns to the camera", soundscape: "wind", start: "picture-1", end: "picture-2", steps: 30, loras: [{ file: "x.safetensors", weight: 1 }], seed: 7 };

  it("the start image stays the start image, whatever the other form calls it, and what is written goes along", () => {
    expect(carryAcross(one, other, filled, undefined)).toEqual({ startImage: "picture-1", prompt: "she turns to the camera" });
  });

  it("nothing of how the first model was run goes along", () => {
    const taken = carryAcross(one, other, filled, undefined);
    for (const id of ["model", "steps", "loras", "seed", "negative"]) expect(taken).not.toHaveProperty(id);
  });

  it("what the other form already holds is not replaced", () => {
    expect(carryAcross(one, other, filled, { startImage: "picture-9", prompt: "its own words" })).toEqual({});
    expect(carryAcross(one, other, filled, { prompt: "  " })).toEqual({ startImage: "picture-1", prompt: "she turns to the camera" });
  });

  it("words written for another kind of prompt stay behind", () => {
    const tags = recipe("c.video", "c", "Video", [{ id: "prompt", type: "prompt", label: "Prompt", style: "tags" }, { id: "start", type: "image", role: "start", label: "Start image" }], "video");
    expect(carryAcross(one, tags, filled, undefined)).toEqual({ start: "picture-1" });
  });
});

describe("the model a new draft opens on", () => {
  const ways = [{ id: "h3.video" }, { id: "wan.video" }, { id: "ltx.video" }];
  const all = () => true;

  it("is the one used last: the newest draft made with one of them", () => {
    const drafts = [{ recipe: "sdxl.text-to-picture" }, { recipe: "ltx.video" }, { recipe: "wan.video" }, { recipe: "h3.video" }];
    expect(usedLast(ways, drafts, all)?.id).toBe("ltx.video");
  });

  it("is never one that is not offered (switched off, or not a video)", () => {
    expect(usedLast(ways.slice(0, 2), [{ recipe: "ltx.video" }, { recipe: "wan.video" }], all)?.id).toBe("wan.video");
  });

  it("with no such draft, is the first that is ready, else the first", () => {
    expect(usedLast(ways, [{ recipe: "sdxl.text-to-picture" }], (r) => r.id !== "h3.video")?.id).toBe("wan.video");
    expect(usedLast(ways, undefined, () => false)?.id).toBe("h3.video");
    expect(usedLast([], [], all)).toBeUndefined();
  });
});
