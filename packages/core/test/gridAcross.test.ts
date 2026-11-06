import { describe, expect, it } from "vitest";
import type { InputSpec } from "../src/inputs";
import { acrossInput, gridAxes, gridJobs, sameOpForms, type GridAcross } from "../src/grid";

/**
 * A Model axis across families (card #294), A1111's checkpoint axis across architectures: a value of another family's
 * file renders that cell on its form of the same operation, carried over as a model switch carries it, its own steps left.
 */

const size: InputSpec = { id: "size", type: "size", label: "Size", shapes: [{ id: "square", label: "Square", width: 1024, height: 1024 }], default: "square", grid: 64, min: 512, max: 2048 };
const sdxl: InputSpec[] = [
  { id: "checkpoint", type: "model", label: "Checkpoint", folder: "checkpoints" },
  { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" },
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 150, step: 1, default: 30, section: "speed" },
  { id: "cfg", type: "number", label: "CFG", min: 1, max: 30, step: 0.5, default: 5, section: "speed" },
  size,
  { id: "seed", type: "seed", label: "Seed" },
];
const flow = (cfg: boolean): InputSpec[] => [
  { id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet" },
  { id: "prompt", type: "prompt", label: "Prompt", style: "sentences" },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 50, step: 1, default: 4, section: "speed" },
  ...(cfg ? [{ id: "cfg", type: "number", label: "CFG", min: 1, max: 10, step: 0.5, default: 1, section: "speed" } as InputSpec] : []),
  size,
  { id: "seed", type: "seed", label: "Seed" },
];
const klein = { id: "klein.picture", family: "klein", inputs: flow(true) };
const krea = { id: "krea2.text-to-picture", family: "krea2", inputs: flow(false) };
const across: GridAcross = {
  name: "SDXL",
  families: [
    { recipe: klein, name: "FLUX.2 Klein", files: ["flux-2-klein-4b.safetensors", "shared-flow.safetensors"] },
    { recipe: krea, name: "Krea 2", files: ["krea2-dev.safetensors", "shared-flow.safetensors"] },
  ],
};
const own = { checkpoint: ["juggernaut-xl.safetensors", "illustrious-xl.safetensors"] };
const form = { checkpoint: "juggernaut-xl.safetensors", prompt: "a lighthouse at dusk", loras: [{ file: "ink.safetensors", weight: 0.8 }], steps: 30, cfg: 5, size: { width: 1024, height: 1024 }, seed: -1 };
const base = { id: "sdxl.text-to-picture", inputs: sdxl };

