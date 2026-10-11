import { roundTo, type BuildContext, type GraphBuilder, type InputSpec, type LoraValue, type MediaFacts, type Ref } from "@afflatus/core";
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
  prediction: string;
  rescale: number;
  seed: number;
}

const PREDICTION_AUTO = "Auto";
const V_PRED = "v-prediction (zsnr)";
/** Whether a checkpoint is a v-prediction one: said on the form, else read from its name (NoobAI's v-pred files say so). */
export const isVPred = (input: Pick<SdxlBase, "checkpoint" | "prediction">) => input.prediction === V_PRED || (input.prediction === PREDICTION_AUTO && /v.?pred/i.test(input.checkpoint.split(/[\\/]/).pop() ?? ""));
/** The nodes a v-prediction checkpoint is sampled through. */
export const PREDICTION_NODES = ["ModelSamplingDiscrete", "RescaleCFG"];
/**
 * A v-prediction checkpoint (NoobAI v-pred and merges of it) sampled as one: ComfyUI only knows when the
 * file says so in its metadata, and many merges do not, which comes out as a grey, washed picture. The
 * CFG is rescaled as those checkpoints' authors recommend.
 */
function withPrediction(g: GraphBuilder, model: Ref, input: Pick<SdxlBase, "checkpoint" | "prediction" | "rescale">): Ref {
  if (!isVPred(input)) return model;
  model = g.out("ModelSamplingDiscrete", { model, sampling: "v_prediction", zsnr: true });
  return input.rescale > 0 ? g.out("RescaleCFG", { model, multiplier: input.rescale }) : model;
}

/** The model and the LoRAs: what is asked up front. */
export const modelInputs: InputSpec[] = [
  { id: "checkpoint", type: "model", label: "Checkpoint", folder: "checkpoints" },
  { id: "loras", type: "loras", label: "LoRAs", max: 8 },
];

