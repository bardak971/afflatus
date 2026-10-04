import { defineRecipe, GraphBuilder, type ReferenceValue, type Ref, type SizeValue } from "@afflatus/core";
import {
  boxOf, FACE_DETECTOR_PREFER, FACE_INPUTS, FACTOR_INPUT, HIRES_PASS_INPUTS, hiresPass, MASK_INPUTS, MASK_NODES, maskParts, UPSCALER_PREFER,
  type FaceSettings, type HiresPass, type MaskSettings, type UpscaleSettings,
} from "../sdxl/common";
import { krea2Cond, krea2Inputs, krea2Model, krea2Sample, krea2Size, LOAD_NODES, loadKrea2, r16, shifted, type Krea2Base } from "./common";

const files = { unet: "krea2_turbo_fp8_scaled.safetensors", clip: "qwen3vl_4b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" };
const withStyle = { ...files, styleRef: "krea2_style_reference.safetensors" };
const photo = { width: 1536, height: 2048 };

// ---------------------------------------------------------------- txt2img

export interface Krea2Picture extends Krea2Base, HiresPass {
  prompt: string;
  references: ReferenceValue[];
  referenceStrength: number;
  size: SizeValue;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
}

/** How many reference images the text encoder is shown. */
/** The style-reference LoRA was trained on one or two pictures. */
const STYLE_IMAGES = 2;

/**
 * A picture from a prompt, the way ComfyUI's own Krea 2 Turbo template makes it. With reference images
 * it follows their style: the images are read next to the prompt and the style-reference LoRA is put
 * on the model (ComfyUI's "image style reference" template). Hires fix is the usual upscale and second
 * pass, the second pass with the shift that suits its larger size.
 */
