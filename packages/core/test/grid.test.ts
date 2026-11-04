import { describe, expect, it } from "vitest";
import type { InputSpec } from "../src/inputs";
import { axisValues, cellInput, cellSaid, GRID_ASK_USD, GRID_MOST, gridAsks, gridAxes, gridCells, gridCount, gridCountSaid, gridFields, matchOption, parseNumbers, splitValues } from "../src/grid";

const specs: InputSpec[] = [
  { id: "ckpt", type: "model", label: "Checkpoint", folder: "checkpoints" },
  { id: "prompt", type: "prompt", label: "Prompt", style: "tags" },
  { id: "negative", type: "prompt", label: "Negative", style: "tags", optional: true },
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 150, step: 1, default: 30, section: "speed" },
  { id: "cfg", type: "number", label: "CFG", min: 1, max: 30, step: 0.5, default: 5, section: "speed" },
  { id: "sampler", type: "choice", label: "Sampler", options: ["euler", "euler_ancestral", "dpmpp_2m"], default: "euler", section: "speed" },
  { id: "hires", type: "toggle", label: "Hires fix", default: false },
  { id: "size", type: "size", label: "Size", shapes: [{ id: "square", label: "Square", width: 1024, height: 1024 }], default: "square", grid: 64, min: 512, max: 2048 },
  { id: "seed", type: "seed", label: "Seed" },
  { id: "mask", type: "image", label: "Mask", role: "mask" } as InputSpec,
];
const form = { ckpt: "illustrious-xl.safetensors", prompt: "a woman in a red coat, warm lights", negative: "red coat blur", loras: [{ file: "style/ink.safetensors", weight: 0.8 }], steps: 30, cfg: 5, seed: -1 };

describe("A1111's values", () => {
  it("splits by commas, quotes keeping theirs", () => {
    expect(splitValues("20, 30,40")).toEqual(["20", "30", "40"]);
    expect(splitValues('red coat, "a blue, worn coat", ')).toEqual(["red coat", "a blue, worn coat"]);
  });

  it("reads ranges both ends in, with a step or a count", () => {
    expect(parseNumbers("1-5")).toEqual({ values: [1, 2, 3, 4, 5] });
    expect(parseNumbers("1-10 (+2)")).toEqual({ values: [1, 3, 5, 7, 9] });
    expect(parseNumbers("10-1 (-3)")).toEqual({ values: [10, 7, 4, 1] });
    expect(parseNumbers("0.5-1 (+0.25)")).toEqual({ values: [0.5, 0.75, 1] });
    expect(parseNumbers("0-1 [5]")).toEqual({ values: [0, 0.25, 0.5, 0.75, 1] });
    expect(parseNumbers("20-40 [3]", true)).toEqual({ values: [20, 30, 40] });
    expect(parseNumbers("5, 1-2, 7.5")).toEqual({ values: [5, 1, 2, 7.5] });
  });

  it("refuses what is not a number, a step the wrong way, a range past the grid's most", () => {
    expect(parseNumbers("20, thirty")).toEqual({ error: "“thirty” is not a number" });
    expect(parseNumbers("1-10 (-1)")).toHaveProperty("error");
    expect(parseNumbers(`1-${GRID_MOST + 1}`)).toHaveProperty("error");
  });

  it("matches an option as A1111 finds a checkpoint: same name, else the one that holds it", () => {
    const files = ["illustrious-xl.safetensors", "sd/pony-v6.safetensors", "sd/pony-v7.safetensors"];
    expect(matchOption("Illustrious-XL", files)).toBe("illustrious-xl.safetensors");
    expect(matchOption("pony-v6", files)).toBe("sd/pony-v6.safetensors");
    expect(matchOption("pony", files)).toBeNull();
    expect(matchOption("nothing", files)).toBeNull();
  });
});

describe("the fields a grid runs along", () => {
  it("lists Prompt S/R, the models, each LoRA's weight, numbers, choices, switches, sizes and the seed; never a picture", () => {
    const ids = gridFields(specs, form).map((f) => f.id);
    expect(ids).toEqual(["sr", "ckpt", "lora:loras:style/ink.safetensors", "steps", "cfg", "sampler", "hires", "size", "seed"]);
    expect(gridFields(specs, form).find((f) => f.id === "steps")?.group).toBe("Sampling");
  });
});

