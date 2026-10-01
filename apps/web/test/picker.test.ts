import { describe, expect, it } from "vitest";
import type { InputSpec } from "@studai/core";
import type { RecipeInfo } from "../src/api";
import { carryOver, modelGroups } from "../src/picker";

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
