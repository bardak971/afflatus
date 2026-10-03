import { defineRecipe, GraphBuilder, type ReferenceValue, type SizeValue } from "@studai/core";
import {
  boxOf, FACE_DETECTOR_PREFER, FACE_INPUTS, FACTOR_INPUT, MASK_INPUTS, MASK_NODES, maskParts, UPSCALER_PREFER,
  type FaceSettings, type MaskSettings, type UpscaleSettings,
} from "../sdxl/common";
import {
  introduce, kleinCond, kleinInputs, kleinModel, kleinSample, kleinSize, LOAD_NODES, loadKlein, r16, REFERENCE_NODES, SAMPLE_NODES, withIntro,
  type KleinBase,
} from "./common";

const files = { unet: "flux-2-klein-base-4b.safetensors", clip: "qwen_3_4b.safetensors", vae: "flux2-vae.safetensors" };
const photo = { width: 1536, height: 2048 };
const ALL_ROLES = ["person", "place", "clothing", "object", "style"] as const;

// ---------------------------------------------------------------- a new picture

export interface KleinPicture extends KleinBase {
  prompt: string;
  references: ReferenceValue[];
  size: SizeValue;
}

export const kleinPicture = defineRecipe<KleinPicture>({
  id: "klein.picture",
  family: "klein",
  version: 1,
  title: "txt2img",
  summary: "Text to image, from a natural-language prompt. With reference images of a person, a place or clothes, it keeps them.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "A woman in a linen shirt drinks coffee on a terrace at sunrise, soft light, waist up." },
    {
      id: "references", type: "references", label: "Reference images", max: 6, roles: [...ALL_ROLES],
      note: "a person, a place, clothes, an object or a look: the picture keeps them. They are not changed themselves.",
    },
    {
      id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048,
      shapes: [
        { id: "tall", label: "Portrait", width: 832, height: 1216 },
        { id: "square", label: "Square", width: 1024, height: 1024 },
        { id: "wide", label: "Landscape", width: 1216, height: 832 },
      ],
    },
    ...kleinInputs,
  ],
  nodes: (input) => [...LOAD_NODES(input), ...SAMPLE_NODES, "EmptyFlux2LatentImage", "PreviewImage", ...(input.references.length ? REFERENCE_NODES : [])],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKlein(g, input, ctx);
    const size = { width: r16(input.size.width), height: r16(input.size.height) };
    const pictures = input.references.map((_, i) => g.out("LoadImage", { image: ctx.uploads[`references.${i}`] }));
    const cond = kleinCond(g, k, withIntro(introduce(input.references), input.prompt), pictures);
    const empty = g.out("EmptyFlux2LatentImage", { width: size.width, height: size.height, batch_size: 1 });
    const { image, pass } = kleinSample(g, k, cond, empty, size, ctx.seed);
    const out = g.add("PreviewImage", { images: image });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    { name: "from words", input: { prompt: "a" }, slots: files },
    {
      name: "a person in a place, with a LoRA",
      input: { prompt: "a", references: [{ asset: "a", role: "person" }, { asset: "b", role: "person" }, { asset: "c", role: "place" }], loras: [{ file: "l.safetensors", weight: 0.8 }], size: { width: 1216, height: 832 } },
      slots: files, uploads: { "references.0": "a.png", "references.1": "b.png", "references.2": "c.png" },
    },
  ],
});

// ---------------------------------------------------------------- change a picture with words

export interface KleinEdit extends KleinBase {
  source: string;
  prompt: string;
  references: ReferenceValue[];
}

