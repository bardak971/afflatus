import { wanted, type BuildContext, type GraphBuilder, type InputSpec, type Ref } from "@afflatus/core";
import { loadUnet } from "../shared/unet";
import { KLEIN_PRESETS, kleinCond, kleinNoise, REFERENCE_NODES, type Klein } from "./common";

/** What a face is redrawn towards, in Klein's words: the person of the reference pictures, nothing else changed. */
export const SAME_FACE = "the same person's face, identical to the reference photos: same features, eyes, nose, mouth, beard and hair; natural skin, sharp, photorealistic";

/**
 * Face refine on a picture form with a person reference (card #219): after the picture, its largest face is cut out, redrawn
 * by FLUX.2 Klein with the person's pictures at a low denoise, and pasted back with a soft edge (the Impact Pack's detailer,
 * as Klein's own Face refine form does it). Only a small face: measured on a pod with Krea 2's Identity Edit (card #217,
 * ArcFace against photos of the person not sent), the pass took faces of 120–130 px from 0.43–0.53 to 0.52–0.64, left
 * those of 200–300 px where they were (−0.02 to +0.06), and made close-ups worse (−0.02 to −0.09). A face that size has
 * pixels enough of its own; a small one is redrawn at three times its size.
 */

/** The tallest face redrawn, in pixels of the picture as it is drawn (before a hires fix): between the gain and the rest. */
export const SMALL_FACE_PX = 150;
/** The square cut around the face, in face heights (the pod test's 2.5), redrawn at FACE_GUIDE pixels. */
const FACE_CROP = 2.5;
const FACE_GUIDE = 1024;
/** The redrawn face pasted back over its box grown by this much, with an edge this soft (pixels of the drawn size). */
const FACE_GROW = 10;
const FACE_FEATHER = 12;

/**
 * The base model's steps for the pass, at CFG 5. #219's pod test ran 20, chosen for the likeness and not for time: the pass
 * then took longer than the picture (25 s against 19 s on an RTX 4070 Ti). Measured on a pod (card #240, six full-body
 * pictures, faces of 103–127 px, ArcFace against photos of the person not sent): 20, 10, 8 and 6 steps all took the faces
 * from 0.54 to 0.63–0.64, within 1–3 of 255 of each other over the face, and the pass from 31.5 s to 10 s there.
 */
const FACE_PASS_STEPS = 6;
/** Klein's own sampling for the pass: the base model's FACE_PASS_STEPS at CFG 5, a distilled one's 4 at CFG 1. */
const sampling = (file: string | undefined) => (new RegExp(KLEIN_PRESETS[0]!.match, "i").test(file?.split(/[\\/]/).pop() ?? "") ? { steps: 4, cfg: 1 } : { steps: FACE_PASS_STEPS, cfg: 5 });

export const FACE_PASS_INPUTS: InputSpec[] = [
  {
    // on by itself once a person reference is there: the picture form shows it only then
    id: "faceRefine", type: "toggle", label: "Face refine", default: true, showWhen: "person",
    note: `a FaceDetailer-style pass after the picture, on small faces only (under ${SMALL_FACE_PX} px tall at the drawn size): the face cropped, redrawn by FLUX.2 Klein from the person's picture, pasted back. A larger face is left as it is: there the pass did not bring it closer, and made close-ups worse`,
  },
  {
    // ComfyUI's denoise on Klein's simple schedule, as the pod test ran it (0.35: 0.5 kept less of the likeness)
    id: "faceRefineDenoise", type: "number", label: "Face refine denoise", min: 0.2, max: 0.6, step: 0.05, default: 0.35, showWhen: "faceRefine", advanced: true,
    note: `${kleinNoise.detailer(0.35, FACE_PASS_STEPS)}. 0.5 kept less of the likeness than 0.35 in Afflatus's test`,
  },
];

/** What the pass reads of a form. */
export interface FacePassValues {
  faceRefine: boolean;
  faceRefineDenoise: number;
}

/** The family slots the pass loads (the picture family's own ids for Klein's files and the face detector). */
export const FACE_PASS_SLOTS = ["kleinUnet", "kleinClip", "kleinVae", "faceDetector"];
/** Its nodes of ComfyUI's own, beside the picture's. */
export const FACE_PASS_NODES = ["UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", ...REFERENCE_NODES];
/** And the Impact Pack's (and its Subpack's detector): done without when missing, the job saying so. */
export const FACE_PASS_OPTIONAL = ["UltralyticsDetectorProvider", "BboxDetectorSEGS", "ImpactSEGSOrderedFilter", "ImpactSEGSRangeFilter", "DetailerForEach"];

