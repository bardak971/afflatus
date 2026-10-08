import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../src/api";
import { layoutOf, matchesQuery, notFilled, sentForm, settingsOnly, summariesOf, upscaledFrame } from "../src/form";

const recipe = (inputs: InputSpec[], output: RecipeInfo["output"] = "image"): RecipeInfo =>
  ({ id: "test.recipe", family: "test", version: 1, title: "Test", summary: "A test.", output, inputs, traits: null });

const picture = recipe([
  { id: "prompt", type: "prompt", label: "Prompt", style: "tags" },
  { id: "negative", type: "prompt", label: "Negative prompt", style: "tags", optional: true, advanced: true },
  { id: "checkpoint", type: "model", label: "Model", folder: "checkpoints" },
  { id: "source", type: "image", label: "Source image", role: "source" },
  { id: "denoise", type: "number", label: "Denoise", min: 0, max: 1, step: 0.05, default: 0.6 },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 60, step: 1, default: 20, advanced: true },
  { id: "crf", type: "number", label: "CRF", min: 0, max: 51, step: 1, default: 19, advanced: true },
  { id: "tileSize", type: "number", label: "Tile size", min: 256, max: 2048, step: 64, default: 1024, advanced: true },
  { id: "hires", type: "toggle", label: "Hires fix", default: false, advanced: true },
  { id: "hiresScale", type: "number", label: "Hires scale", min: 1, max: 4, step: 0.5, default: 2, advanced: true, showWhen: "hires" },
  { id: "seed", type: "seed", label: "Seed" },
]);

describe("which input goes in which part of a form", () => {
  it("files the model and its operation's settings, the prompt and its negative, the frames, what comes out, and the settings by what they are about", () => {
    const l = layoutOf(picture, { hires: false }, "");
    const ids = (list: InputSpec[]) => list.map((i) => i.id);
    expect(l.mainText?.id).toBe("prompt");
    expect(ids(l.texts)).toEqual(["negative"]);
    expect(ids(l.knobs)).toEqual(["checkpoint", "denoise"]);
    expect(ids(l.frames)).toEqual(["source"]);
    expect(ids(l.out)).toEqual(["seed"]);
    expect(ids(l.sampling)).toEqual(["steps"]);
    expect(ids(l.encoding)).toEqual(["crf"]);
    expect(ids(l.rare)).toEqual(["tileSize"]);
    expect(ids(l.upscaling)).toEqual(["hires"]);
    expect(l.hidden).toEqual([]);
  });
  it("keeps, while searching, only what matches, and names what another setting hides", () => {
    const l = layoutOf(picture, { hires: false }, "scale");
    expect(l.upscaling.map((i) => i.id)).toEqual([]);
    expect(l.hidden.map((i) => i.id)).toEqual(["hiresScale"]);
    expect(matchesQuery(picture.inputs.find((i) => i.id === "steps")!, "stps")).toBe(true);
    expect(matchesQuery(picture.inputs.find((i) => i.id === "steps")!, "til")).toBe(false);
  });
  it("says each part in a few words", () => {
    const values = { checkpoint: "sub\\juggernaut.safetensors", denoise: 0.6, steps: 20, seed: -1 };
    const said = summariesOf(picture, layoutOf(picture, values, ""), values, { madeSummary: "SDXL · Img2img" });
    expect(said.modelSaid).toBe("SDXL · Img2img · juggernaut · denoise 0.6");
    expect(said.inputsSaid).toBe("nothing chosen yet");
    expect(said.missing).toBe(true);
    expect(said.outSaid).toBe("seed: random");
    expect(said.samplingSaid).toBe("20 steps");
  });
});

describe("what a form asks the server what it will take with", () => {
  it("is its settings: no text, nothing unset, and no value of an input the recipe no longer has", () => {
    expect(settingsOnly(picture, { prompt: "a cat", steps: 30, gone: 1, crf: undefined })).toEqual({ steps: 30 });
  });
});

describe("a frame enlarged by a pass", () => {
  it("lands on the 32-pixel grid, never under 64", () => {
    expect(upscaledFrame({ width: 832, height: 480 }, 1.5)).toEqual({ width: 1248, height: 736 });
    expect(upscaledFrame({ width: 40, height: 20 }, 1)).toEqual({ width: 64, height: 64 });
  });
});

describe("what stops a form from being sent", () => {
  const clip = recipe([
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", example: true, default: "A woman on a terrace" },
    { id: "previous", type: "clip", label: "Previous clip", role: "previous", frames: [17], fps: 24 },
    { id: "voice", type: "audio", label: "Voice sample", role: "voice" },
    { id: "end", type: "image", label: "Last frame", role: "end", optional: true },
    { id: "references", type: "references", label: "References", max: 4, roles: ["person"] },
  ], "video");
  it("is a picture, a clip or a sound it must have, by its label, then a prompt that is only an example", () => {
    expect(notFilled(clip, { prompt: "x" })).toBe("Select the previous clip first.");
    expect(notFilled(clip, { prompt: "x", previous: { asset: "a" } })).toBe("Select the voice sample first.");
    expect(notFilled(clip, { prompt: "", previous: { asset: "a" }, voice: "v" })).toBe("Fill in the prompt first.");
    expect(notFilled(clip, { prompt: "x", previous: { asset: "a" }, voice: "v", references: [] })).toBeNull();
  });
  it("is checked on the whole form as sent: defaults, then what the draft holds, less what the recipe no longer has", () => {
    expect(sentForm(clip, { prompt: "", voice: undefined }, { prompt: "hi", gone: 2 })).toEqual({ prompt: "hi" });
  });
});
