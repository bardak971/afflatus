import { defineRecipe, GraphBuilder } from "@afflatus/core";
import {
  boxOf, FACE_DETECTOR_PREFER, FACE_INPUTS, FACTOR_INPUT, loadSdxl, MASK_INPUTS, MASK_NODES, maskParts, modelInputs, modelNodes, round8, samplerOf, samplingInputs, SDXL_PRESETS, UPSCALER_PREFER, workSize,
  type FaceSettings, type MaskSettings, type UpscaleSettings,
  type SdxlBase,
} from "./common";

const picture = { width: 832, height: 1216 };

// ---------------------------------------------------------------- redraw a picture

export interface SdxlRedraw extends SdxlBase {
  source: string;
  prompt: string;
  strength: number;
}

/** A picture you have, drawn again from tags: a little (same picture, cleaner) or a lot (same layout, new picture). */
export const sdxlRedraw = defineRecipe<SdxlRedraw>({
  id: "sdxl.redraw",
  family: "sdxl",
  version: 1,
  title: "img2img",
  summary: "Image to image: an image redrawn from a prompt. The denoising strength says how far it may go from the original.",
  output: "image",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", style: "tags", placeholder: "what the picture shows, as it should come out" },
    { id: "strength", type: "number", label: "Denoising strength", note: "0.3 keeps it close, 0.7 only keeps the layout", min: 0.05, max: 1, step: 0.05, default: 0.55 },
    ...modelInputs,
    ...samplingInputs(),
  ],
  presets: SDXL_PRESETS,
  nodes: (input) => [...modelNodes(input), "LoadImage", "ImageScale", "VAEEncode", "KSampler", "VAEDecode", "PreviewImage"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const m = loadSdxl(g, input, input.prompt);
    const size = workSize(ctx.media.source);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const sized = g.out("ImageScale", { image: source, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const latent = g.out("VAEEncode", { pixels: sized, vae: m.vae });
    g.phase("sampling");
    const sampled = g.out("KSampler", { ...samplerOf(input, m, ctx), latent_image: latent, steps: input.steps, denoise: input.strength });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: sampled, vae: m.vae }) });
    return {
      graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps: input.steps, passes: [{ node: sampled[0], steps: input.steps }], loads: [`checkpoints/${input.checkpoint}`],
    };
  },
  variants: [
    { name: "plain", input: { source: "p", prompt: "a", checkpoint: "x.safetensors" }, uploads: { source: "s.png" }, media: { source: picture } },
    {
      name: "LoRA, clip skip, strong",
      input: { source: "p", prompt: "a", checkpoint: "x.safetensors", strength: 0.8, clipSkip: 2, loras: [{ file: "l.safetensors", weight: 0.8 }] },
      uploads: { source: "s.png" }, media: { source: { width: 3000, height: 2000 } },
    },
  ],
});

// ---------------------------------------------------------------- paint over a part

export interface SdxlPaintOver extends SdxlBase, MaskSettings {
  source: string;
  mask: string;
  prompt: string;
  strength: number;
}

/**
 * Only the painted part is redone: it is cut out with room around it, redrawn at the size SDXL draws
 * best, and put back into the untouched picture through a soft edge.
 */