/** The picture is handed over as the first picture to follow, and the words say what to change in it. */
export const kleinEdit = defineRecipe<KleinEdit>({
  id: "klein.edit",
  family: "klein",
  version: 1,
  title: "Edit (instruction)",
  summary: "Instruction editing: prompt what to change (the clothes, the place, the light, the pose) and what stays.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "an instruction: what to change, and what stays", style: "sentences", placeholder: "Change her dress to a red silk one. Keep her face, her hair, the pose and the room exactly the same." },
    {
      id: "references", type: "references", label: "Reference images", max: 5, roles: [...ALL_ROLES],
      note: "optional: a place to put the person in, clothes to wear, more pictures of the same person",
    },
    ...kleinInputs,
  ],
  nodes: (input) => [...LOAD_NODES(input), ...SAMPLE_NODES, ...REFERENCE_NODES, "EmptyFlux2LatentImage", "PreviewImage"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKlein(g, input, ctx);
    const size = kleinSize(ctx.media.source);
    const pictures = [g.out("LoadImage", { image: ctx.uploads.source }), ...input.references.map((_, i) => g.out("LoadImage", { image: ctx.uploads[`references.${i}`] }))];
    const intro = input.references.length ? `Picture 1 is the picture to change. ${introduce(input.references, 2)}` : "";
    const cond = kleinCond(g, k, withIntro(intro, input.prompt), pictures);
    const empty = g.out("EmptyFlux2LatentImage", { width: size.width, height: size.height, batch_size: 1 });
    const { image, pass } = kleinSample(g, k, cond, empty, size, ctx.seed);
    const out = g.add("PreviewImage", { images: image });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    { name: "from an instruction", input: { source: "p", prompt: "a" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    {
      name: "into another place",
      input: { source: "p", prompt: "a", references: [{ asset: "c", role: "place" }], loras: [{ file: "l.safetensors", weight: 1 }] },
      slots: files, uploads: { source: "s.png", "references.0": "c.png" }, media: { source: photo },
    },
  ],
});

// ---------------------------------------------------------------- paint over a part

export interface KleinPaintOver extends KleinBase, MaskSettings {
  source: string;
  mask: string;
  prompt: string;
  strength: number;
  references: ReferenceValue[];
}

/** From this strength up, the part is drawn anew from an instruction instead of being touched up. */
const FRESH_FROM = 0.9;

/**
 * Only the painted part is redone: it is cut out with room around it, redone at about a megapixel and
 * put back through a soft edge. At full strength it is a real change of that part (drawn anew, with the
 * part as the picture to follow and the words as an instruction): a partial redo would only copy the
 * part back. Lower strengths touch up what is there.
 */
export const kleinPaintOver = defineRecipe<KleinPaintOver>({
  id: "klein.paint-over",
  family: "klein",
  version: 1,
  title: "Inpaint",
  summary: "Paint a mask over a part of an image and prompt what changes there. Only the masked part is redrawn.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" },
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "Replace the cup with a glass of orange juice. Keep everything else the same." },
    { id: "strength", type: "number", label: "Denoising strength", note: "1 redoes the masked part from the prompt; lower only touches it up", min: 0.1, max: 1, step: 0.05, default: 1 },
    { id: "references", type: "references", label: "Reference images", max: 4, roles: [...ALL_ROLES], note: "optional: the person whose face it is, the thing to put there", advanced: true },
    ...MASK_INPUTS,
    ...kleinInputs,
  ],
  nodes: (input) => [
    ...LOAD_NODES(input), ...SAMPLE_NODES, ...REFERENCE_NODES, "PreviewImage",
    ...MASK_NODES.filter((n) => n !== "SetLatentNoiseMask"),
    ...(input.strength >= FRESH_FROM ? ["EmptyFlux2LatentImage"] : ["SetLatentNoiseMask", "SplitSigmasDenoise"]),
  ],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKlein(g, input, ctx);
    const box = boxOf(ctx.media.source, ctx.media.mask);
    const size = kleinSize(box);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const part = g.out("ImageCrop", { image: source, width: box.width, height: box.height, x: box.x, y: box.y });
    const sized = g.out("ImageScale", { image: part, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const masks = maskParts(g, ctx.uploads.mask!, box, size, input);
    const pictures = [sized, ...input.references.map((_, i) => g.out("LoadImage", { image: ctx.uploads[`references.${i}`] }))];
    const intro = input.references.length ? `Picture 1 is the picture to change. ${introduce(input.references, 2)}` : "";
    const cond = kleinCond(g, k, withIntro(intro, input.prompt), pictures);
    const fresh = input.strength >= FRESH_FROM;
    const start = fresh
      ? g.out("EmptyFlux2LatentImage", { width: size.width, height: size.height, batch_size: 1 })
      : g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: sized, vae: k.vae }), mask: masks.forLatent });
    const { image, pass } = kleinSample(g, k, cond, start, size, ctx.seed, { strength: fresh ? 1 : input.strength });
    const back = g.out("ImageScale", { image, upscale_method: "lanczos", width: box.width, height: box.height, crop: "disabled" });
    const whole = g.out("ImageCompositeMasked", { destination: source, source: back, x: box.x, y: box.y, resize_source: false, mask: masks.soft });
    const out = g.add("PreviewImage", { images: whole });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    {
      name: "a part redone from words",
      input: { source: "p", mask: "m", prompt: "a" },
      slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo, mask: { ...photo, box: { x: 300, y: 500, width: 600, height: 500 } } },
    },
    {
      name: "a part touched up, with a picture of the person",
      input: { source: "p", mask: "m", prompt: "a", strength: 0.5, references: [{ asset: "a", role: "person" }], loras: [{ file: "l.safetensors", weight: 1 }] },
      slots: files, uploads: { source: "s.png", mask: "m.png", "references.0": "a.png" }, media: { source: photo },
    },
  ],
});

