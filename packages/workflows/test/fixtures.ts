import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Graph, NodeCatalog } from "@studai/core";

export const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8"),
) as NodeCatalog;

/** ComfyUI's default text-to-image workflow, as "Export (API)" writes it. */
export const sdxl: Graph = {
  "3": { class_type: "KSampler", inputs: { seed: 156680208700286, steps: 20, cfg: 8, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "beautiful scenery, a glass bottle on a beach", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "text, watermark", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
};

/** Wan 2.2 from a first and a last picture: a video workflow with two loaded pictures and a frame count. */
export const wan: Graph = {
  "37": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_i2v_14B.safetensors", weight_dtype: "default" } },
  "38": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl.safetensors", type: "wan", device: "default" } },
  "39": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "48": { class_type: "ModelSamplingSD3", inputs: { model: ["37", 0], shift: 8 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "She lifts the cup and looks at the bay.", clip: ["38", 0] }, ...{ _meta: { title: "What happens" } } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry, static", clip: ["38", 0] } },
  "52": { class_type: "LoadImage", inputs: { image: "first.png" } },
  "53": { class_type: "LoadImage", inputs: { image: "last.png" } },
  "50": {
    class_type: "WanFirstLastFrameToVideo",
    inputs: { positive: ["6", 0], negative: ["7", 0], vae: ["39", 0], width: 832, height: 480, length: 81, batch_size: 1, start_image: ["52", 0], end_image: ["53", 0] },
  },
  "57": { class_type: "KSampler", inputs: { model: ["48", 0], seed: 42, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["50", 0], negative: ["50", 1], latent_image: ["50", 2], denoise: 1 } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["57", 0], vae: ["39", 0] } },
  "63": { class_type: "VHS_VideoCombine", inputs: { images: ["8", 0], frame_rate: 16, loop_count: 0, filename_prefix: "wan", format: "video/h264-mp4", pingpong: false, save_output: true } },
};

const titled = (title: string) => ({ _meta: { title } });

/**
 * Built the way large community workflows are (modelled on the structure of a real Wan 2.2 one): the
 * controls are renamed primitive nodes, the size and the frame count are worked out by other nodes,
 * one settings node feeds two samplers, and there are a high and a low model.
 */
export const panel: Graph = {
  "23": { class_type: "LoadImage", inputs: { image: "example.png" }, ...titled("First-Frame-Image") },
  "24": { class_type: "LoadImage", inputs: { image: "example.png" }, ...titled("Last-Frame-Image") },
  "2368": { class_type: "PrimitiveStringMultiline", inputs: { value: "" }, ...titled("WAN22 Video prompt positive") },
  "2371": { class_type: "PrimitiveStringMultiline", inputs: { value: "blurry, static" }, ...titled("WAN22 Video prompt negative") },
  "1670": { class_type: "PrimitiveInt", inputs: { value: 805887726359602 }, ...titled("Seed") },
  "1668": { class_type: "PrimitiveInt", inputs: { value: 5 }, ...titled("Seconds") },
  "1669": { class_type: "PrimitiveFloat", inputs: { value: 16 }, ...titled("FPS") },
  "2037": { class_type: "ComfyMathExpression", inputs: { expression: "(round((a * b) / 8) * 8) +1", "values.a": ["1668", 0], "values.b": ["1669", 0] }, ...titled("Math frames") },
  "1671": { class_type: "KSampler Config (rgthree)", inputs: { steps_total: 4, refiner_step: 2, cfg: 1, sampler_name: "euler", scheduler: "linear_quadratic" }, ...titled("Sampling") },
  "1502": { class_type: "UNETLoader", inputs: { unet_name: "Wan22_I2V_High.safetensors", weight_dtype: "default" } },
  "1501": { class_type: "UNETLoader", inputs: { unet_name: "Wan22_I2V_Low.safetensors", weight_dtype: "default" } },
  "2027": { class_type: "ModelSamplingSD3", inputs: { model: ["1502", 0], shift: 5 }, ...titled("Sigma Shift High") },
  "2028": { class_type: "ModelSamplingSD3", inputs: { model: ["1501", 0], shift: 5 }, ...titled("Sigma Shift Low") },
  "1504": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl.safetensors", type: "wan", device: "default" } },
  "1503": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: ["2368", 0], clip: ["1504", 0] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: ["2371", 0], clip: ["1504", 0] } },
  "2210": {
    class_type: "DaSiWa_ResolutionScaleCalculator",
    inputs: {
      resolution_preset: "480p", no_scale: false, scale_from_image: true, aspect_preset_when_not_image: "1:1 - Square",
      swap_aspect_when_not_image: false, custom_aspect_width: 16, custom_aspect_height: 9, mode: "Standard", custom_divisor: 16, image: ["23", 0],
    },
  },
  "1593": {
    class_type: "WanFirstLastFrameToVideo",
    inputs: { positive: ["6", 0], negative: ["7", 0], vae: ["1503", 0], width: ["2210", 0], height: ["2210", 1], length: ["2037", 1], batch_size: 1, start_image: ["23", 0], end_image: ["24", 0] },
  },
  "1578": {
    class_type: "KSamplerAdvanced",
    inputs: {
      model: ["2027", 0], add_noise: "enable", noise_seed: ["1670", 0], steps: ["1671", 0], cfg: ["1671", 2], sampler_name: ["1671", 3], scheduler: ["1671", 4],
      positive: ["1593", 0], negative: ["1593", 1], latent_image: ["1593", 2], start_at_step: 0, end_at_step: ["1671", 1], return_with_leftover_noise: "enable",
    },
    ...titled("KSampler (High)"),
  },
  "1577": {
    class_type: "KSamplerAdvanced",
    inputs: {
      model: ["2028", 0], add_noise: "disable", noise_seed: ["1670", 0], steps: ["1671", 0], cfg: ["1671", 2], sampler_name: ["1671", 3], scheduler: ["1671", 4],
      positive: ["1593", 0], negative: ["1593", 1], latent_image: ["1578", 0], start_at_step: ["1671", 1], end_at_step: 10000, return_with_leftover_noise: "disable",
    },
    ...titled("KSampler (Low)"),
  },
  "8": { class_type: "VAEDecode", inputs: { samples: ["1577", 0], vae: ["1503", 0] } },
  "28": { class_type: "VHS_VideoCombine", inputs: { images: ["8", 0], frame_rate: ["1669", 0], loop_count: 0, filename_prefix: "video/clip", format: "video/h264-mp4", pingpong: false, save_output: true } },
  "2503": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "video/LASTFRAME" } },
  "9": { class_type: "VHS_PruneOutputs", inputs: { filenames: ["28", 0], options: "Intermediate and Utility" } },
};

/** A custom-sampler workflow whose prompt and seed sit in shared primitive nodes, with a preview and a save. */
export const flux: Graph = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "flux.safetensors", weight_dtype: "default" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "t5.safetensors", type: "flux2", device: "default" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
  "10": { class_type: "PrimitiveStringMultiline", inputs: { value: "a photo of a cat" } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: ["10", 0], clip: ["2", 0] } },
  "5": { class_type: "FluxGuidance", inputs: { conditioning: ["4", 0], guidance: 3.5 } },
  "6": { class_type: "BasicGuider", inputs: { model: ["1", 0], conditioning: ["5", 0] } },
  "11": { class_type: "PrimitiveInt", inputs: { value: 123 } },
  "7": { class_type: "RandomNoise", inputs: { noise_seed: ["11", 0] } },
  "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  "9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: 20, denoise: 1 } },
  "12": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "13": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["7", 0], guider: ["6", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["12", 0] } },
  "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["3", 0] } },
  "15": { class_type: "PreviewImage", inputs: { images: ["14", 0] } },
  "16": { class_type: "SaveImage", inputs: { images: ["14", 0], filename_prefix: "flux" } },
};
