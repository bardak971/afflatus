import { wanted, type BuildContext, type GraphBuilder, type InputSpec, type Ref } from "@afflatus/core";
import { loadUnet } from "../shared/unet";
import type { H3Video } from "./inputs";

/**
 * Face refine: after an H3 clip is decoded, each frame's face is found and followed (the person of the picture, by face
 * identity), a square around it cut out, and H3 redraws those crops at a low denoise with the person's picture as
 * <Picture 1> and the clip's own sound held; the redrawn face is pasted back over the face alone. The pose, the light and
 * the expression stay the render's; the face comes closer to the picture. Measured on four takes (2026-10-20): the
 * likeness 0.05 to 0.33 higher, the more the smaller the face; nothing visibly pasted at this denoise.
 */

/** The paste-back, the node a render asks for (jobPacks): its pack brings the tracking, the crop and the denoise by face size too. */
export const FACE_STITCH = "H3FaceStitch";
/** The nodes of the face tracking, crop and paste-back pack. */
export const FACE_REFINE_NODES = ["H3FaceTrackCrop", "H3InjectVideoLatent", "H3PerFrameDenoise", FACE_STITCH];
/** The paste-back's mask by SAM (the face's own outline, not its box): used when there, the box otherwise. */
export const FACE_REFINE_MASK = ["SAMLoader", "H3FaceMaskSAM"];
/** The clip's sound held while the crops are redrawn (afflatus-nodes). */
export const AUDIO_LOCK = "AfflatusH3AudioLock";

export const FACE_REFINE_INPUTS: InputSpec[] = [
  {
    id: "faceRefine", type: "toggle", label: "Face refine", default: false, section: "out",
    note: "after the render, the face is cropped, redrawn at a low denoise against the person's picture (the cast's, else the first reference picture) and pasted back. The pose, light and expression stay the render's. It follows the source a little less after it, and arms over the head can be redrawn into the hair",
  },
  {
    id: "faceRefineDenoise", type: "number", label: "Face refine denoise", min: 0.3, max: 0.6, step: 0.05, default: 0.45, showWhen: "faceRefine", advanced: true, section: "out",
    note: "on the smallest faces (30 px and under); a face of 120 px and more gets a third of it, as it holds detail of its own. More is closer to the picture and further from the render",
  },
  { id: "faceRefineSteps", type: "number", label: "Face refine steps", min: 2, max: 8, step: 1, default: 4, showWhen: "faceRefine", advanced: true, section: "out", note: "4 is what it was tested at; 8 kept less of the likeness" },
  // a finish of a kept take (Finish › Face refine): its own latent loaded, nothing sampled, only the faces redrawn
  { id: "faceRefineOnly", type: "toggle", label: "Face refine only", default: false, internal: true },
];

/**
 * The person's picture the faces are drawn towards: the cast's (a "person" reference), else the clip's first reference
 * picture; null when the clip has none (the toggle then does nothing, and the job says why).
 */
export function facePicture(input: Pick<H3Video, "references">, ctx: Pick<BuildContext, "uploads">): string | null {
  const refs = input.references ?? [];
  const person = refs.findIndex((r, i) => r.role === "person" && ctx.uploads[`references.${i}`]);
  const first = person >= 0 ? person : refs.findIndex((_, i) => ctx.uploads[`references.${i}`]);
  return first >= 0 ? (ctx.uploads[`references.${first}`] ?? null) : null;
}

/** Why a clip with Face refine on is made without it, or null when it is refined (said on its job). */
export function faceRefineSkipped(input: Pick<H3Video, "faceRefine" | "references">, ctx: Pick<BuildContext, "uploads" | "slots">): string | null {
  if (!input.faceRefine) return null;
  if (!facePicture(input, ctx)) return "Not face-refined: the clip has no person's picture (a cast person or a reference picture).";
  if (!ctx.slots.faceRefineUnet) return "Not face-refined: no fused reference turbo model on this ComfyUI (Settings › Models has it, under MiniMax H3).";
  if (!ctx.slots.faceDetector) return "Not face-refined: no face detector on this ComfyUI (face_yolov8m.pt in models/ultralytics/bbox; Settings › Models has it).";
  return null;
}

/** What Face refine made: the frames, its sampler and steps (a pass of the job's progress), and the files it loads. */
export interface FaceRefined {
  images: Ref;
  pass: { node: string; steps: number } | null;
  loads: string[];
}

/**
 * The decoded frames with their faces redrawn, or the frames as they were (Face refine off, no picture, no model, or the
 * pack not installed where the job runs). `audio` is the clip's own decoded sound, held as it is while the crops are
 * redrawn; `clip` the text encoder the clip was made with.
 */
