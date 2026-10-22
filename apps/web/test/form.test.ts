import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import type { ModelSettings, RecipeInfo } from "../src/api";
import { formDefaults, layoutOf, matchFiles, pinnable, pinSaid, sectionsOf, whyHidden } from "../src/form";
import { withFamilyPins } from "../src/recipeForm/pinned";

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
    const d = formDefaults(recipe(inputs), { options }, [], undefined);
    expect(d.defaults).toMatchObject({ model: "High\\pony.safetensors", steps: 20, cfg: 7, prompt: "" });
    expect(d.file).toBe("High\\pony.safetensors");
    expect(d.hasSaved).toBe(false);
  });
  it("lays the settings saved for the picked file over them, for the per-model inputs only", () => {
    const saved: ModelSettings[] = [{ family: "sdxl", file: "juggernaut.safetensors", values: { steps: 30, cfg: 3 } }];
    const d = formDefaults(recipe(inputs), { options }, saved, { model: "juggernaut.safetensors" });
    expect(d.defaults.steps).toBe(30);
    // cfg is not a per-model setting: what was saved for it is not taken
    expect(d.defaults.cfg).toBe(7);
    expect(d.hasSaved).toBe(true);
  });
  it("reads a line's recommended settings from the file's name while nothing is saved for it", () => {
    const d = formDefaults(recipe(inputs, [{ match: "pony", note: "Pony likes few steps", values: { steps: 12 } }]), { options }, [], undefined);
    expect(d.defaults.steps).toBe(12);
    expect(d.preset).toBe("Pony likes few steps");
  });
  it("takes every preset whose pattern matches, each setting from the first that has it", () => {
    const presets = [{ match: "dmd", note: "few steps", values: { steps: 8, cfg: 1 } }, { match: "pony", note: "Pony's CFG", values: { steps: 25, cfg: 7, prompt: "score_9" } }];
    const d = formDefaults(recipe(inputs, presets), { options: { model: ["ponyDMD2.safetensors"] } }, [], undefined);
    expect(d.defaults).toMatchObject({ steps: 8, cfg: 1, prompt: "score_9" });
    expect(d.preset).toBe("few steps · Pony's CFG");
  });
  it("moves what a switch moves when it is on (Turbo: the turbo LoRA's shift), unless the model's line sets it", () => {
    const turbo: InputSpec[] = [
      { id: "model", type: "model", label: "Model", folder: "diffusion_models" },
      { id: "fast", type: "toggle", label: "Turbo", default: false, whenOn: { shift: 12 }, perModel: true },
      { id: "shift", type: "number", label: "Shift", min: 0, max: 30, step: 0.5, default: 11, perModel: true },
    ];
    expect(formDefaults(recipe(turbo), { options: { model: ["h3.safetensors"] } }, [], undefined).defaults.shift).toBe(11);
    expect(formDefaults(recipe(turbo), { options: { model: ["h3.safetensors"] } }, [], { fast: true }).defaults.shift).toBe(12);
    // a distilled file's own shift, from its line, stays
    const lined = recipe(turbo, [{ match: "turbo", note: "a distilled file", values: { fast: true, shift: 8 } }]);
    expect(formDefaults(lined, { options: { model: ["h3_turboV3.safetensors"] } }, [], undefined).defaults).toMatchObject({ fast: true, shift: 8 });
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

describe("pinned fields", () => {
  const specs: InputSpec[] = [
    { id: "prompt", type: "prompt", label: "Prompt", style: "tags" },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 28, advanced: true },
    { id: "hires", type: "toggle", label: "Hires fix", default: false, advanced: true },
    { id: "hiresDenoise", type: "number", label: "Denoising", min: 0.1, max: 0.8, step: 0.05, default: 0.45, advanced: true, showWhen: "hires" },
    { id: "upscaler", type: "choice", label: "Upscaler", options: ["None", "4x"], default: "None", advanced: true, showWhen: "hires" },
    { id: "tile", type: "number", label: "Tile", min: 0, max: 1, step: 0.1, default: 0.5, advanced: true, showWhen: { input: "upscaler", in: ["4x"] } },
  ];
  it("pin the settings, not the texts or the pictures", () => {
    expect(specs.filter(pinnable).map((i) => i.id)).toEqual(["steps", "hires", "hiresDenoise", "upscaler", "tile"]);
  });
  it("say why one is not shown: the first setting up the chain that hides it", () => {
    expect(whyHidden(specs[3]!, { hires: false }, specs)).toBe("Hires fix is off");
    expect(whyHidden(specs[5]!, { hires: true, upscaler: "None" }, specs)).toBe("Upscaler is None");
    expect(whyHidden(specs[5]!, { hires: false, upscaler: "4x" }, specs)).toBe("Hires fix is off");
    expect(whyHidden(specs[3]!, { hires: true }, specs)).toBe("");
  });
  it("say where each lives, and what each holds in a few words", () => {
    const at = sectionsOf(layoutOf(recipe(specs), { hires: true }, ""));
    expect(at.get("steps")).toBe("Sampling");
    expect(at.get("hiresDenoise")).toBe("Sampling");
    expect(pinSaid(specs[1]!, 34)).toBe("Steps 34");
    expect(pinSaid(specs[2]!, true)).toBe("Hires fix on");
    expect(pinSaid(specs[4]!, "4x")).toBe("Upscaler 4x");
  });
  it("keep each family's list, and drop a family left with none", () => {
    expect(withFamilyPins({ h3: ["shot"] }, "sdxl", ["cfg", "cfg", "steps"])).toEqual({ h3: ["shot"], sdxl: ["cfg", "steps"] });
    expect(withFamilyPins({ h3: ["shot"], sdxl: ["cfg"] }, "sdxl", [])).toEqual({ h3: ["shot"] });
  });
});