export const sdxlPaintOver = defineRecipe<SdxlPaintOver>({
  id: "sdxl.paint-over",
  family: "sdxl",
  version: 1,
  title: "Inpaint",
  summary: "Paint a mask over a part of an image and prompt what goes there. Only the masked part is redrawn.",
  output: "image",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" },
    { id: "prompt", type: "prompt", label: "Prompt", style: "tags", placeholder: "what the painted part should show" },
    { id: "strength", type: "number", label: "Denoising strength", note: "1 ignores what was there", min: 0.05, max: 1, step: 0.05, default: 0.75 },
    ...MASK_INPUTS,
    ...modelInputs,
    ...samplingInputs(),
  ],
  presets: SDXL_PRESETS,
  nodes: (input) => [...modelNodes(input), "LoadImage", "VAEEncode", "KSampler", "VAEDecode", "PreviewImage", ...MASK_NODES],
  build(input, ctx) {
    const g = new GraphBuilder();
    const m = loadSdxl(g, input, input.prompt);
    const box = boxOf(ctx.media.source, ctx.media.mask);
    const size = workSize(box);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const part = g.out("ImageCrop", { image: source, width: box.width, height: box.height, x: box.x, y: box.y });
    const sized = g.out("ImageScale", { image: part, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const masks = maskParts(g, ctx.uploads.mask!, box, size, input);
    const latent = g.out("VAEEncode", { pixels: sized, vae: m.vae });
    const masked = g.out("SetLatentNoiseMask", { samples: latent, mask: masks.forLatent });
    g.phase("sampling");
    const sampled = g.out("KSampler", { ...samplerOf(input, m, ctx), latent_image: masked, steps: input.steps, denoise: input.strength });
    g.phase("decoding");
    const drawn = g.out("VAEDecode", { samples: sampled, vae: m.vae });
    const back = g.out("ImageScale", { image: drawn, upscale_method: "lanczos", width: box.width, height: box.height, crop: "disabled" });
    const whole = g.out("ImageCompositeMasked", { destination: source, source: back, x: box.x, y: box.y, resize_source: false, mask: masks.soft });
    const out = g.add("PreviewImage", { images: whole });
    return {
      graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps: input.steps, passes: [{ node: sampled[0], steps: input.steps }], loads: [`checkpoints/${input.checkpoint}`],
    };
  },
  variants: [
    {
      name: "a part of the picture",
      input: { source: "p", mask: "m", prompt: "a", checkpoint: "x.safetensors" },
      uploads: { source: "s.png", mask: "m.png" }, media: { source: picture, mask: { ...picture, box: { x: 200, y: 300, width: 320, height: 400 } } },
    },
    {
      name: "nothing known about the mask: the whole picture",
      input: { source: "p", mask: "m", prompt: "a", checkpoint: "x.safetensors", strength: 1, loras: [{ file: "l.safetensors", weight: 1 }] },
      uploads: { source: "s.png", mask: "m.png" }, media: { source: picture },
    },
  ],
});

// ---------------------------------------------------------------- twice as large

export interface SdxlSharper extends SdxlBase, UpscaleSettings {
  source: string;
  prompt: string;
  upscaler: string;
  refine: boolean;
  strength: number;
}

/** Past this many pixels the result is only enlarged by the upscale model: an SDXL pass that big is slow and falls apart. */
const REFINE_MAX_PIXELS = 4.2e6;
const REFINE_NODES = ["CheckpointLoaderSimple", "CLIPTextEncode", "LoraLoader", "CLIPSetLastLayer", "VAEEncode", "KSampler", "VAEDecode"];

export const sdxlSharper = defineRecipe<SdxlSharper>({
  id: "sdxl.sharper",
  family: "sdxl",
  version: 1,
  title: "Upscale 2x",
  summary: "Upscales an image to twice its size with an upscale model, then a low-denoise img2img pass so it does not look smeared.",
  output: "image",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "what is in the picture: it helps the img2img pass", style: "tags", optional: true, default: "" },
    { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "4x-UltraSharp.pth", prefer: UPSCALER_PREFER },
    FACTOR_INPUT,
    { id: "refine", type: "toggle", label: "img2img pass after upscale", note: "a light pass with the checkpoint; skipped when the result is larger than about 4 megapixels", default: true },
    { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 0.6, step: 0.01, default: 0.28, showWhen: "refine", advanced: true },
    ...modelInputs,
    ...samplingInputs(),
  ],
  presets: SDXL_PRESETS,
  nodes: () => ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "PreviewImage"],
  // the second pass: only when it is asked for and the result is small enough for it. All are ComfyUI's own nodes.
  optionalNodes: REFINE_NODES,
  build(input, ctx) {
    const g = new GraphBuilder();
    const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
    const W = round8(from.width * input.factor);
    const H = round8(from.height * input.factor);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    g.phase("upscaling");
    const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.upscaler }), image: source });
    // upscale models enlarge by their own factor (usually 4×): scaled to exactly twice the picture
    const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W, height: H, crop: "disabled" });
    const loads = [`upscale_models/${input.upscaler}`];
    if (!input.refine || W * H > REFINE_MAX_PIXELS) {
      const out = g.add("PreviewImage", { images: sized });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads };
    }
    g.phase("loading");
    const m = loadSdxl(g, input, input.prompt);
    const latent = g.out("VAEEncode", { pixels: sized, vae: m.vae });
    const steps = Math.max(6, Math.round(Math.min(30, input.steps) * 0.5));
    g.phase("refining");
    const sampled = g.out("KSampler", { ...samplerOf(input, m, ctx), latent_image: latent, steps, denoise: input.strength });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: sampled, vae: m.vae }) });
    return {
      graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps: steps, passes: [{ node: sampled[0], steps }], loads: [...loads, `checkpoints/${input.checkpoint}`],
    };
  },
  variants: [
    { name: "enlarged and gone over", input: { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth" }, uploads: { source: "s.png" }, media: { source: picture } },
    { name: "only enlarged", input: { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth", refine: false }, uploads: { source: "s.png" }, media: { source: picture } },
    { name: "too large to go over", input: { source: "p", checkpoint: "x.safetensors", upscaler: "u.pth", clipSkip: 2 }, uploads: { source: "s.png" }, media: { source: { width: 1664, height: 2432 } } },
  ],
});

// ---------------------------------------------------------------- fix the faces

export interface SdxlFixFace extends SdxlBase, FaceSettings {
  source: string;
  prompt: string;
  detector: string;
  strength: number;
}

/** The Impact Pack's FaceDetailer: every face is found, redrawn larger, and put back with a soft edge. */
export const sdxlFixFace = defineRecipe<SdxlFixFace>({
  id: "sdxl.fix-face",
  family: "sdxl",
  version: 1,
  title: "Face detailer",
  summary: "Like ADetailer: detects every face and inpaints it with more detail. Needs the Impact Pack nodes in ComfyUI.",
  output: "image",
  inputs: [
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "the face and who it is: eye colour, hair, expression", style: "tags", optional: true, default: "" },
    { id: "strength", type: "number", label: "Denoising strength", note: "0.3 cleans the face, 0.6 can make another one", min: 0.1, max: 0.8, step: 0.05, default: 0.4 },
    { id: "detector", type: "choice", label: "Detection model", note: "from ComfyUI's models/ultralytics folder", options: { node: "UltralyticsDetectorProvider", input: "model_name" }, default: "bbox/face_yolov8m.pt", prefer: FACE_DETECTOR_PREFER, advanced: true },
    ...FACE_INPUTS,
    ...modelInputs,
    ...samplingInputs(),
  ],
  presets: SDXL_PRESETS,
  nodes: (input) => [...modelNodes(input), "LoadImage", "UltralyticsDetectorProvider", "FaceDetailer", "PreviewImage"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const m = loadSdxl(g, input, input.prompt);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const detector = g.out("UltralyticsDetectorProvider", { model_name: input.detector });
    const steps = Math.min(30, Math.max(8, input.steps));
    g.phase("detailing");
    const fixed = g.add("FaceDetailer", {
      image: source, model: m.model, clip: m.clip, vae: m.vae, positive: m.positive, negative: m.negative, bbox_detector: detector,
      // the crop around the face is redrawn at the guide size (ADetailer's way); by the face alone (guide_size_for true) the crop blew past max_size and the face came out small
      guide_size: input.faceSize, guide_size_for: false, max_size: Math.max(input.faceMax, input.faceSize), seed: ctx.seed, steps, cfg: input.cfg,
      sampler_name: input.sampler, scheduler: input.scheduler, denoise: input.strength, feather: input.faceFeather, noise_mask: true, force_inpaint: true,
      bbox_threshold: input.faceThreshold, bbox_dilation: input.faceGrow, bbox_crop_factor: input.faceCrop, sam_detection_hint: "center-1", sam_dilation: 0,
      sam_threshold: 0.93, sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7, sam_mask_hint_use_negative: "False",
      drop_size: 10, wildcard: "", cycle: 1,
    });
    const out = g.add("PreviewImage", { images: [fixed, 0] });
    return {
      graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps: steps, passes: [{ node: fixed, steps }], loads: [`checkpoints/${input.checkpoint}`],
    };
  },
  variants: [
    { name: "plain", input: { source: "p", checkpoint: "x.safetensors", detector: "bbox/face.pt" }, uploads: { source: "s.png" }, media: { source: picture } },
    {
      name: "with tags and a LoRA",
      input: { source: "p", prompt: "green eyes", checkpoint: "x.safetensors", detector: "bbox/face.pt", loras: [{ file: "l.safetensors", weight: 0.7 }], clipSkip: 2 },
      uploads: { source: "s.png" }, media: { source: picture },
    },
  ],
});