export const krea2Picture = defineRecipe<Krea2Picture>({
  id: "krea2.text-to-picture",
  family: "krea2",
  version: 1,
  title: "txt2img",
  summary: "Text to image, from a natural-language prompt, with optional hires fix. With reference images, it follows their style.",
  output: "image",
  inputs: [
    krea2Model,
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "A photograph of a woman in a linen shirt drinking coffee on a terrace at sunrise, soft warm light from the left, waist up, shallow depth of field." },
    {
      id: "references", type: "references", label: "Style reference images", max: STYLE_IMAGES, roles: ["style"],
      note: "the look to follow (a drawing style, a colour mood, a kind of photo), not who is in it. Needs the style-reference LoRA.",
    },
    { id: "referenceStrength", type: "number", label: "Style strength", note: "the weight of the style-reference LoRA", min: 0.1, max: 1.5, step: 0.05, default: 1, showWhen: "references", advanced: true },
    {
      id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048,
      shapes: [
        { id: "tall", label: "Portrait", width: 896, height: 1152 },
        { id: "square", label: "Square", width: 1024, height: 1024 },
        { id: "wide", label: "Landscape", width: 1152, height: 896 },
      ],
    },
    ...krea2Inputs.slice(0, -1),
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", min: 1.1, max: 2, step: 0.05, default: 1.25, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      options: { node: "UpscaleModelLoader", input: "model_name" }, default: "RealESRGAN_x4plus.pth", prefer: UPSCALER_PREFER,
    },
    { id: "hiresDenoise", type: "number", label: "Denoising strength", note: "how much the second pass may redraw", min: 0.05, max: 0.9, step: 0.05, default: 0.5, showWhen: "hires", advanced: true, perModel: true },
    { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: 4, showWhen: "hires", advanced: true, perModel: true },
    ...HIRES_PASS_INPUTS,
    krea2Inputs.at(-1)!,
  ],
  nodes: (input) => [
    ...LOAD_NODES(input).filter((n) => n !== "CLIPTextEncode" || !input.references.length || input.negative.trim()), "EmptyLatentImage",
    ...(input.references.length ? ["LoadImage", "TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "LoraLoaderModelOnly", ...(input.shift > 0 ? [] : ["ModelSamplingFlux"])] : []),
    ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode", ...(input.shift > 0 ? [] : ["ModelSamplingFlux"])] : []),
  ],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKrea2(g, input, ctx);
    const W = r16(input.size.width);
    const H = r16(input.size.height);
    const styled = input.references.length > 0;
    if (styled && !ctx.slots.styleRef) {
      throw new Error("Style reference images need Krea 2's style-reference LoRA: put krea2_style_reference.safetensors in ComfyUI's models/loras folder (it can be downloaded from Settings).");
    }
    let model = k.model;
    if (styled) model = g.out("LoraLoaderModelOnly", { model, lora_name: ctx.slots.styleRef, strength_model: input.referenceStrength });
    // the shift typed in, else the model's own; with reference images and for the second pass, the one that follows the size
    const sized = (m: Ref, width: number, height: number) => (input.shift > 0 ? shifted(g, m, input) : g.out("ModelSamplingFlux", { model: m, max_shift: 1.15, base_shift: 0.5, width, height }));
    let positive: Ref;
    if (styled) {
      const images = Object.fromEntries(input.references.slice(0, STYLE_IMAGES).map((_, i) => [`image${i + 1}`, g.out("LoadImage", { image: ctx.uploads[`references.${i}`] })]));
      const read = g.out("TextEncodeQwenImageEditPlus", { clip: k.clip, vae: k.vae, prompt: input.prompt, ...images });
      positive = g.out("FluxKontextMultiReferenceLatentMethod", { conditioning: read, reference_latents_method: "index_timestep_zero" });
    } else {
      positive = g.out("CLIPTextEncode", { text: input.prompt, clip: k.clip });
    }
    const cond = krea2Cond(g, k, positive);
    const empty = g.out("EmptyLatentImage", { width: W, height: H, batch_size: 1 });

    g.phase("sampling");
    const first = krea2Sample(g, k, styled ? sized(model, W, H) : shifted(g, model, input), cond, empty);
    let latent = first.latent;
    const passes = [first.pass];
    const loads = [...k.loads, ...(styled ? [`loras/${ctx.slots.styleRef}`] : [])];

    if (input.hires) {
      const W2 = r16(W * input.hiresScale);
      const H2 = r16(H * input.hiresScale);
      g.phase("upscaling");
      // upscale models enlarge by their own factor (usually 4×): the result is scaled to the size asked for
      const pixels = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
      const scaled = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W2, height: H2, crop: "disabled" });
      g.phase("refining");
      const second = krea2Sample(g, k, sized(model, W2, H2), cond, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), { steps: input.hiresSteps, denoise: input.hiresDenoise, ...hiresPass(input) });
      latent = second.latent;
      passes.push(second.pass);
      loads.push(`upscale_models/${input.hiresUpscaler}`);
    }

    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: passes.reduce((n, p) => n + p.steps, 0), passes, loads };
  },
  variants: [
    { name: "from words, as ComfyUI's template", input: { prompt: "a" }, slots: files },
    {
      name: "a fine-tune with its own shift, a LoRA, a negative prompt and hires fix",
      input: { prompt: "a", model: "Krea2\\someone_krea2_v1.safetensors", shift: 4, cfg: 3, steps: 25, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }], hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } },
      slots: files,
    },
    { name: "hires fix at the model's own shift", input: { prompt: "a", hires: true, hiresUpscaler: "u.pth" }, slots: files },
    {
      name: "the style of two reference images",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }, { asset: "b", role: "style" }] },
      slots: withStyle, uploads: { "references.0": "a.png", "references.1": "b.png" },
    },
    {
      name: "a style reference with a negative prompt, a shift and hires fix",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }], negative: "blurry", cfg: 2, shift: 3, hires: true, hiresUpscaler: "u.pth", referenceStrength: 0.8 },
      slots: withStyle, uploads: { "references.0": "a.png" },
    },
  ],
});