describe("a Model axis across families", () => {
  it("finds each family's form of the same operation, one a family, a built-in one before an imported workflow", () => {
    const all = [
      { id: "sdxl.text-to-picture", family: "sdxl", op: "txt2img" as const, inputs: sdxl },
      { id: "wf.klein", family: "klein", op: "txt2img" as const, imported: true as const, inputs: flow(true) },
      { ...klein, op: "txt2img" as const },
      { id: "klein.inpaint", family: "klein", op: "inpaint" as const, inputs: flow(true) },
      { ...krea, op: "txt2img" as const, hidden: true as const },
    ];
    expect(sameOpForms({ family: "sdxl", op: "txt2img" }, all).map((r) => r.id)).toEqual(["klein.picture"]);
    expect(sameOpForms({ family: "sdxl", op: "own" }, all)).toEqual([]);
  });

  it("reads the form's own files as before, another family's by its file or by its family, each said with its family", () => {
    const read = gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "juggernaut, flux-2-klein-4b, Krea 2: shared-flow" }] }, own, across);
    if ("error" in read) throw new Error(read.error);
    expect(read.axes[0]!.values).toEqual(["juggernaut-xl.safetensors", { recipe: "klein.picture", file: "flux-2-klein-4b.safetensors" }, { recipe: "krea2.text-to-picture", file: "shared-flow.safetensors" }]);
    expect(read.axes[0]!.labels).toEqual(["SDXL: juggernaut-xl", "FLUX.2 Klein: flux-2-klein-4b", "Krea 2: shared-flow"]);
    // a file both other families list wants its family said
    expect(gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "shared-flow" }] }, own, across)).toMatchObject({ error: expect.stringMatching(/a file of FLUX\.2 Klein and Krea 2: write it as FLUX\.2 Klein: shared-flow/) });
    // within the form's own family, the board says the files alone, as before
    const mine = gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "juggernaut, illustrious" }] }, own, across);
    expect("axes" in mine && mine.axes[0]!.labels).toEqual(["juggernaut-xl", "illustrious-xl"]);
  });

  it("renders each cell on its family's form: the prompt, size and the grid's one seed carried, its own steps left, the axes put in", () => {
    const read = gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "juggernaut, klein: flux-2-klein-4b, krea" }, { field: "sr", values: "dusk, dawn" }] }, own, across);
    if ("error" in read) throw new Error(read.error);
    const jobs = gridJobs(base, form, read.axes, 77, across);
    expect(jobs.map((j) => j.recipe)).toEqual(["sdxl.text-to-picture", "klein.picture", "krea2.text-to-picture", "sdxl.text-to-picture", "klein.picture", "krea2.text-to-picture"]);
    expect(jobs[0]!.input).toMatchObject({ checkpoint: "juggernaut-xl.safetensors", steps: 30, seed: 77, prompt: "a lighthouse at dusk" });
    // the other family's form: its file in its own model input, none of SDXL's checkpoint, LoRAs, steps or CFG
    expect(jobs[1]!.input).toEqual({ model: "flux-2-klein-4b.safetensors", prompt: "a lighthouse at dusk", size: { width: 1024, height: 1024 }, seed: 77 });
    expect(jobs[5]!.input).toEqual({ model: "krea2-dev.safetensors", prompt: "a lighthouse at dawn", size: { width: 1024, height: 1024 }, seed: 77 });
    expect(jobs.map((j) => j.label)).toEqual(["SDXL: juggernaut-xl · dusk", "FLUX.2 Klein: flux-2-klein-4b · dusk", "Krea 2: krea2-dev · dusk", "SDXL: juggernaut-xl · dawn", "FLUX.2 Klein: flux-2-klein-4b · dawn", "Krea 2: krea2-dev · dawn"]);
  });

  it("puts a numbers axis in on each family's form, and refuses one a family's form has not or cannot take", () => {
    const steps = gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "juggernaut, klein" }, { field: "steps", values: "4, 8" }] }, own, across);
    if ("error" in steps) throw new Error(steps.error);
    expect(gridJobs(base, form, steps.axes, 1, across).map((j) => [j.recipe, j.input.steps])).toEqual([["sdxl.text-to-picture", 4], ["klein.picture", 4], ["sdxl.text-to-picture", 8], ["klein.picture", 8]]);
    // CFG is not on Krea 2's form; 60 steps is past Klein's 50; a LoRA's weight is the base family's LoRAs
    expect(gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "juggernaut, krea" }, { field: "cfg", values: "4, 6" }] }, own, across)).toEqual({ error: "Krea 2: CFG is not on its form", axis: 1 });
    expect(gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "klein" }, { field: "steps", values: "20, 60" }] }, own, across)).toEqual({ error: "FLUX.2 Klein: 60 is outside 1 to 50", axis: 1 });
    expect(gridAxes(sdxl, form, { axes: [{ field: "checkpoint", values: "juggernaut, klein" }, { field: "lora:loras:ink.safetensors", values: "0.5, 1" }] }, own, across)).toMatchObject({ error: expect.stringMatching(/cannot run across families/), axis: 1 });
  });

  it("carries a cell's form as a model switch does: what the picture is about, never how the first model ran", () => {
    expect(acrossInput({ inputs: sdxl }, klein, { ...form, seed: 1234 })).toEqual({ prompt: "a lighthouse at dusk", size: { width: 1024, height: 1024 }, seed: 1234 });
  });

  it("takes the prompt whatever the two forms' styles, and the negative where the other form has one", () => {
    const tags: InputSpec[] = sdxl.map((i) => (i.type === "prompt" ? { ...i, style: "tags" as const } : i)).concat({ id: "negative", type: "prompt", label: "Negative", style: "tags", optional: true });
    const withNegative = { ...klein, inputs: [...klein.inputs, { id: "negative", type: "prompt", label: "Negative", style: "sentences", optional: true } as InputSpec] };
    expect(acrossInput({ inputs: tags }, withNegative, { ...form, prompt: "lighthouse, dusk", negative: "blur" })).toMatchObject({ prompt: "lighthouse, dusk", negative: "blur" });
    expect(acrossInput({ inputs: tags }, klein, { ...form, prompt: "lighthouse, dusk", negative: "blur" })).not.toHaveProperty("negative");
  });
});
