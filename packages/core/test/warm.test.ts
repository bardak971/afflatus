import { describe, expect, it } from "vitest";
import { baseModels, mainModel, warmGraph, type BuiltGraph, type Graph } from "../src";

/** Checkpoint, a LoRA, two prompts, a sampler, a decode, an upscale model, a second pass, a save. */
const picture = (over: { ckpt?: string; lora?: string; upscaler?: string } = {}): BuiltGraph => {
  const graph: Graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: over.ckpt ?? "Illustrious\\base.safetensors" } },
    "2": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: over.lora ?? "style.safetensors", strength_model: 1, strength_clip: 1 } },
    "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 1], text: "a cat" } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 1], text: "" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
    "6": { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], seed: 1, steps: 30, cfg: 5, sampler_name: "euler", scheduler: "normal", denoise: 1 } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "UpscaleModelLoader", inputs: { model_name: over.upscaler ?? "4x.pth" } },
    "9": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["8", 0], image: ["7", 0] } },
    "10": { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["1", 2] } },
    "11": { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["10", 0], seed: 1, steps: 12, cfg: 5, sampler_name: "euler", scheduler: "normal", denoise: 0.4 } },
    "12": { class_type: "VAEDecode", inputs: { samples: ["11", 0], vae: ["1", 2] } },
    "13": { class_type: "SaveImage", inputs: { images: ["12", 0], filename_prefix: "x" } },
    // left unused in the workflow: it does not count
    "14": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "unused.safetensors" } },
  };
  return { graph, phases: { "6": "sampling" }, outputs: [{ node: "13", kind: "image", role: "result" }], totalSteps: 42, passes: [{ node: "6", steps: 30 }, { node: "11", steps: 12 }], loads: [] };
};

describe("the base models of a render", () => {
  it("are its checkpoint, text encoders and VAE, not its LoRAs or upscaler, and only of what is used", () => {
    expect(baseModels(picture())).toEqual(["base.safetensors"]);
    expect(baseModels(picture({ lora: "other.safetensors", upscaler: "2x.pth" }))).toEqual(["base.safetensors"]);
    expect(baseModels(picture({ ckpt: "pony.safetensors" }))).toEqual(["pony.safetensors"]);
    // the one it is named by: as written, without folder or extension
    expect(mainModel(picture())).toBe("base");
    expect(mainModel(picture({ ckpt: "Pony_V6.safetensors" }))).toBe("Pony_V6");
  });

  it("are told apart in the loaders of a model in three files, and in loaders that call their file 'model'", () => {
    const graph: Graph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "krea2_fp8.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen.safetensors", type: "flux2" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "4": { class_type: "CLIPVisionLoader", inputs: { clip_name: "vision.safetensors" } },
      "5": { class_type: "ControlNetLoader", inputs: { control_net_name: "depth.safetensors" } },
      "6": { class_type: "WanVideoModelLoader", inputs: { model: "wan\\high.safetensors" } },
      "7": { class_type: "UltralyticsDetectorProvider", inputs: { model_name: "bbox/face.pt" } },
      "8": { class_type: "Anything", inputs: { a: ["1", 0], b: ["2", 0], c: ["3", 0], d: ["4", 0], e: ["5", 0], f: ["6", 0], g: ["7", 0] } },
    };
    expect(baseModels({ graph, outputs: [{ node: "8", kind: "image", role: "result" }] })).toEqual(["ae.safetensors", "high.safetensors", "krea2_fp8.safetensors", "qwen.safetensors"]);
    // neither the text encoder nor the VAE is what the model is called
    expect(mainModel({ graph, outputs: [{ node: "8", kind: "image", role: "result" }] })).toBe("high + krea2_fp8");
    expect(mainModel({ graph: { "1": graph["3"]! }, outputs: [{ node: "1", kind: "image", role: "result" }] })).toBeNull();
  });
});

