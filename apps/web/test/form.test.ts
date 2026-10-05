import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import type { ModelSettings, RecipeInfo } from "../src/api";
import { formDefaults, matchFiles } from "../src/form";

const recipe = (inputs: InputSpec[], presets?: RecipeInfo["presets"]): RecipeInfo =>
  ({ id: "sdxl.text", family: "sdxl", version: 1, title: "Text to picture", summary: "A picture.", output: "image", inputs, traits: null, ...(presets ? { presets } : {}) });

const inputs: InputSpec[] = [
  { id: "model", type: "model", label: "Model", folder: "checkpoints" },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 20, perModel: true },
  { id: "cfg", type: "number", label: "CFG", min: 1, max: 20, step: 0.5, default: 7 },
  { id: "prompt", type: "prompt", label: "Prompt", style: "tags" },
];
const options = { model: ["High\\pony.safetensors", "juggernaut.safetensors"] };

describe("what a form starts from", () => {
  it("is the recipe's defaults, the first model file picked", () => {
    const d = formDefaults(recipe(inputs), options, [], undefined);
    expect(d.defaults).toMatchObject({ model: "High\\pony.safetensors", steps: 20, cfg: 7, prompt: "" });
    expect(d.file).toBe("High\\pony.safetensors");
    expect(d.hasSaved).toBe(false);
  });
  it("lays the settings saved for the picked file over them, for the per-model inputs only", () => {
    const saved: ModelSettings[] = [{ family: "sdxl", file: "juggernaut.safetensors", values: { steps: 30, cfg: 3 } }];
    const d = formDefaults(recipe(inputs), options, saved, { model: "juggernaut.safetensors" });
    expect(d.defaults.steps).toBe(30);
    // cfg is not a per-model setting: what was saved for it is not taken
    expect(d.defaults.cfg).toBe(7);
    expect(d.hasSaved).toBe(true);
  });
  it("reads a line's recommended settings from the file's name while nothing is saved for it", () => {
    const d = formDefaults(recipe(inputs, [{ match: "pony", note: "Pony likes few steps", values: { steps: 12 } }]), options, [], undefined);
    expect(d.defaults.steps).toBe(12);
    expect(d.preset).toBe("Pony likes few steps");
  });
});

describe("a preset's model files, as this ComfyUI names them", () => {
  it("takes the same file under another folder for the same file", () => {
    expect(matchFiles(recipe(inputs), options, { model: "pony.safetensors", steps: 5 })).toEqual({ model: "High\\pony.safetensors", steps: 5 });
  });
  it("leaves a file this ComfyUI does not have as it is", () => {
    expect(matchFiles(recipe(inputs), options, { model: "elsewhere.safetensors" }).model).toBe("elsewhere.safetensors");
  });
});