// ---------------------------------------------------------------- another shape

const SHAPES = ["Portrait 2:3", "Square 1:1", "Landscape 3:2", "Widescreen 16:9", "Portrait 9:16"];
const EXTEND = "The plain grey areas at the edges of this picture are empty. Fill them by continuing the scene naturally beyond its edges: the same place, the same light, the same style. Everything already in the picture stays exactly the same.";

/** The room to add around a picture to bring it to a shape, the picture staying in the middle. */
export function padsFor(width: number, height: number, shape: string) {
  const [a, b] = (/(\d+):(\d+)/.exec(shape)?.slice(1) ?? ["1", "1"]).map(Number) as [number, number];
  const r = a / b;
  if (width / height < r) {
    const add = Math.round(height * r) - width;
    return { left: Math.floor(add / 2), right: Math.ceil(add / 2), top: 0, bottom: 0, width: width + add, height };
  }
  const add = Math.round(width / r) - height;
  return { left: 0, right: 0, top: Math.floor(add / 2), bottom: Math.ceil(add / 2), width, height: height + add };
}

export interface KleinReshape extends KleinBase {
  source: string;
  shape: string;
  prompt: string;
}

/**
 * Room is added around the picture to bring it to the new shape, grey for now. Klein is shown that
 * picture and told to fill the grey: it draws the whole frame anew, which is what makes the new room
 * match the light and the colours of what was there. The picture itself is then put back over the
 * result through a soft edge, so what was there stays exactly as it was.
 * (Drawing only the new room from noise, the rest held by a mask, left a visible seam and sometimes
 * another place altogether: tried on a real ComfyUI.)
 */
