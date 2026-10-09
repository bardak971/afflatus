import { describe, expect, it } from "vitest";
import { isShown, pickChoice, RANDOM_SEED, schemaFor, type InputSpec } from "../src";

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

  it("takes whole numbers only where the step is whole, as the INT behind it does", () => {
    const parse = (extra: Record<string, unknown>) => schemaFor(specs).safeParse({ prompt: "a", checkpoint: "x", ...extra }).success;
    expect(parse({ steps: 30 })).toBe(true);
    expect(parse({ steps: 28.5 })).toBe(false);
    expect(parse({ scale: 1.37 })).toBe(true);
    // a whole step from a fractional start is not an INT
    expect(schemaFor([{ id: "x", type: "number", label: "X", min: 0.5, max: 10, step: 1, default: 1.5 }]).safeParse({ x: 2.5 }).success).toBe(true);
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
  it("hides what depends on a hidden input, whatever that input's value", () => {
    // the guide's edge thresholds: "Follow" defaults to Edges but shows only with a guide picture
    const chain: InputSpec[] = [
      { id: "guide", type: "image", role: "guide", label: "Guide picture", optional: true },
      { id: "follow", type: "choice", label: "Follow", options: ["Edges", "Depth"], default: "Edges", showWhen: "guide" },
      { id: "low", type: "number", label: "Edge low threshold", min: 0, max: 1, step: 0.01, default: 0.4, showWhen: { input: "follow", in: ["Edges"] } },
    ];
    const low = chain[2]!;
    expect(isShown(low, { follow: "Edges" }, chain)).toBe(false);
    expect(isShown(low, { follow: "Edges", guide: "a.png" }, chain)).toBe(true);
    expect(isShown(low, { follow: "Depth", guide: "a.png" }, chain)).toBe(false);
    // without the recipe's inputs it only looks one step up, as before
    expect(isShown(low, { follow: "Edges" })).toBe(true);
  });
  it("stops on a loop of conditions", () => {
    const loop: InputSpec[] = [
      { id: "a", type: "toggle", label: "A", default: true, showWhen: "b" },
      { id: "b", type: "toggle", label: "B", default: true, showWhen: "a" },
    ];
    expect(isShown(loop[0]!, { a: true, b: true }, loop)).toBe(true);
  });
});

describe("a saved file choice this ComfyUI lists under another folder", () => {
  // an imported workflow saved "MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors"; this ComfyUI keeps it at the top of its folder
  const spec = { id: "vae", type: "choice", label: "VAE", options: { node: "VAELoader", input: "vae_name" }, default: "MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors" } as const;
  it("is that file, not the first of the list", () => {
    expect(pickChoice(spec as never, ["LTX23_audio_vae_bf16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"])).toBe("minimax_h3_audio_vae_fp32.safetensors");
    expect(pickChoice(spec as never, ["LTX23_audio_vae_bf16.safetensors", "Other\\minimax_h3_audio_vae_fp32.safetensors"])).toBe("Other\\minimax_h3_audio_vae_fp32.safetensors");
  });
});

describe("a saved file this ComfyUI does not have at all", () => {
  const vae = { id: "vae", type: "choice", label: "VAE", options: { node: "VAELoader", input: "vae_name" }, default: "QwenImage/qwen_image_vae.safetensors" } as const;
  it("stays, to be said missing, rather than some other model's file taking its place", () => {
    expect(pickChoice(vae as never, ["LTX23_audio_vae_bf16.safetensors", "ae.safetensors"])).toBe("QwenImage/qwen_image_vae.safetensors");
    // a list with only a built-in entry on it is a list of files all the same
    expect(pickChoice(vae as never, ["pixel_space"])).toBe("QwenImage/qwen_image_vae.safetensors");
  });
  it("is stood in for when the input says which files will do", () => {
    expect(pickChoice({ ...vae, prefer: ["nothing-like-it"] } as never, ["ae.safetensors"])).toBe("ae.safetensors");
  });
  it("a setting that is not a file still starts on one this ComfyUI has", () => {
    expect(pickChoice({ id: "s", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "gone" } as never, ["euler", "heun"])).toBe("euler");
  });
});
