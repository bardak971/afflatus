import type { BuildContext, GraphBuilder, InputSpec, LoraValue, MediaFacts, Ref } from "@studai/core";
import { DEFAULT_NEGATIVE } from "./family";

/** What every SDXL recipe that works on a picture asks for besides its own inputs. */
export interface SdxlBase {
  /** Tags put in front of the prompt on every render with this model. */
  quality: string;
  negative: string;
  checkpoint: string;
  loras: LoraValue[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  seed: number;
}

export const round8 = (n: number) => Math.max(64, Math.round(n / 8) * 8);

/** The model and the LoRAs: what is asked up front. */
export const modelInputs: InputSpec[] = [
  { id: "checkpoint", type: "model", label: "Model", folder: "checkpoints" },
  { id: "loras", type: "loras", label: "LoRAs", max: 8 },
];

/** How it samples: folded into "All settings", remembered per model. */
export const samplingInputs = (steps = 28): InputSpec[] => [
  { id: "negative", type: "prompt", label: "Avoid", style: "tags", optional: true, default: DEFAULT_NEGATIVE, advanced: true, perModel: true },
  { id: "quality", type: "prompt", label: "Always put in front", note: "this model's quality tags", style: "tags", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 100, step: 1, default: steps, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "How closely it follows the tags (CFG)", min: 1, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler_ancestral", advanced: true, perModel: true },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "normal", advanced: true, perModel: true },
  { id: "clipSkip", type: "number", label: "Clip skip", note: "1 = the model's own setting", min: 1, max: 4, step: 1, default: 1, advanced: true, perModel: true },
  { id: "seed", type: "seed", label: "Seed" },
];

/** The node classes loadSdxl() uses for these inputs. */
export const modelNodes = (input: SdxlBase) => [
  "CheckpointLoaderSimple", "CLIPTextEncode",
  ...(input.loras.some((l) => l.weight !== 0) ? ["LoraLoader"] : []),
  ...(input.clipSkip > 1 ? ["CLIPSetLastLayer"] : []),
];

/** Checkpoint, LoRAs, clip skip, and both texts read. */
export function loadSdxl(g: GraphBuilder, input: SdxlBase, prompt: string) {
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
  const text = [input.quality.trim().replace(/,\s*$/, ""), prompt.trim()].filter(Boolean).join(", ");
  const positive = g.out("CLIPTextEncode", { text, clip });
  const negative = g.out("CLIPTextEncode", { text: input.negative, clip });
  return { model, clip, vae, positive, negative };
}

/** What a KSampler takes from the form, besides its latent, steps and strength. */
export const samplerOf = (input: SdxlBase, m: ReturnType<typeof loadSdxl>, ctx: BuildContext) => ({
  model: m.model, positive: m.positive, negative: m.negative, seed: ctx.seed, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler,
});

/** SDXL draws best near 1024 × 1024: a picture is worked on at its own shape, at about that many pixels. */
export const SDXL_AREA = 1024 * 1024;

/** The size a picture (or a part of one) is redrawn at: its shape, at about `area` pixels, enlarged at most `maxScale` times. */
export function workSize(of: { width: number; height: number } | undefined, area = SDXL_AREA, maxScale = 3) {
  if (!of?.width || !of.height) return { width: 1024, height: 1024 };
  const ideal = Math.min(maxScale, Math.max(0.25, Math.sqrt(area / (of.width * of.height))));
  // already about that size: left as it is, a resize of a few percent only softens it
  const s = ideal > 0.9 && ideal < 1.12 ? 1 : ideal;
  return { width: round8(of.width * s), height: round8(of.height * s) };
}

/** The part of a picture a mask covers: what was painted with room around it, or all of it when nothing says. */
export function boxOf(picture: MediaFacts | undefined, mask: MediaFacts | undefined) {
  const width = picture?.width || mask?.width || 1024;
  const height = picture?.height || mask?.height || 1024;
  const b = mask?.box;
  if (!b) return { x: 0, y: 0, width, height };
  const x = Math.max(0, Math.min(width - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(b.y)));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(b.width))), height: Math.max(1, Math.min(height - y, Math.round(b.height))) };
}

/**
 * The mask of the part being redone, cut to the box, and a soft version of it for putting the result
 * back: grown a little and blurred, so no seam shows. (Blur works on pictures, hence the round trip.)
 */
export function maskParts(g: GraphBuilder, maskFile: string, box: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }) {
  const mask = g.out("LoadImageMask", { image: maskFile, channel: "red" });
  const cut = g.out("CropMask", { mask, x: box.x, y: box.y, width: box.width, height: box.height });
  const asPicture = g.out("MaskToImage", { mask: cut });
  const sized = g.out("ImageScale", { image: asPicture, upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" });
  const forLatent = g.out("ImageToMask", { image: sized, channel: "red" });
  const feather = Math.min(31, Math.max(4, Math.round(Math.max(box.width, box.height) * 0.02)));
  const grown = g.out("GrowMask", { mask: cut, expand: Math.round(feather / 2), tapered_corners: true });
  const grownPicture = g.out("MaskToImage", { mask: grown });
  const blurred = g.out("ImageBlur", { image: grownPicture, blur_radius: feather, sigma: Math.min(10, feather / 2) });
  const soft = g.out("ImageToMask", { image: blurred, channel: "red" });
  return { forLatent, soft };
}
export const MASK_NODES = ["LoadImageMask", "CropMask", "MaskToImage", "ImageToMask", "GrowMask", "ImageBlur", "ImageCrop", "ImageScale", "ImageCompositeMasked", "SetLatentNoiseMask"];

/** The upscale models that suit most pictures, best first. */
export const UPSCALER_PREFER = ["ultrasharp", "x4plus(?!.*anime)", "remacri|nmkd|siax|foolhardy", "^(?!.*anime)"];
/** The face detectors of the Impact Pack, best first. */
export const FACE_DETECTOR_PREFER = ["face_yolov8m", "face_yolov8", "face"];