export const kleinReshape = defineRecipe<KleinReshape>({
  id: "klein.change-shape",
  family: "klein",
  version: 2,
  title: "Outpaint",
  summary: "Extends an image to another aspect ratio by generating what is beyond its edges. Nothing is cropped and what was there stays.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "shape", type: "choice", label: "Aspect ratio", options: SHAPES, default: "Widescreen 16:9" },
    { id: "prompt", type: "prompt", label: "Prompt", note: "optional: what is around it. Left empty, the surroundings simply continue", style: "sentences", optional: true, default: "" },
    ...kleinInputs,
  ],
  nodes: (input) => [
    ...LOAD_NODES(input), ...SAMPLE_NODES, ...REFERENCE_NODES, "ImagePadForOutpaint", "ImageScale", "MaskToImage", "ImageToMask", "EmptyFlux2LatentImage",
    "InvertMask", "ImageCompositeMasked", "PreviewImage",
  ],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKlein(g, input, ctx);
    const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
    const p = padsFor(from.width, from.height, input.shape);
    const size = kleinSize(p);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    // a wide soft edge: the model's version of the picture is never exactly as light as the picture, and a narrow edge shows it
    const feathering = Math.max(40, Math.min(240, Math.round(Math.min(from.width, from.height) * 0.14)));
    const padded = g.add("ImagePadForOutpaint", { image: source, left: p.left, top: p.top, right: p.right, bottom: p.bottom, feathering });
    const image = g.out("ImageScale", { image: [padded, 0], upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const maskPicture = g.out("ImageScale", { image: g.out("MaskToImage", { mask: [padded, 1] }), upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" });
    const mask = g.out("ImageToMask", { image: maskPicture, channel: "red" });
    const cond = kleinCond(g, k, withIntro(EXTEND, input.prompt), [image]);
    const drawn = kleinSample(g, k, cond, g.out("EmptyFlux2LatentImage", { width: size.width, height: size.height, batch_size: 1 }), size, ctx.seed);
    // what was there is put back exactly: only the new room comes from the model
    const whole = g.out("ImageCompositeMasked", { destination: drawn.image, source: image, x: 0, y: 0, resize_source: false, mask: g.out("InvertMask", { mask }) });
    const out = g.add("PreviewImage", { images: whole });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: drawn.pass.steps, passes: [drawn.pass], loads: k.loads };
  },
  variants: [
    { name: "a tall picture made wide", input: { source: "p" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    { name: "a wide picture made tall, with words", input: { source: "p", shape: "Portrait 9:16", prompt: "a", loras: [{ file: "l.safetensors", weight: 1 }] }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 1600, height: 900 } } },
  ],
});

// ---------------------------------------------------------------- twice as large

export interface KleinSharper extends KleinBase, UpscaleSettings {
  source: string;
  upscaler: string;
  refine: boolean;
}

/** Past this many pixels the result is only enlarged by the upscale model. */
const REFINE_MAX_PIXELS = 2.6e6;

export const kleinSharper = defineRecipe<KleinSharper>({
  id: "klein.sharper",
  family: "klein",
  version: 1,
  title: "Upscale 2x",
  summary: "For photos: upscales to twice the size with an upscale model, then a low-denoise img2img pass so it looks photographed, not smeared.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "RealESRGAN_x4plus.pth", prefer: ["x4plus(?!.*anime)", ...UPSCALER_PREFER] },
    FACTOR_INPUT,
    { id: "refine", type: "toggle", label: "img2img pass after upscale", note: "a light pass with the model; skipped when the result is larger than about 2.5 megapixels", default: true },
    ...kleinInputs,
  ],
  nodes: () => ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "PreviewImage"],
  // the second pass: only when it is asked for and the result is small enough for it. All are ComfyUI's own nodes.
  optionalNodes: ["UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly", ...SAMPLE_NODES, "ImageScaleToTotalPixels", "VAEEncode", "ReferenceLatent", "SplitSigmasDenoise"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
    const size = { width: r16(from.width * input.factor), height: r16(from.height * input.factor) };
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    g.phase("upscaling");
    const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.upscaler }), image: source });
    const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
    const loads = [`upscale_models/${input.upscaler}`];
    if (!input.refine || size.width * size.height > REFINE_MAX_PIXELS) {
      const out = g.add("PreviewImage", { images: sized });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads };
    }
    g.phase("loading");
    const k = loadKlein(g, input, ctx);
    const cond = kleinCond(g, k, "a high quality photo with sharp natural detail, the same image", [source]);
    g.phase("refining");
    const { image, pass } = kleinSample(g, k, cond, g.out("VAEEncode", { pixels: sized, vae: k.vae }), size, ctx.seed, { steps: 20, strength: 0.25 });
    const out = g.add("PreviewImage", { images: image });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...loads, ...k.loads] };
  },
  variants: [
    { name: "enlarged and gone over", input: { source: "p", upscaler: "u.pth" }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
    { name: "only enlarged", input: { source: "p", upscaler: "u.pth", refine: false }, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
    { name: "too large to go over", input: { source: "p", upscaler: "u.pth" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
  ],
});

// ---------------------------------------------------------------- fix the face

export interface KleinFixFace extends KleinBase, FaceSettings {
  source: string;
  references: ReferenceValue[];
  /** With two people in the picture: pictures of the one on the right (`references` is then the one on the left). */
  second: ReferenceValue[];
  detector: string;
  strength: number;
}

const SAME_FACE = "the same person's face, identical to the reference photos: same features, eyes, nose, mouth, beard and hair; natural skin, sharp, photorealistic";

/** What a face is redrawn with, whichever node does it. */
const detail = (k: ReturnType<typeof loadKlein>, input: KleinFixFace, cond: { positive: unknown; negative: unknown }, seed: number) => ({
  model: k.model, clip: k.clip, vae: k.vae, positive: cond.positive, negative: cond.negative,
  guide_size: input.faceSize, guide_size_for: true, max_size: Math.max(input.faceMax, input.faceSize), seed, steps: input.steps, cfg: input.cfg,
  sampler_name: input.sampler, scheduler: "simple", denoise: input.strength, feather: input.faceFeather, noise_mask: true, force_inpaint: true, wildcard: "", cycle: 1,
});

/**
 * The Impact Pack's FaceDetailer with Klein: the face is redrawn following the pictures of the person,
 * so it stays that person. One detailer takes one set of pictures for every face it finds, so with two
 * people the two largest faces are found first and sorted left to right: the left one is redrawn from
 * the first person's pictures, the right one from the second's.
 */
export const kleinFixFace = defineRecipe<KleinFixFace>({
  id: "klein.fix-face",
  family: "klein",
  version: 1,
  title: "Face detailer",
  summary: "For photos, like ADetailer: detects the face and inpaints it sharper, from reference images of the same person so that it stays them. Needs the Impact Pack nodes.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    {
      id: "references", type: "references", label: "Reference images of the person", max: 4, roles: ["person"],
      note: "clear pictures of their face. Without any, the face is redrawn from the picture itself. With two people, this is the one on the LEFT.",
    },
    {
      id: "second", type: "references", label: "Reference images of the second person", max: 4, roles: ["person"],
      note: "only with two people in the picture: the one on the RIGHT. Each face is then redrawn from its own person's pictures.",
    },
    { id: "strength", type: "number", label: "Denoising strength", note: "0.5 pulls the face back to the reference images", min: 0.1, max: 0.8, step: 0.05, default: 0.5 },
    { id: "detector", type: "choice", label: "Detection model", note: "from ComfyUI's models/ultralytics folder", options: { node: "UltralyticsDetectorProvider", input: "model_name" }, default: "bbox/face_yolov8m.pt", prefer: FACE_DETECTOR_PREFER, advanced: true },
    ...FACE_INPUTS,
    ...kleinInputs,
  ],
  nodes: (input) => [
    ...LOAD_NODES(input), "CLIPTextEncode", ...REFERENCE_NODES, "UltralyticsDetectorProvider", "PreviewImage",
    ...(input.references.length && input.second.length ? ["BboxDetectorSEGS", "ImpactSEGSOrderedFilter", "DetailerForEach"] : ["FaceDetailer"]),
  ],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKlein(g, input, ctx);
    const source = g.out("LoadImage", { image: ctx.uploads.source });
    const load = (id: "references" | "second") => input[id].map((_, i) => g.out("LoadImage", { image: ctx.uploads[`${id}.${i}`] }));
    const detector = g.out("UltralyticsDetectorProvider", { model_name: input.detector });
    if (input.references.length && input.second.length) {
      const people = [load("references"), load("second")];
      g.phase("detailing");
      const found = g.out("BboxDetectorSEGS", { bbox_detector: detector, image: source, threshold: input.faceThreshold, dilation: input.faceGrow, crop_factor: input.faceCrop, drop_size: 10, labels: "all" });
      // the two largest faces, whoever else is in the background
      const two = g.out("ImpactSEGSOrderedFilter", { segs: found, target: "area(=w*h)", order: true, take_start: 0, take_count: 2 });
      let image = source;
      const passes = people.map((faces, i) => {
        // sorted by their left edge: the first is the one on the left
        const one = g.out("ImpactSEGSOrderedFilter", { segs: two, target: "x1", order: false, take_start: i, take_count: 1 });
        const done = g.add("DetailerForEach", { image, segs: one, ...detail(k, input, kleinCond(g, k, SAME_FACE, faces), ctx.seed + i) });
        image = [done, 0];
        return { node: done, steps: input.steps };
      });
      const out = g.add("PreviewImage", { images: image });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: input.steps * 2, passes, loads: k.loads };
    }
    // one person: every face found is redrawn from the same pictures (whichever list holds them), or from the picture itself
    const given = input.references.length ? load("references") : load("second");
    const cond = kleinCond(g, k, SAME_FACE, given.length ? given : [source]);
    g.phase("detailing");
    const fixed = g.add("FaceDetailer", {
      image: source, bbox_detector: detector, ...detail(k, input, cond, ctx.seed),
      bbox_threshold: input.faceThreshold, bbox_dilation: input.faceGrow, bbox_crop_factor: input.faceCrop, sam_detection_hint: "center-1", sam_dilation: 0,
      sam_threshold: 0.93, sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7, sam_mask_hint_use_negative: "False",
      drop_size: 10,
    });
    const out = g.add("PreviewImage", { images: [fixed, 0] });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: input.steps, passes: [{ node: fixed, steps: input.steps }], loads: k.loads };
  },
  variants: [
    { name: "from the picture itself", input: { source: "p", detector: "bbox/face.pt" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    {
      name: "from pictures of the person",
      input: { source: "p", detector: "bbox/face.pt", references: [{ asset: "a", role: "person" }, { asset: "b", role: "person" }], loras: [{ file: "l.safetensors", weight: 1 }] },
      slots: files, uploads: { source: "s.png", "references.0": "a.png", "references.1": "b.png" }, media: { source: photo },
    },
    {
      name: "two people, each from their own pictures",
      input: { source: "p", detector: "bbox/face.pt", references: [{ asset: "a", role: "person" }], second: [{ asset: "c", role: "person" }, { asset: "d", role: "person" }] },
      slots: files, uploads: { source: "s.png", "references.0": "a.png", "second.0": "c.png", "second.1": "d.png" }, media: { source: photo },
    },
  ],
});