// ---------------------------------------------------------------- img2img

export interface Krea2Redraw extends Krea2Base {
  source: string;
  prompt: string;
  strength: number;
}

/** A picture you have, drawn again from a prompt: a little (the same picture, cleaner) or a lot (the same layout, a new picture). */
export const krea2Redraw = defineRecipe<Krea2Redraw>({
  id: "krea2.redraw",
  family: "krea2",
  version: 1,
  title: "img2img",
  summary: "Image to image: an image redrawn from a prompt. The denoising strength says how far it may go from the original.",
  output: "image",
  inputs: [
    krea2Model,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "what the picture shows, as it should come out" },
    { id: "strength", type: "number", label: "Denoising strength", note: "0.3 keeps it close, 0.7 only keeps the layout", min: 0.05, max: 1, step: 0.05, default: 0.55 },
    ...krea2Inputs,
  ],
  nodes: (input) => [...LOAD_NODES(input), "LoadImage", "ImageScale", "VAEEncode"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKrea2(g, input, ctx);
    const size = krea2Size(ctx.media.source);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const sized = g.out("ImageScale", { image: source, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const cond = krea2Cond(g, k, g.out("CLIPTextEncode", { text: input.prompt, clip: k.clip }));
    g.phase("sampling");
    const { latent, pass } = krea2Sample(g, k, shifted(g, k.model, input), cond, g.out("VAEEncode", { pixels: sized, vae: k.vae }), { denoise: input.strength });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    { name: "plain", input: { source: "p", prompt: "a" }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
    {
      name: "a large picture, a fine-tune, a LoRA, strong",
      input: { source: "p", prompt: "a", model: "someone_krea2.safetensors", strength: 0.8, shift: 4, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }] },
      slots: files, uploads: { source: "s.png" }, media: { source: { width: 3000, height: 2000 } },
    },
  ],
});

// ---------------------------------------------------------------- inpaint

export interface Krea2PaintOver extends Krea2Base, MaskSettings {
  source: string;
  mask: string;
  prompt: string;
  strength: number;
}

/**
 * Only the painted part is redone: it is cut out with room around it, redrawn at a size the model draws
 * well, and put back into the untouched picture through a soft edge.
 */
export const krea2PaintOver = defineRecipe<Krea2PaintOver>({
  id: "krea2.paint-over",
  family: "krea2",
  version: 1,
  title: "Inpaint",
  summary: "Paint a mask over a part of an image and prompt what goes there. Only the masked part is redrawn.",
  output: "image",
  inputs: [
    krea2Model,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "the masked part with what is around it, as it should come out", style: "sentences", placeholder: "A woman's hand holding a glass of orange juice, on a terrace table in morning light." },
    { id: "strength", type: "number", label: "Denoising strength", note: "1 ignores what was there", min: 0.05, max: 1, step: 0.05, default: 0.8 },
    ...MASK_INPUTS,
    ...krea2Inputs,
  ],
  nodes: (input) => [...LOAD_NODES(input), "LoadImage", "VAEEncode", ...MASK_NODES],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKrea2(g, input, ctx);
    const box = boxOf(ctx.media.source, ctx.media.mask);
    const size = krea2Size(box, 1.2, 0.8);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const part = g.out("ImageCrop", { image: source, width: box.width, height: box.height, x: box.x, y: box.y });
    const sized = g.out("ImageScale", { image: part, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const masks = maskParts(g, ctx.uploads.mask!, box, size, input);
    const cond = krea2Cond(g, k, g.out("CLIPTextEncode", { text: input.prompt, clip: k.clip }));
    const masked = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: sized, vae: k.vae }), mask: masks.forLatent });
    g.phase("sampling");
    const { latent, pass } = krea2Sample(g, k, shifted(g, k.model, input), cond, masked, { denoise: input.strength });
    g.phase("decoding");
    const drawn = g.out("VAEDecode", { samples: latent, vae: k.vae });
    const back = g.out("ImageScale", { image: drawn, upscale_method: "lanczos", width: box.width, height: box.height, crop: "disabled" });
    const whole = g.out("ImageCompositeMasked", { destination: source, source: back, x: box.x, y: box.y, resize_source: false, mask: masks.soft });
    const out = g.add("PreviewImage", { images: whole });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    {
      name: "a part of the picture",
      input: { source: "p", mask: "m", prompt: "a" },
      slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo, mask: { ...photo, box: { x: 300, y: 500, width: 600, height: 500 } } },
    },
    {
      name: "nothing known about the mask: the whole picture, a fine-tune",
      input: { source: "p", mask: "m", prompt: "a", model: "someone_krea2.safetensors", strength: 1, shift: 4, loras: [{ file: "l.safetensors", weight: 1 }] },
      slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo },
    },
  ],
});