export function faceRefined(
  g: GraphBuilder, ctx: BuildContext, input: H3Video, images: Ref,
  at: { audio: Ref; vae: Ref; audioVae: Ref; clip: Ref },
): FaceRefined {
  const as: FaceRefined = { images, pass: null, loads: [] };
  if (!input.faceRefine || faceRefineSkipped(input, ctx)) return as;
  if (!wanted(ctx, { input: "faceRefine", nodes: [FACE_STITCH], without: "Face refine" })) return as;
  const face = facePicture(input, ctx);
  if (!face || !ctx.has(AUDIO_LOCK)) return as;
  const { slots } = ctx;
  g.phase("refining");
  const picture = g.out("ImageScaleToTotalPixels", { image: g.out("LoadImage", { image: face }), upscale_method: "lanczos", megapixels: 0.48, resolution_steps: 1 });
  // the person followed by face identity against the picture, the crop 2.5 face heights square on a 512 canvas (up to 768
  // for a face that would be enlarged past it), its centre and size smoothed over 21 and 51 frames; where no face is found,
  // the person detector's head, when that model is there
  const track = g.add("H3FaceTrackCrop", {
    images, detector: slots.faceDetector, confidence: 0.35, crop_factor: 2.5, canvas_width: 512, canvas_height: 512, canvas_mode: "auto_capped_768",
    smooth_window: 21, size_smooth_window: 51, smooth_method: "gaussian", size_mode: "per_frame", identity_reference: picture, identity_track: true,
    identity_threshold: 0.28, select: "largest_face", fallback_detector: slots.faceSeg ?? "none", fallback_head_frac: 0.5, select_index: 0,
    identity_model: "insightface", cut_detection: "none", cut_threshold: 3, absent_shots: "off", X: 0, Y: 0, frame_index: 0,
  });
  // the fused reference turbo, as the pass was tested: the clip's own model may be one that follows no picture
  let model = loadUnet(g, ctx, slots.faceRefineUnet);
  if (input.quick) model = g.out("ModelAttentionBackend", { model, attention: "comfy kitchen attention" });
  model = g.out("MiniMaxH3SigmaShift", { model, shift_video: 12, shift_audio: 3 });
  const subject = input.subject?.trim() ? `, ${input.subject.trim().replace(/[.\s]+$/, "")}` : "";
  const r2v = g.add("MiniMaxH3ReferenceToVideo", {
    clip: at.clip, prompt: `Close-up of the face of the person in <Picture 1>${subject}. Sharp focus, clear details.`,
    width: [track, 4], height: [track, 5], length: [track, 6], ref_image_size: "match", vae: at.vae, audio_vae: at.audioVae,
    "ref_images.ref_image_0": picture, "ref_audios.ref_audio_0": at.audio,
  });
  const started = g.out("H3InjectVideoLatent", { av_latent: [r2v, 1], images: [track, 0], vae: at.vae });
  const held = g.out(AUDIO_LOCK, { av_latent: started, audio_vae: at.audioVae, audio: at.audio });
  // the denoise by face size: whole on a face of 30 px and under, a third from 120 px, eased over 9 frames
  const scaled = g.add("H3PerFrameDenoise", {
    model, av_latent: held, transform: [track, 1], denoise_multiplier_small_face: 1, denoise_multiplier_large_face: 0.35,
    scale_mode: "absolute_px", face_px_small: 30, face_px_large: 120, gamma: 1, smooth_frames: 9,
  });
  const sampler = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
    guider: g.out("BasicGuider", { model: [scaled, 2], conditioning: [r2v, 0] }),
    sampler: g.out("KSamplerSelect", { sampler_name: "er_sde" }),
    sigmas: g.out("BasicScheduler", { model: [scaled, 2], scheduler: "simple", steps: input.faceRefineSteps, denoise: input.faceRefineDenoise }),
    latent_image: [scaled, 0],
  });
  const redrawn = g.out("VAEDecode", { samples: [sampler, 0], vae: at.vae });
  // pasted over the face's own outline (SAM) when SAM is there, else over the face's box; faded out where no face is found
  const sam = Boolean(slots.faceSam) && FACE_REFINE_MASK.every((n) => ctx.has(n))
  const masked = sam
    ? { masks: g.out("H3FaceMaskSAM", { crops: [track, 0], sam_model: g.out("SAMLoader", { model_name: slots.faceSam, device_mode: "AUTO" }), transform: [track, 1], threshold: 0.93, dilation: 0, temporal_smooth: 5 }) }
    : {};
  const stitched = g.out("H3FaceStitch", {
    base_images: images, refined_crops: redrawn, transform: [track, 1], paste_region: "face_only", mask_dilation: 16, feather: 6,
    colour_match: 1, blend: 1, undetected_frames: "fade_out", feather_scales_with_crop: false, ...masked,
  });
  const loads = [`diffusion_models/${slots.faceRefineUnet}`, `ultralytics/${slots.faceDetector}`, ...(slots.faceSeg ? [`ultralytics/${slots.faceSeg}`] : []), ...(sam ? [`sams/${slots.faceSam}`] : [])];
  return { images: stitched, pass: { node: sampler, steps: input.faceRefineSteps }, loads };
}

/** Face refine's files, for the forms' sample builds (the graph checker's variants). */
export const FACE_REFINE_SLOTS = { faceRefineUnet: "minimax_h3_fused_refdelta_r1024_turbo8_int8.safetensors", faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth" };

/** The nodes a clip with Face refine on is built with, beside the clip's own (none required: it is done without when missing). */
// (its reference model's conditioning is the clip's own: a clip with a person's picture is made by the reference route)
export const FACE_REFINE_OPTIONAL = [...FACE_REFINE_NODES, ...FACE_REFINE_MASK, AUDIO_LOCK, "ImageScaleToTotalPixels"];