describe("an axis's values", () => {
  it("Prompt S/R: the first value must be in the prompt", () => {
    expect(axisValues(specs, form, { field: "sr", values: "red coat, blue coat" })).toEqual({ axis: { field: "sr", label: "Prompt S/R", values: ["red coat", "blue coat"], labels: ["red coat", "blue coat"] } });
    expect(axisValues(specs, form, { field: "sr", values: "green coat, blue coat" })).toHaveProperty("error");
  });

  it("numbers held to the setting's range; seeds whole", () => {
    expect(axisValues(specs, form, { field: "cfg", values: "3-7 (+2)" })).toMatchObject({ axis: { values: [3, 5, 7], labels: ["3", "5", "7"] } });
    expect(axisValues(specs, form, { field: "cfg", values: "5, 40" })).toEqual({ error: "40 is outside 1 to 30" });
    expect(axisValues(specs, form, { field: "seed", values: "1234, 5678" })).toMatchObject({ axis: { values: [1234, 5678] } });
    expect(axisValues(specs, form, { field: "seed", values: "1.5" })).toHaveProperty("error");
  });

  it("choices and files matched to their lists; switches as on and off; sizes by shape or W×H", () => {
    expect(axisValues(specs, form, { field: "sampler", values: "Euler, dpmpp_2m" })).toMatchObject({ axis: { values: ["euler", "dpmpp_2m"] } });
    expect(axisValues(specs, form, { field: "sampler", values: "heun" })).toHaveProperty("error");
    expect(axisValues(specs, form, { field: "ckpt", values: "pony-v6, illustrious" }, { ckpt: ["illustrious-xl.safetensors", "sd/pony-v6.safetensors"] })).toMatchObject({ axis: { values: ["sd/pony-v6.safetensors", "illustrious-xl.safetensors"], labels: ["pony-v6", "illustrious-xl"] } });
    expect(axisValues(specs, form, { field: "hires", values: "off, on" })).toMatchObject({ axis: { values: [false, true], labels: ["off", "on"] } });
    expect(axisValues(specs, form, { field: "size", values: "square, 832x1216" })).toMatchObject({ axis: { values: [{ width: 1024, height: 1024 }, { width: 832, height: 1216 }] } });
    expect(axisValues(specs, form, { field: "size", values: "1000x1000" })).toHaveProperty("error");
  });

  it("a setting not on the form, or the same one twice, refuses the grid", () => {
    expect(gridAxes(specs, form, { axes: [{ field: "denoise", values: "0.5" }] })).toMatchObject({ axis: 0 });
    expect(gridAxes(specs, form, { axes: [{ field: "cfg", values: "5" }, { field: "cfg", values: "7" }] })).toMatchObject({ error: "this setting is on another axis already", axis: 1 });
  });
});

describe("the cells", () => {
  const read = gridAxes(specs, form, { axes: [{ field: "steps", values: "20,30,40" }, { field: "sr", values: "red coat, blue coat, green coat" }, { field: "seed", values: "1, 2" }] });
  const axes = "axes" in read ? read.axes : [];

  it("counts every combination and says it", () => {
    expect(gridCount(axes)).toBe(18);
    expect(gridCountSaid(axes)).toBe("3 × 3 × 2 = 18 renders");
    expect(gridCountSaid(axes.slice(0, 1))).toBe("3 renders");
    expect(gridCount([])).toBe(0);
  });

  it("goes page by page, row by row, left to right", () => {
    expect(gridCells(axes).slice(0, 4)).toEqual([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]);
    expect(gridCells(axes).at(-1)).toEqual({ x: 2, y: 2, z: 1 });
  });

  it("puts each axis's value in: S/R in every text, the seed from its axis", () => {
    const input = cellInput(specs, form, axes, { x: 1, y: 2, z: 1 }, 99);
    expect(input).toMatchObject({ steps: 30, prompt: "a woman in a green coat, warm lights", negative: "green coat blur", seed: 2 });
    expect(cellSaid(axes, { x: 1, y: 2, z: 1 })).toBe("30 · green coat · 2");
  });

  it("draws a random seed once for the whole grid; a typed one stays", () => {
    const one = gridAxes(specs, form, { axes: [{ field: "cfg", values: "4, 6" }] });
    const ax = "axes" in one ? one.axes : [];
    expect(gridCells(ax).map((c) => cellInput(specs, form, ax, c, 4242).seed)).toEqual([4242, 4242]);
    expect(cellInput(specs, { ...form, seed: 7 }, ax, { x: 0, y: 0, z: 0 }, 4242).seed).toBe(7);
  });

  it("a LoRA's weight changes its row alone", () => {
    const one = gridAxes(specs, form, { axes: [{ field: "lora:loras:style/ink.safetensors", values: "0-1 [3]" }] });
    const ax = "axes" in one ? one.axes : [];
    expect(cellInput(specs, form, ax, { x: 2, y: 0, z: 0 }, 1).loras).toEqual([{ file: "style/ink.safetensors", weight: 1 }]);
    expect(form.loras[0]!.weight).toBe(0.8);
  });

  it("refuses a grid over its most", () => {
    expect(gridAxes(specs, form, { axes: [{ field: "steps", values: "1-20" }, { field: "cfg", values: "1-11" }] })).toMatchObject({ error: `220 renders, ${GRID_MOST} at most in one grid` });
  });
});

describe("the money guard", () => {
  const spend = { today: 1, month: 20, caps: { day: 10, month: 100 } };
  it("never asks off a pod", () => {
    expect(gridAsks({ onPod: false, usd: 50 }, spend)).toBeNull();
  });
  it("on a pod: quiet under the threshold, asks above it", () => {
    expect(gridAsks({ onPod: true, usd: GRID_ASK_USD - 1 }, spend)).toBeNull();
    expect(gridAsks({ onPod: true, usd: GRID_ASK_USD + 1 }, spend)).toBe("About $4.00 on the pod.");
  });
  it("asks when it would reach a cap, a cap of 0 being none", () => {
    expect(gridAsks({ onPod: true, usd: 1 }, { ...spend, today: 9.5 })).toMatch(/today's spending cap/);
    expect(gridAsks({ onPod: true, usd: 1 }, { ...spend, month: 99.5 })).toMatch(/this month's spending cap/);
    expect(gridAsks({ onPod: true, usd: 1 }, { today: 500, month: 500, caps: { day: 0, month: 0 } })).toBeNull();
  });
  it("asks when the cost cannot be told", () => {
    expect(gridAsks({ onPod: true, usd: null }, spend)).toMatch(/cannot be told/);
  });
});