// ---------------------------------------------------------------- upscale 2x

export interface Krea2Sharper extends Krea2Base, UpscaleSettings {
  source: string;
  prompt: string;
  upscaler: string;
  refine: boolean;
  strength: number;
}

/** Past this many pixels the result is only enlarged by the upscale model: a pass that large does not fit a common card. */
const REFINE_MAX_PIXELS = 3.2e6;
const SAME_PICTURE = "The same picture in high quality, with sharp, natural detail.";

export const krea2Sharper = defineRecipe<Krea2Sharper>({
  id: "krea2.sharper",
  family: "krea2",
  version: 1,
  title: "Upscale 2x",
  summary: "Upscales an image to twice its size with an upscale model, then a low-denoise img2img pass so it does not look smeared.",
  output: "image",
  inputs: [
    krea2Model,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "what is in the picture: it helps the img2img pass", style: "sentences", optional: true, default: "" },
    { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "4x-UltraSharp.pth", prefer: UPSCALER_PREFER, section: "out" },
    FACTOR_INPUT,
    { id: "refine", type: "toggle", label: "img2img pass after upscale", note: "a light pass with the model; skipped when the result is larger than about 3 megapixels", default: true, section: "out" },
    { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 0.6, step: 0.01, default: 0.25, showWhen: "refine", advanced: true, section: "out" },
    ...krea2Inputs,
  ],
  nodes: () => ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "PreviewImage"],
  // the second pass: only when it is asked for and the result is small enough for it. All are ComfyUI's own nodes.
  optionalNodes: ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "KSampler", "VAEDecode", "VAEEncode", "LoraLoaderModelOnly", "ConditioningZeroOut", "ModelSamplingAuraFlow", "ModelSamplingFlux"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
    const W = r16(from.width * input.factor);
    const H = r16(from.height * input.factor);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    g.phase("upscaling");
    const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.upscaler }), image: source });
    // upscale models enlarge by their own factor (usually 4x): scaled to exactly twice the picture
    const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W, height: H, crop: "disabled" });
    const loads = [`upscale_models/${input.upscaler}`];
    if (!input.refine || W * H > REFINE_MAX_PIXELS) {
      const out = g.add("PreviewImage", { images: sized });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads };
    }
    g.phase("loading");
    const k = loadKrea2(g, input, ctx);
    const cond = krea2Cond(g, k, g.out("CLIPTextEncode", { text: input.prompt.trim() || SAME_PICTURE, clip: k.clip }));
    // the shift that suits a picture this large, unless one was typed
    const model = input.shift > 0 ? shifted(g, k.model, input) : g.out("ModelSamplingFlux", { model: k.model, max_shift: 1.15, base_shift: 0.5, width: W, height: H });
    g.phase("refining");
    const { latent, pass } = krea2Sample(g, k, model, cond, g.out("VAEEncode", { pixels: sized, vae: k.vae }), { steps: Math.max(3, Math.round(Math.min(30, input.steps) * 0.5)), denoise: input.strength });
    g.phase("decoding");
    const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...loads, ...k.loads] };
  },
  variants: [
    { name: "enlarged and gone over", input: { source: "p", upscaler: "u.pth" }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
    { name: "only enlarged", input: { source: "p", upscaler: "u.pth", refine: false }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
    { name: "too large to go over", input: { source: "p", upscaler: "u.pth" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    {
      name: "a fine-tune with its shift, a prompt and a LoRA",
      input: { source: "p", upscaler: "u.pth", prompt: "a", model: "someone_krea2.safetensors", shift: 4, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }] },
      slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } },
    },
  ],
});

