import { describe, expect, it } from "vitest";
import { isShown, RANDOM_SEED, schemaFor, type InputSpec } from "../src";

const specs: InputSpec[] = [
  { id: "prompt", type: "prompt", label: "Tags", style: "tags" },
  { id: "negative", type: "prompt", label: "Avoid", style: "tags", optional: true, default: "blurry" },
  { id: "checkpoint", type: "model", label: "Model", folder: "checkpoints" },
  { id: "loras", type: "loras", label: "LoRAs", max: 2 },
  {
    id: "size", type: "size", label: "Shape", default: "tall", grid: 8, min: 256, max: 2048,
    shapes: [{ id: "tall", label: "Tall", width: 832, height: 1216 }],
  },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 100, step: 1, default: 28 },
  { id: "hires", type: "toggle", label: "Hi-res fix", default: false },
  { id: "scale", type: "number", label: "Enlarge by", min: 1.1, max: 2, step: 0.05, default: 1.5, showWhen: "hires" },
  { id: "mode", type: "choice", label: "Mode", options: ["a", "b"], default: "a" },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler" },
  { id: "seed", type: "seed", label: "Seed" },
];

describe("schemaFor", () => {
  it("fills in defaults", () => {
    const v = schemaFor(specs).parse({ prompt: "a cat", checkpoint: "x.safetensors" });
    expect(v).toEqual({
      prompt: "a cat", negative: "blurry", checkpoint: "x.safetensors", loras: [], size: { width: 832, height: 1216 },
      steps: 28, hires: false, scale: 1.5, mode: "a", sampler: "euler", seed: RANDOM_SEED,
    });
  });

  it("requires the prompt and the model", () => {
    expect(schemaFor(specs).safeParse({ checkpoint: "x" }).success).toBe(false);
    expect(schemaFor(specs).safeParse({ prompt: "", checkpoint: "x" }).success).toBe(false);
    expect(schemaFor(specs).safeParse({ prompt: "a" }).success).toBe(false);
  });

  it("rejects out-of-range numbers, unknown choices, too many LoRAs and unknown keys", () => {
    const base = { prompt: "a", checkpoint: "x" };
    const bad = (extra: Record<string, unknown>) => schemaFor(specs).safeParse({ ...base, ...extra }).success;
    expect(bad({ steps: 0 })).toBe(false);
    expect(bad({ mode: "c" })).toBe(false);
    expect(bad({ loras: [1, 2, 3].map(() => ({ file: "l", weight: 1 })) })).toBe(false);
    expect(bad({ nope: 1 })).toBe(false);
    // a choice whose options come from ComfyUI is checked against the node catalog, not here
    expect(bad({ sampler: "anything" })).toBe(true);
  });

  it("snaps sizes to the family's grid", () => {
    const v = schemaFor(specs).parse({ prompt: "a", checkpoint: "x", size: { width: 1001, height: 770 } });
    expect(v.size).toEqual({ width: 1000, height: 768 });
  });
});

describe("isShown", () => {
  const scale = specs.find((s) => s.id === "scale")!;
  it("follows a toggle", () => {
    expect(isShown(scale, { hires: false })).toBe(false);
    expect(isShown(scale, { hires: true })).toBe(true);
  });
  it("follows a list of values", () => {
    const spec: InputSpec = { id: "x", type: "toggle", label: "X", default: false, showWhen: { input: "mode", in: ["b"] } };
    expect(isShown(spec, { mode: "a" })).toBe(false);
    expect(isShown(spec, { mode: "b" })).toBe(true);
  });
});