// ---------------------------------------------------------------- a variation

export interface KleinVariation extends KleinBase {
  source: string;
  prompt: string;
  photo: boolean;
  references: ReferenceValue[];
}

const DIFFERS = "a slightly different pose, expression and camera angle";

/** The same picture taken again: the picture is handed over as the one to follow, and the words ask for the same thing a little differently. */
export const kleinVariation = defineRecipe<KleinVariation>({
  id: "klein.variation",
  family: "klein",
  version: 1,
  title: "Variation",
  summary: "The same image regenerated: the same people, place, clothes and light, with a slightly different pose, expression and angle. Generate several and keep the best.",
  output: "image",
  inputs: [
    kleinModel,
    { id: "source", type: "image", role: "source", label: "Image" },
    { id: "prompt", type: "prompt", label: "Prompt", note: `optional: left empty, ${DIFFERS}`, style: "sentences", optional: true, default: "", placeholder: "she looks over her shoulder and laughs" },
    { id: "photo", type: "toggle", label: "Photo (not an illustration)", note: "off for a drawing or a painting: its style is kept instead", default: true },
    { id: "references", type: "references", label: "Reference images of the person", max: 4, roles: ["person"], note: "optional: more pictures of who is in it help the face stay the same", advanced: true },
    ...kleinInputs,
  ],
  nodes: (input) => [...LOAD_NODES(input), ...SAMPLE_NODES, ...REFERENCE_NODES, "EmptyFlux2LatentImage", "PreviewImage"],
  build(input, ctx) {
    const g = new GraphBuilder();
    const k = loadKlein(g, input, ctx);
    const size = kleinSize(ctx.media.source);
    const pictures = [g.out("LoadImage", { image: ctx.uploads.source }), ...input.references.map((_, i) => g.out("LoadImage", { image: ctx.uploads[`references.${i}`] }))];
    const text = [
      `The same picture as picture 1 with ${input.prompt.trim().replace(/[.\s]+$/, "") || DIFFERS}; the same people, place, clothes and light.`,
      input.photo ? "Photorealistic." : "In exactly the same art style.",
      introduce(input.references, 2),
    ].filter(Boolean).join(" ");
    const cond = kleinCond(g, k, text, pictures);
    const empty = g.out("EmptyFlux2LatentImage", { width: size.width, height: size.height, batch_size: 1 });
    const { image, pass } = kleinSample(g, k, cond, empty, size, ctx.seed);
    const out = g.add("PreviewImage", { images: image });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
  },
  variants: [
    { name: "as it is", input: { source: "p" }, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    {
      name: "a drawing, with what differs and a picture of the person",
      input: { source: "p", prompt: "she laughs.", photo: false, references: [{ asset: "a", role: "person" }], loras: [{ file: "l.safetensors", weight: 1 }] },
      slots: files, uploads: { source: "s.png", "references.0": "a.png" }, media: { source: photo },
    },
  ],
});