// ---------------------------------------------------------------- face detailer

export interface Krea2FixFace extends Krea2Base, FaceSettings {
  source: string;
  prompt: string;
  detector: string;
  strength: number;
}

const A_FACE = "A detailed, natural face with sharp eyes and realistic skin.";

/** The Impact Pack's FaceDetailer with Krea 2: every face is found, redrawn larger, and put back with a soft edge. */
export const krea2FixFace = defineRecipe<Krea2FixFace>({
  id: "krea2.fix-face",
  family: "krea2",
  version: 1,
  title: "Face detailer",
  summary: "Like ADetailer: detects every face and inpaints it with more detail. Needs the Impact Pack nodes in ComfyUI.",
  output: "image",
  inputs: [
    krea2Model,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "the face and who it is: eye colour, hair, expression", style: "sentences", optional: true, default: "" },
    { id: "strength", type: "number", label: "Denoising strength", note: "0.3 cleans the face, 0.6 can make another one", min: 0.1, max: 0.8, step: 0.05, default: 0.4 },
    { id: "detector", type: "choice", label: "Detection model", note: "from ComfyUI's models/ultralytics folder", options: { node: "UltralyticsDetectorProvider", input: "model_name" }, default: "bbox/face_yolov8m.pt", prefer: FACE_DETECTOR_PREFER, advanced: true },
    ...FACE_INPUTS,
    ...krea2Inputs,
  ],
  nodes: (input) => [...LOAD_NODES(input).filter((n) => !["KSampler", "VAEDecode"].includes(n)), "LoadImage", "UltralyticsDetectorProvider", "FaceDetailer"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKrea2(g, input, ctx);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const cond = krea2Cond(g, k, g.out("CLIPTextEncode", { text: input.prompt.trim() || A_FACE, clip: k.clip }));
    const detector = g.out("UltralyticsDetectorProvider", { model_name: input.detector });
    g.phase("detailing");
    const fixed = g.add("FaceDetailer", {
      image: source, model: shifted(g, k.model, input), clip: k.clip, vae: k.vae, positive: cond.positive, negative: cond.negative, bbox_detector: detector,
      guide_size: input.faceSize, guide_size_for: false, max_size: Math.max(input.faceMax, input.faceSize), seed: ctx.seed, steps: input.steps, cfg: input.cfg,
      sampler_name: input.sampler, scheduler: input.scheduler, denoise: input.strength, feather: input.faceFeather, noise_mask: true, force_inpaint: true,
      bbox_threshold: input.faceThreshold, bbox_dilation: input.faceGrow, bbox_crop_factor: input.faceCrop, sam_detection_hint: "center-1", sam_dilation: 0,
      sam_threshold: 0.93, sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7, sam_mask_hint_use_negative: "False",
      drop_size: 10, wildcard: "", cycle: 1,
    });
    const out = g.add("PreviewImage", { images: [fixed, 0] });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: input.steps, passes: [{ node: fixed, steps: input.steps }], loads: k.loads };
  },
  variants: [
    { name: "plain", input: { source: "p", detector: "bbox/face.pt" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    {
      name: "with words, a fine-tune and a LoRA",
      input: { source: "p", prompt: "green eyes", detector: "bbox/face.pt", model: "someone_krea2.safetensors", shift: 4, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.7 }] },
      slots: files, uploads: { source: "s.png" }, media: { source: photo },
    },
  ],
});