/** Why a picture with Face refine on is made without it, or null when the pass runs (said on its job). */
export function facePassSkipped(input: FacePassValues, ctx: Pick<BuildContext, "slots">, pictures: string[]): string | null {
  if (!input.faceRefine || !pictures.length) return null;
  const { slots } = ctx;
  if (!slots.kleinUnet || !slots.kleinClip || !slots.kleinVae) return "Not face-refined: FLUX.2 Klein 4B (its model, text encoder and VAE) is not on this ComfyUI (Settings › Models has them, under Krea 2's Face refine files).";
  if (!slots.faceDetector) return "Not face-refined: no face detector on this ComfyUI (face_yolov8m.pt in models/ultralytics/bbox; Settings › Models has it).";
  return null;
}

/** What the pass made: the picture, its detailer as a pass of the job's progress, the files it loads, what its job says. */
export interface FacePassed {
  image: Ref;
  pass: { node: string; steps: number; unsampled: string } | null;
  loads: string[];
  said: string | null;
}

/**
 * The picture with its largest face redrawn when it is a small one, else as it was (Face refine off, no person's picture,
 * no Klein or detector here, the Impact Pack missing). `pictures`: the person's pictures as ComfyUI has them (their upload
 * names); `scale`: how much larger the picture is than as it was drawn (a hires fix), which the face's size is read at.
 */
export function facePass(g: GraphBuilder, ctx: BuildContext, input: FacePassValues, image: Ref, at: { pictures: string[]; scale: number }): FacePassed {
  const as: FacePassed = { image, pass: null, loads: [], said: null };
  if (!input.faceRefine || !at.pictures.length) return as;
  const said = facePassSkipped(input, ctx, at.pictures);
  if (said) return { ...as, said };
  // the detailer and the detector are two packs: either missing, the pass is left out and the job says which
  if (!wanted(ctx, { input: "faceRefine", nodes: ["DetailerForEach"], without: "Face refine" })) return as;
  if (!wanted(ctx, { input: "faceRefine", nodes: ["UltralyticsDetectorProvider"], without: "Face refine" })) return as;
  const { slots } = ctx;
  g.phase("detailing");
  const { steps, cfg } = sampling(slots.kleinUnet);
  const k: Klein = {
    model: loadUnet(g, ctx, slots.kleinUnet),
    clip: g.out("CLIPLoader", { clip_name: slots.kleinClip, type: "flux2", device: "default" }),
    vae: g.out("VAELoader", { vae_name: slots.kleinVae }),
    input: { negative: "", loras: [], steps, cfg, sampler: "euler", seed: ctx.seed },
    loads: [],
  };
  const cond = kleinCond(g, k, SAME_FACE, at.pictures.map((p) => g.out("LoadImage", { image: p })));
  const detector = g.out("UltralyticsDetectorProvider", { model_name: slots.faceDetector });
  const found = g.out("BboxDetectorSEGS", { bbox_detector: detector, image, threshold: 0.5, dilation: Math.round(FACE_GROW * at.scale), crop_factor: FACE_CROP, drop_size: 10, labels: "all" });
  // the largest face is the person's: another one in the background is not turned into them
  const largest = g.out("ImpactSEGSOrderedFilter", { segs: found, target: "area(=w*h)", order: true, take_start: 0, take_count: 1 });
  // a small one only: Impact's range filter reads the crop, which is the face's height times the crop factor
  const small = g.out("ImpactSEGSRangeFilter", { segs: largest, target: "height", mode: true, min_value: 0, max_value: Math.round(SMALL_FACE_PX * at.scale * FACE_CROP) });
  const detailer = g.add("DetailerForEach", {
    image, segs: small, model: k.model, clip: k.clip, vae: k.vae, positive: cond.positive, negative: cond.negative,
    guide_size: FACE_GUIDE, guide_size_for: false, max_size: FACE_GUIDE, seed: ctx.seed, steps, cfg, sampler_name: "euler", scheduler: "simple",
    denoise: input.faceRefineDenoise, feather: Math.round(FACE_FEATHER * at.scale), noise_mask: true, force_inpaint: true, wildcard: "", cycle: 1,
  });
  const loads = [`diffusion_models/${slots.kleinUnet}`, `text_encoders/${slots.kleinClip}`, `vae/${slots.kleinVae}`, `ultralytics/${slots.faceDetector}`];
  // a face over the size, or none, leaves the picture as drawn and the pass samples nothing: its job says so, where a
  // picture shown at 28 steps ran 8, and nothing said whether Face refine had done anything
  const unsampled = `Face refine left the face as drawn: it redraws a face under ${SMALL_FACE_PX} px tall, and found none (larger faces were not helped by it in Afflatus's test).`;
  return { image: [detailer, 0], pass: { node: detailer, steps, unsampled }, loads, said: null };
}

