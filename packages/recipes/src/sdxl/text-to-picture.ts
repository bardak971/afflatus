import { defineRecipe, GraphBuilder, type LoraValue, type Ref, type SizeValue } from "@afflatus/core";
import { HIRES_PASS_INPUTS, hiresPass, SDXL_PRESETS, UPSCALER_PREFER } from "./common";
import { DEFAULT_NEGATIVE } from "./family";

export interface SdxlTextToPicture {
  prompt: string;
  /** Tags put in front of the prompt on every render with this model. */
  quality: string;
  negative: string;
  checkpoint: string;
  loras: LoraValue[];
  size: SizeValue;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
  hiresSampler: string;
  hiresScheduler: string;
  seed: number;
}

/** The hi-res pass can enlarge in latent space (no extra model) or through an upscale model. */
export const LATENT_UPSCALE = "latent";

const round8 = (n: number) => Math.max(64, Math.round(n / 8) * 8);

export const sdxlTextToPicture = defineRecipe<SdxlTextToPicture>({
  id: "sdxl.text-to-picture",
  family: "sdxl",
  version: 1,
  title: "txt2img",
  summary: "Text to image: an image from a tag prompt, with optional hires fix.",
  output: "image",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt", style: "tags", placeholder: "terrace at sunset, woman holding a cup, warm light" },
    { id: "negative", type: "prompt", label: "Negative prompt", style: "tags", optional: true, default: DEFAULT_NEGATIVE, perModel: true },
    { id: "checkpoint", type: "model", label: "Checkpoint", folder: "checkpoints" },
    { id: "loras", type: "loras", label: "LoRAs", max: 8 },
    {
      id: "size", type: "size", label: "Size", default: "tall", grid: 8, min: 256, max: 2048, perModel: true,
      shapes: [
        { id: "tall", label: "Portrait", width: 832, height: 1216 },
        { id: "square", label: "Square", width: 1024, height: 1024 },
        { id: "wide", label: "Landscape", width: 1216, height: 832 },
      ],
    },
    // checkpoints differ in the quality tags they were trained with ("masterpiece, best quality", "score_9, …")
    { id: "quality", type: "prompt", label: "Quality tags", note: "put in front of the prompt on every render with this checkpoint", style: "tags", optional: true, default: "", advanced: true, perModel: true },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 100, step: 1, default: 28, advanced: true, perModel: true },
    { id: "cfg", type: "number", label: "CFG scale", note: "how closely it follows the prompt", min: 1, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler_ancestral", advanced: true, perModel: true },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "normal", advanced: true, perModel: true },
    { id: "clipSkip", type: "number", label: "Clip skip", note: "1 = SDXL's own, which is already the second-last layer: what Civitai calls \"clip skip 2\" (Pony, Illustrious). Only raise it when a checkpoint's card asks for more than that", min: 1, max: 4, step: 1, default: 1, advanced: true, perModel: true },
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", min: 1.1, max: 2, step: 0.05, default: 1.5, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      // an upscale model when there is one: the enlarged latent is noisy and asks for a denoise that redraws the picture
      options: { node: "UpscaleModelLoader", input: "model_name" }, extra: [LATENT_UPSCALE], default: "4xNomos8kSC.pth", prefer: UPSCALER_PREFER,
    },
    {
      id: "hiresDenoise", type: "number", label: "Denoising strength", min: 0.05, max: 0.9, step: 0.05, default: 0.45, showWhen: "hires", advanced: true, perModel: true,
      note: "how much the second pass may redraw. With an upscale model 0.3 to 0.45 keeps the picture and sharpens it; enlarging in latent space needs 0.5 or more, or it stays soft",
    },
    { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: 15, showWhen: "hires", advanced: true, perModel: true },
    ...HIRES_PASS_INPUTS,
    { id: "seed", type: "seed", label: "Seed" },
  ],
  presets: SDXL_PRESETS,

  nodes(input) {
    return [
      "CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler", "VAEDecode", "PreviewImage",
      ...(input.loras.length ? ["LoraLoader"] : []),
      ...(input.clipSkip > 1 ? ["CLIPSetLastLayer"] : []),
      ...(!input.hires
        ? []
        : input.hiresUpscaler === LATENT_UPSCALE
          ? ["LatentUpscale"]
          : ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"]),
    ];
  },

  build(input, ctx) {
    const g = new GraphBuilder();
    const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: input.checkpoint });
    let model: Ref = [ckpt, 0];
    let clip: Ref = [ckpt, 1];
    const vae: Ref = [ckpt, 2];
    for (const l of input.loras) {
      if (l.weight === 0) continue;
      const n = g.add("LoraLoader", { model, clip, lora_name: l.file, strength_model: l.weight, strength_clip: l.weight });
      model = [n, 0];
      clip = [n, 1];
    }
    // N = stop at the Nth-last layer; SDXL's own default is already the second-last
    if (input.clipSkip > 1) clip = g.out("CLIPSetLastLayer", { clip, stop_at_clip_layer: -input.clipSkip });
    const text = [input.quality.trim().replace(/,\s*$/, ""), input.prompt].filter(Boolean).join(", ");
    const positive = g.out("CLIPTextEncode", { text, clip });
    const negative = g.out("CLIPTextEncode", { text: input.negative, clip });
    const W = round8(input.size.width);
    const H = round8(input.size.height);
    const empty = g.out("EmptyLatentImage", { width: W, height: H, batch_size: 1 });

    g.phase("sampling");
    const sampler = { model, positive, negative, seed: ctx.seed, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler };
    let latent = g.out("KSampler", { ...sampler, latent_image: empty, steps: input.steps, denoise: 1 });
    let totalSteps = input.steps;
    const passes = [{ node: latent[0], steps: input.steps }];

    if (input.hires) {
      const W2 = round8(W * input.hiresScale);
      const H2 = round8(H * input.hiresScale);
      g.phase("upscaling");
      let enlarged: Ref;
      if (input.hiresUpscaler === LATENT_UPSCALE) {
        enlarged = g.out("LatentUpscale", { samples: latent, upscale_method: "bilinear", width: W2, height: H2, crop: "disabled" });
      } else {
        // upscale models enlarge by their own factor (usually 4×): scale the result to the size asked for
        const pixels = g.out("VAEDecode", { samples: latent, vae });
        const up = g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler });
        const big = g.out("ImageUpscaleWithModel", { upscale_model: up, image: pixels });
        const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W2, height: H2, crop: "disabled" });
        enlarged = g.out("VAEEncode", { pixels: sized, vae });
      }
      g.phase("refining");
      latent = g.out("KSampler", { ...sampler, ...hiresPass(input), latent_image: enlarged, steps: input.hiresSteps, denoise: input.hiresDenoise });
      totalSteps += input.hiresSteps;
      passes.push({ node: latent[0], steps: input.hiresSteps });
    }

    g.phase("decoding");
    const image = g.out("VAEDecode", { samples: latent, vae });
    // PreviewImage writes to ComfyUI's temp folder, which ComfyUI clears itself: nothing piles up in output/
    const out = g.add("PreviewImage", { images: image });
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps,
      passes,
      loads: [`checkpoints/${input.checkpoint}`],
    };
  },

  variants: [
    { name: "plain", input: { prompt: "a", checkpoint: "x.safetensors" } },
    {
      name: "LoRAs, clip skip, wide",
      input: {
        prompt: "a", checkpoint: "x.safetensors", clipSkip: 2, size: { width: 1216, height: 832 },
        loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }],
      },
    },
    { name: "hi-res fix, latent", input: { prompt: "a", checkpoint: "x.safetensors", hires: true } },
    {
      name: "hi-res fix, upscale model",
      input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresUpscaler: "u.pth", hiresScale: 2, sampler: "dpmpp_2m", scheduler: "karras" },
    },
  ],
});