describe("the graph that loads a render's models", () => {
  it("is the render up to its first pass, cut to one step, with nothing after it", () => {
    const warm = warmGraph(picture())!;
    expect(Object.keys(warm.graph).sort()).toEqual(["1", "2", "3", "4", "5", "6", "warm15"]);
    expect(warm.graph["6"]!.inputs.steps).toBe(1);
    expect(warm.graph["warm15"]).toEqual({ class_type: "PreviewAny", inputs: { source: ["6", 0] } });
    expect(warm.pass).toEqual({ node: "6", steps: 1 });
    // the render's own graph is left as it was
    expect(picture().graph["6"]!.inputs.steps).toBe(30);
  });

  it("finds the sampler when the pass is named by its scheduler, and cuts the steps there", () => {
    const graph: Graph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
      "2": { class_type: "PrimitiveInt", inputs: { value: 20 } },
      "3": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: ["2", 0], denoise: 1 } },
      "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "5": { class_type: "SamplerCustomAdvanced", inputs: { sigmas: ["3", 0], latent_image: ["4", 0] } },
      "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0] } },
      "7": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
    };
    const warm = warmGraph({ graph, phases: {}, outputs: [{ node: "7", kind: "image", role: "result" }], totalSteps: 20, passes: [{ node: "3", steps: 20 }], loads: [] })!;
    expect(Object.keys(warm.graph).sort()).toEqual(["1", "2", "3", "4", "5", "warm8"]);
    expect(warm.graph["2"]!.inputs.value).toBe(1);
    expect(warm.graph["warm8"]!.inputs.source).toEqual(["5", 0]);
  });

  it("keeps only the loaders when there is no pass, or when the steps cannot be cut", () => {
    const upscale: Graph = {
      "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
      "2": { class_type: "UpscaleModelLoader", inputs: { model_name: "4x.pth" } },
      "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
      "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    };
    const warm = warmGraph({ graph: upscale, phases: {}, outputs: [{ node: "4", kind: "image", role: "result" }], totalSteps: 1, loads: [] })!;
    expect(Object.keys(warm.graph).sort()).toEqual(["2", "warm5"]);
    expect(warm.pass).toBeNull();

    const byHand: Graph = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "m.safetensors" } },
      "2": { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.5, 0.0" } },
      "3": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "4": { class_type: "SamplerCustomAdvanced", inputs: { model: ["1", 0], sigmas: ["2", 0], latent_image: ["3", 0] } },
      "5": { class_type: "SaveLatent", inputs: { samples: ["4", 0] } },
    };
    // a schedule written out by hand is cut to its first step
    const written = warmGraph({ graph: byHand, phases: {}, outputs: [{ node: "5", kind: "image", role: "result" }], totalSteps: 2, passes: [{ node: "4", steps: 2 }], loads: [] })!;
    expect(written.graph["2"]!.inputs.sigmas).toBe("1.0, 0.5");
    expect(written.pass).toEqual({ node: "4", steps: 1 });
    // one that cannot be read (it comes from a node that works it out): the loaders only
    const worked = { ...byHand, "2": { class_type: "SomeSigmas", inputs: { curve: "soft" } } };
    const loaders = warmGraph({ graph: worked, phases: {}, outputs: [{ node: "5", kind: "image", role: "result" }], totalSteps: 2, passes: [{ node: "4", steps: 2 }], loads: [] })!;
    expect(Object.keys(loaders.graph).sort()).toEqual(["1", "warm6"]);
    expect(loaders.pass).toBeNull();
  });

  it("is nothing when the render loads no model", () => {
    const graph: Graph = { "1": { class_type: "LoadImage", inputs: { image: "a.png" } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    expect(warmGraph({ graph, phases: {}, outputs: [{ node: "2", kind: "image", role: "result" }], totalSteps: 1, loads: [] })).toBeNull();
  });
});

describe("the frame of a video", () => {
  it("keeps the short side, follows the proportions, lands on the grid and stays within the most pixels the model takes", async () => {
    const { frameOf, megapixels } = await import("../src/frame");
    expect(frameOf({ width: 576, height: 1024 }, 576, { grid: 32, maxPixels: 768 * 1344 })).toEqual({ width: 576, height: 1024 });
    expect(frameOf({ width: 16, height: 9 }, 720, { grid: 16, maxPixels: 1280 * 720 })).toEqual({ width: 1280, height: 720 });
    // too many pixels for the model: the whole shrinks, keeping its proportions
    const held = frameOf({ width: 16, height: 9 }, 1080, { grid: 16, maxPixels: 1280 * 720 });
    expect(held.width * held.height).toBeLessThanOrEqual(1280 * 720);
    expect(held.width / held.height).toBeCloseTo(16 / 9, 1);
    // asked for more, with room for it
    expect(frameOf({ width: 9, height: 16 }, 1088, { grid: 32, maxPixels: 1088 * 1920 })).toEqual({ width: 1088, height: 1920 });
    expect(megapixels(576, 1024)).toBe("0.59 MP");
    expect(megapixels(1152, 2048)).toBe("2.4 MP");
  });
});