/** How it samples: folded into "All settings", remembered per model. */
export const samplingInputs = (steps = 28): InputSpec[] => [
  { id: "negative", type: "prompt", label: "Negative prompt", style: "tags", optional: true, default: DEFAULT_NEGATIVE, advanced: true, perModel: true },
  { id: "quality", type: "prompt", label: "Quality tags", note: "put in front of the prompt on every render with this checkpoint", style: "tags", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 100, step: 1, default: steps, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "CFG scale", note: "how closely it follows the prompt", min: 1, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler_ancestral", advanced: true, perModel: true },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "normal", advanced: true, perModel: true },
  { id: "clipSkip", type: "number", label: "Clip skip", note: "1 = SDXL's own, which is already the second-last layer: what Civitai calls \"clip skip 2\" (Pony, Illustrious). Only raise it when a checkpoint's card asks for more than that", min: 1, max: 4, step: 1, default: 1, advanced: true, perModel: true },
  ...PREDICTION_INPUTS,
  { id: "seed", type: "seed", label: "Seed" },
];

/** Which prediction a checkpoint was trained for: read from its name, or said. */
export const PREDICTION_INPUTS: InputSpec[] = [
  {
    id: "prediction", type: "choice", label: "Prediction", options: [PREDICTION_AUTO, "epsilon", V_PRED], default: PREDICTION_AUTO, advanced: true, perModel: true,
    note: "v-prediction for NoobAI v-pred and its merges (Auto reads \"vpred\" in the file name): without it they come out grey and washed. Epsilon is every other SDXL checkpoint",
  },
  { id: "rescale", type: "number", label: "Rescale CFG", min: 0, max: 1, step: 0.05, default: 0.7, showWhen: { input: "prediction", in: [V_PRED] }, advanced: true, perModel: true, note: "0.7 is what the v-pred checkpoints' authors recommend; 0 turns it off" },
];

/** The node classes loadSdxl() uses for these inputs. */
export const modelNodes = (input: SdxlBase) => [
  "CheckpointLoaderSimple", "CLIPTextEncode",
  ...(input.loras.some((l) => l.weight !== 0) ? ["LoraLoader"] : []),
  ...(input.clipSkip > 1 ? ["CLIPSetLastLayer"] : []),
  ...(isVPred(input) ? (input.rescale > 0 ? PREDICTION_NODES : ["ModelSamplingDiscrete"]) : []),
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
  model = withPrediction(g, model, input);
  // the prompt goes in as written (a settled wildcard can end in a separator; what is sent is what the record says)
  const text = [input.quality.trim().replace(/,\s*$/, ""), prompt].filter(Boolean).join(", ");
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
  return { width: roundTo(of.width * s, 8, 64), height: roundTo(of.height * s, 8, 64) };
}

/**
 * The part of a picture a mask covers, or all of it when nothing says. The box comes with room around
 * the paint already (the server reads the mask and adds 35 %, at least 48 px, each side): that room is
 * what lets the model see what the new part has to join.
 */
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
export function maskParts(g: GraphBuilder, maskFile: string, box: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }, edge: Partial<MaskSettings> = {}) {
  const mask = g.out("LoadImageMask", { image: maskFile, channel: "red" });
  const cut = g.out("CropMask", { mask, x: box.x, y: box.y, width: box.width, height: box.height });
  const asPicture = g.out("MaskToImage", { mask: cut });
  const sized = g.out("ImageScale", { image: asPicture, upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" });
  const forLatent = g.out("ImageToMask", { image: sized, channel: "red" });
  // left to itself the edge follows the size of the part: about 2% of it, blurred, and grown by half of that
  const picked = Math.min(31, Math.max(4, Math.round(Math.max(box.width, box.height) * 0.02)));
  const feather = edge.maskBlur && edge.maskBlur > 0 ? Math.min(31, Math.round(edge.maskBlur)) : picked;
  const grown = g.out("GrowMask", { mask: cut, expand: edge.maskGrow && edge.maskGrow > 0 ? Math.round(edge.maskGrow) : Math.round(picked / 2), tapered_corners: true });
  const grownPicture = g.out("MaskToImage", { mask: grown });
  const blurred = g.out("ImageBlur", { image: grownPicture, blur_radius: feather, sigma: Math.min(10, feather / 2) });
  const soft = g.out("ImageToMask", { image: blurred, channel: "red" });
  // the same soft edge at the size the part is redrawn at: with Differential Diffusion the model fades the new part in by it
  const softForLatent = g.out("ImageToMask", { image: g.out("ImageScale", { image: blurred, upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" }), channel: "red" });
  return { forLatent, soft, softForLatent };
}
/** How the part that was redone is put back: how far past the mask it reaches, and how soft its edge is. */
export interface MaskSettings {
  maskGrow: number;
  maskBlur: number;
}
export const MASK_INPUTS: InputSpec[] = [
  { id: "maskGrow", type: "number", label: "Mask grow (dilate)", note: "how far past what you painted the new part reaches when it is put back. 0 picks it from the size of the part", min: 0, max: 64, step: 1, default: 0, unit: " px", advanced: true },
  { id: "maskBlur", type: "number", label: "Mask blur", note: "how wide the blend between the new part and the picture is: more hides a seam, less keeps the new part exact. 0 picks it from the size of the part", min: 0, max: 31, step: 1, default: 0, unit: " px", advanced: true },
];

/** The face detailer's own settings: the same whichever model redraws the face. */
export interface FaceSettings {
  faceThreshold: number;
  faceCrop: number;
  faceGrow: number;
  faceSize: number;
  faceMax: number;
  faceFeather: number;
}
export const FACE_INPUTS: InputSpec[] = [
  { id: "faceThreshold", type: "number", label: "Detection threshold", note: "how sure the detector must be that it is a face. Lower finds more: small or turned faces, and more mistakes", min: 0.1, max: 0.95, step: 0.05, default: 0.5, advanced: true },
  { id: "faceCrop", type: "number", label: "Face crop factor", note: "how much around the face is redrawn with it, in face sizes: 3 takes in the hair and the neck", min: 1, max: 6, step: 0.5, default: 3, unit: "×", advanced: true },
  { id: "faceGrow", type: "number", label: "Face mask dilation", note: "the area that is found, made larger by this much before it is redrawn", min: 0, max: 64, step: 1, default: 10, unit: " px", advanced: true },
  { id: "faceSize", type: "number", label: "Face guide size", note: "the crop around the face (the face and its crop factor) is redrawn at this size, as ADetailer does: 1024 is what SDXL draws best; larger is slower", min: 256, max: 1536, step: 64, default: 1024, unit: " px", advanced: true },
  { id: "faceMax", type: "number", label: "Face max size", note: "a crop larger than this is brought down to it", min: 512, max: 2048, step: 64, default: 1280, unit: " px", advanced: true },
  { id: "faceFeather", type: "number", label: "Mask feather", note: "how softly the redrawn face is blended back", min: 0, max: 64, step: 1, default: 5, unit: " px", advanced: true },
];

/** How much "Upscale" enlarges. */
export interface UpscaleSettings {
  factor: number;
}
export const FACTOR_INPUT: InputSpec = { id: "factor", type: "number", label: "Upscale by", note: "2 doubles each edge. The light pass after it is made in tiles when the result is large", min: 1.5, max: 4, step: 0.5, default: 2, unit: "×", section: "out" };

/** A hires second pass with the sampler and the scheduler of the first, unless others are picked. */
const SAME_PASS = "As the first pass";
export interface HiresPass {
  hiresSampler: string;
  hiresScheduler: string;
}
export const HIRES_PASS_INPUTS: InputSpec[] = [
  { id: "hiresSampler", type: "choice", label: "Hires sampler", options: { node: "KSampler", input: "sampler_name" }, extra: [SAME_PASS], default: SAME_PASS, showWhen: "hires", advanced: true, perModel: true },
  { id: "hiresScheduler", type: "choice", label: "Hires scheduler", options: { node: "KSampler", input: "scheduler" }, extra: [SAME_PASS], default: SAME_PASS, showWhen: "hires", advanced: true, perModel: true },
];
/** What the second pass samples with, over what the first pass used. */
export const hiresPass = (input: HiresPass) => ({
  ...(input.hiresSampler !== SAME_PASS ? { sampler_name: input.hiresSampler } : {}),
  ...(input.hiresScheduler !== SAME_PASS ? { scheduler: input.hiresScheduler } : {}),
});

export const MASK_NODES = ["LoadImageMask", "CropMask", "MaskToImage", "ImageToMask", "GrowMask", "ImageBlur", "ImageCrop", "ImageScale", "ImageCompositeMasked", "SetLatentNoiseMask"];

/** How far an outpaint extends the picture on each side, and how softly the new part meets it. */
export interface OutpaintSettings {
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  feathering: number;
}
export const OUTPAINT_INPUTS: InputSpec[] = [
  { id: "padLeft", type: "number", label: "Extend left", min: 0, max: 1024, step: 8, default: 192, unit: " px" },
  { id: "padRight", type: "number", label: "Extend right", min: 0, max: 1024, step: 8, default: 192, unit: " px" },
  { id: "padTop", type: "number", label: "Extend up", min: 0, max: 1024, step: 8, default: 0, unit: " px" },
  { id: "padBottom", type: "number", label: "Extend down", min: 0, max: 1024, step: 8, default: 0, unit: " px" },
  { id: "feathering", type: "number", label: "Feathering", note: "how far into the picture the new part may blend: more hides the seam, less keeps the picture exact", min: 0, max: 256, step: 8, default: 40, unit: " px", advanced: true },
];
export const OUTPAINT_NODES = ["LoadImage", "ImagePadForOutpaint", "ImageScale", "MaskToImage", "ImageToMask", "VAEEncodeForInpaint", "VAEDecode", "PreviewImage"];
/**
 * The picture padded on the sides asked for (grey, with a soft edge into the picture), scaled to the size
 * the model draws at, and encoded with the padding as the part to paint: what ComfyUI's own outpaint
 * example does. Returns the latent to sample at denoise 1, the size to bring the result back to, and the
 * padding node, and the padded picture and its mask at the drawing size, for a recipe that encodes its own.
 */
export function outpaintLatent(g: GraphBuilder, source: Ref, from: { width: number; height: number }, input: OutpaintSettings, size: { width: number; height: number }, vae: Ref) {
  const padded = g.add("ImagePadForOutpaint", { image: source, left: input.padLeft, top: input.padTop, right: input.padRight, bottom: input.padBottom, feathering: input.feathering });
  const whole = { width: from.width + input.padLeft + input.padRight, height: from.height + input.padTop + input.padBottom };
  const pixels = g.out("ImageScale", { image: [padded, 0], upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
  const mask = g.out("ImageToMask", { image: g.out("ImageScale", { image: g.out("MaskToImage", { mask: [padded, 1] }), upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" }), channel: "red" });
  return { latent: g.out("VAEEncodeForInpaint", { pixels, vae, mask, grow_mask_by: 16 }), whole, padded, pixels, mask };
}
/** The nodes `pasteBack` and `stretchedFill` bring in (GrowMask besides, for a paste with an inset). */
export const PASTE_BACK_NODES = ["ImageCompositeMasked", "InvertMask", "CropMask", "ImageBlur"];
/**
 * The picture put back over the outpainted result at its own size, faded in through the padding's feathered
 * edge widened once more: the model redraws the whole canvas, which softens the picture. `inset` pulls the
 * edge into the picture and widens the fade, for a result whose join was redrawn by a seam pass.
 */
export function pasteBack(g: GraphBuilder, drawn: Ref, source: Ref, padded: string, from: { width: number; height: number }, input: OutpaintSettings, inset = 0): Ref {
  let edge: Ref = g.out("InvertMask", { mask: [padded, 1] });
  if (inset > 0) edge = g.out("GrowMask", { mask: edge, expand: -inset, tapered_corners: true });
  let soft = g.out("ImageBlur", { image: g.out("MaskToImage", { mask: edge }), blur_radius: 31, sigma: 10 });
  if (inset > 0) soft = g.out("ImageBlur", { image: g.out("ImageBlur", { image: soft, blur_radius: 31, sigma: 10 }), blur_radius: 31, sigma: 10 });
  const own = g.out("CropMask", { mask: g.out("ImageToMask", { image: soft, channel: "red" }), x: input.padLeft, y: input.padTop, width: from.width, height: from.height });
  return g.out("ImageCompositeMasked", { destination: drawn, source, x: input.padLeft, y: input.padTop, resize_source: false, mask: own });
}
/**
 * The padded canvas the new part starts from: the picture stretched over it and blurred, the picture itself
 * on top, at the drawing size. Flat grey is read as a wall or a frame (tried on a real ComfyUI: grey drew a
 * window around the picture, the stretched picture a scene).
 */
export function stretchedFill(g: GraphBuilder, source: Ref, input: OutpaintSettings, whole: { width: number; height: number }, size: { width: number; height: number }): Ref {
  const stretched = g.out("ImageScale", { image: source, upscale_method: "bilinear", width: whole.width, height: whole.height, crop: "disabled" });
  const blurred = g.out("ImageBlur", { image: g.out("ImageBlur", { image: stretched, blur_radius: 31, sigma: 10 }), blur_radius: 31, sigma: 10 });
  const filled = g.out("ImageCompositeMasked", { destination: blurred, source, x: input.padLeft, y: input.padTop, resize_source: false });
  return g.out("ImageScale", { image: filled, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
}

/** The upscale models that suit most pictures, best first. */
/** Which upscale model a picture recipe starts on when its default is not there: UltraSharp, else Nomos8kSC (photos), else a general one, never an anime one. */
export const UPSCALER_PREFER = ["nomos8ksc", "clearreality", "ultrasharp", "x4plus(?!.*anime)", "nomosuni", "remacri|nmkd|siax|foolhardy", "^(?!.*anime)"];

/**
 * What a checkpoint starts on the first time it is used, by its line: the settings its authors give.
 * Pony wants its score tags and a high CFG; Illustrious and NoobAI their quality tags; a NoobAI v-pred
 * checkpoint runs on euler only, at a low CFG. Clip skip stays at 1: ComfyUI's SDXL encoders already
 * read the second-last layer, which is what these cards call "clip skip 2".
 * Few-step checkpoints (DMD2, LCM, Lightning, Hyper, Turbo merges) come first: on the usual 28 steps at
 * CFG 5 they burn. Their sampling is taken from them and the lineage's tags from the entry after.
 */
export const SDXL_PRESETS = [
  {
    match: "dmd|(^|[^a-z])lcm([^a-z]|$)",
    values: { sampler: "lcm", scheduler: "exponential", steps: 8, cfg: 1 },
    note: "DMD2 / LCM: few steps, lcm at CFG 1",
  },
  {
    match: "lightning|hyper[\\s._-]?(sd|\\d)",
    values: { sampler: "euler", scheduler: "sgm_uniform", steps: 8, cfg: 1 },
    note: "Lightning / Hyper: few steps, euler sgm_uniform at CFG 1",
  },
  {
    match: "turbo",
    values: { sampler: "dpmpp_sde", scheduler: "karras", steps: 8, cfg: 2 },
    note: "Turbo merge: few steps, DPM++ SDE Karras at CFG 2",
  },
  {
    match: "noob.*v.?pred|v.?pred.*noob|vpred",
    values: { sampler: "euler", scheduler: "normal", cfg: 4.5, steps: 30, quality: "masterpiece, best quality, newest, absurdres, highres", negative: `${DEFAULT_NEGATIVE}, old, early`, prediction: V_PRED },
    note: "NoobAI v-pred: euler (other samplers break on it), CFG 4 to 5, its quality tags",
  },
  {
    match: "pony|(^|[^a-z])pdxl([^a-z]|$)",
    values: { cfg: 7, sampler: "euler_ancestral", scheduler: "normal", steps: 25, quality: "score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up" },
    note: "Pony: its score tags up front and CFG 7, as its card says",
  },
  {
    match: "illustrious|noob|(^|[^a-z])(il[\\s._-]?xl|illu|nai[\\s._-]?xl)([^a-z]|$)",
    values: { cfg: 5.5, sampler: "euler_ancestral", scheduler: "normal", steps: 28, quality: "masterpiece, best quality, absurdres" },
    note: "Illustrious / NoobAI: euler a, CFG 5 to 7, its quality tags",
  },
  {
    match: "animagine",
    values: { cfg: 6, sampler: "euler_ancestral", scheduler: "normal", steps: 28, quality: "masterpiece, best quality" },
    note: "Animagine: euler a, CFG 5 to 7, its quality tags",
  },
];
/** The face detectors of the Impact Pack, best first. */
export const FACE_DETECTOR_PREFER = ["face_yolov8m", "face_yolov8", "face"];
