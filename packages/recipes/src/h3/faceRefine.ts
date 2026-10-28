import { packOfNode, wanted, type BuildContext, type GraphBuilder, type InputSpec, type Ref } from "@afflatus/core";
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
/** Why a Finish › Face refine cannot be made where its pack is not: it does nothing but the pass. */
export const FACE_REFINE_PACK_NEEDED = "Not face-refined: Face refine's node pack (comfyui-h3-facerefine) is not on this ComfyUI.";
/** The clip's sound held while the crops are redrawn (afflatus-nodes). */
export const AUDIO_LOCK = "AfflatusH3AudioLock";

export const FACE_REFINE_INPUTS: InputSpec[] = [
  {
    id: "faceRefine", type: "toggle", label: "Face refine", default: false, section: "out",
    note: "after the render, the face is cropped, redrawn against the person's picture (the cast's, else a person reference picture, else the picture the clip opens on) and pasted back. The pose, light and expression stay the render's. Best on slow-moving shots: when the person moves a lot, the face follows the source's expression less, and arms over the head can be redrawn into the hair",
  },
  {
    id: "faceRefineDenoise", type: "number", label: "Face refine denoise", min: 0.3, max: 0.6, step: 0.05, default: 0.45, showWhen: "faceRefine", advanced: true, section: "out",
    // ComfyUI's denoise at the model's shift, kept as it is (card #144, 2026-10-28): on H3 the whole range starts the
    // redraw near σ 0.84–0.96 (0.45 over 4 steps: 0.92), and that strength is what refines a small face (likeness 0.34 →
    // 0.63 on Timeline 6's clip 22); a real σ on a karras tail stopped it refining, and the owner preferred this by eye
    note: "ComfyUI's denoise at the model's shift, so the face is redrawn strongly: on H3 the whole range starts near 0.84–0.96 of real noise, and a step of 0.05 changes little (0.45 and 0.5 are the same). It applies in full to the smallest faces (30 px and under); a face of 120 px and more gets about a third of it, as it holds detail of its own. More is closer to the picture and further from the render",
  },
  { id: "faceRefineSteps", type: "number", label: "Face refine steps", min: 2, max: 8, step: 1, default: 4, showWhen: "faceRefine", advanced: true, section: "out", note: "4 is what it was tested at; 8 kept less of the likeness" },
  // a finish of a kept take (Finish › Face refine): its own latent loaded, nothing sampled, only the faces redrawn
  { id: "faceRefineOnly", type: "toggle", label: "Face refine only", default: false, internal: true },
];

/**
 * Face refine on a recipe that is not H3's (SCAIL-2 at 24 fps): no "only" input (its finish redraws the take's own frames,
 * it keeps no latent), and 0.35 to start on: on a SCAIL dance (Timeline 26, 2026-10-21) 0.45 stopped the mouth following
 * the source (r 0.60 to 0.15) and smeared a frame, where 0.35 kept 90 % of the likeness and the source's mouth, eyes and head.
 */
export const FACE_REFINE_OTHER_INPUTS: InputSpec[] = FACE_REFINE_INPUTS.filter((spec) => spec.id !== "faceRefineOnly").map((spec) =>
  spec.id === "faceRefineDenoise" && spec.type === "number" ? { ...spec, default: 0.35, note: `${spec.note}. 0.35 here: 0.45 stopped the mouth following the source` } : spec);

/**
 * Face refine on a model that keeps no H3 latent for a finish to redraw from (LTX 2.5): H3's own settings, words and
 * defaults (every form alike), less the internal "only" a finish of a kept H3 latent sets. A finish redraws the take's frames.
 */
export const FACE_REFINE_TAKE_INPUTS: InputSpec[] = FACE_REFINE_INPUTS.filter((spec) => spec.id !== "faceRefineOnly");

/**
 * The H3 nodes Face refine runs on beside a model that is not H3's (the text encoder, VAEs, loader and scheduler are ComfyUI's
 * own node types); its pack's nodes and the audio lock stay optional, done without when missing.
 */
export const FACE_REFINE_H3 = ["MiniMaxH3ReferenceToVideo", "MiniMaxH3SigmaShift", "ModelAttentionBackend", "SamplerCustomAdvanced", "RandomNoise", "BasicGuider"];

/** What Face refine reads of a form: its own settings, and the person's words and pictures. */
export type FaceRefineValues = Pick<H3Video, "faceRefine" | "faceRefineDenoise" | "faceRefineSteps" | "references" | "subject" | "quick">;

/**
 * The person's picture the faces are drawn towards: the cast's (a "person" reference), else the one the recipe gives (the
 * picture the clip opens on, SCAIL's Picture: the person it moves); null when there is none (the toggle then does nothing,
 * and the job says why). A place, clothing, object or style picture is no face to draw towards: tracked against a place
 * photo, the faces were redrawn toward it, while the likeness score read the person's alone (B19).
 */
export function facePicture(input: Pick<H3Video, "references">, ctx: Pick<BuildContext, "uploads">, fallback?: string): string | null {
  const refs = input.references ?? [];
  const person = refs.findIndex((r, i) => r.role === "person" && ctx.uploads[`references.${i}`]);
  return person >= 0 ? (ctx.uploads[`references.${person}`] ?? null) : (fallback ?? null);
}

/** The picture an H3 clip opens on, when it opens on one (not carrying on from a clip before): who Face refine follows without a cast. */
export const openingPicture = (input: Pick<H3Video, "start" | "previous">, ctx: Pick<BuildContext, "uploads">): string | undefined =>
  input.start && !input.previous ? ctx.uploads.start : undefined;

/**
 * The family's files a clip with Face refine on needs (Recipe.needsWith, and a Finish › Face refine of a take that keeps no
 * latent): the fused reference turbo and the face detector, the person detector and SAM the pass uses when they are there
 * (a pod is sent only what its graph loads: SAM only where its nodes are), and with `own` (a recipe that is not H3's) H3's
 * text encoder and VAEs. Optional in the family, they were asked for by no form: on a fresh pod the pass was left out, and
 * a Finish › Face refine was a paid decode of the take as it was. None for a clip with no person's picture to refine
 * towards (a person reference; `picture`: the recipe's own picture stands in, as SCAIL's or the one a clip opens on), which the
 * pass leaves as it is (faceRefineSkipped): a machine without them was held for files it never loads.
 */
export function faceRefineNeeds(input: Partial<Pick<H3Video, "faceRefine" | "references">>, opts: { own?: boolean; picture?: boolean } = {}): string[] {
  if (!input.faceRefine || (!(input.references ?? []).some((r) => r.role === "person") && !opts.picture)) return [];
  return ["faceRefineUnet", "faceDetector", "faceSeg", "faceSam", ...(opts.own ? ["faceClip", "faceVideoVae", "faceAudioVae"] : [])];
}

/**
 * Why a clip with Face refine on is made without it, or null when it is refined (said on its job). `own`: the recipe has
 * none of H3's text encoder and VAEs of its own (SCAIL), so the pass loads them from the family's Face refine slots.
 * `audio`: the clip's sound is held while the crops are redrawn, by the Afflatus node pack's audio lock.
 */
export function faceRefineSkipped(input: Pick<H3Video, "faceRefine" | "references">, ctx: Pick<BuildContext, "uploads" | "slots"> & Partial<Pick<BuildContext, "has">>, opts: { picture?: string; own?: boolean; audio?: boolean } = {}): string | null {
  if (!input.faceRefine) return null;
  if (!facePicture(input, ctx, opts.picture)) return "Not face-refined: the clip has no person's picture (a cast person, a person reference picture, or a picture it opens on).";
  if (opts.own && !(ctx.slots.faceClip && ctx.slots.faceVideoVae && ctx.slots.faceAudioVae)) return "Not face-refined: MiniMax H3's text encoder and VAEs are not on this ComfyUI (Settings › Models has them, with the model's Face refine files).";
  if (!ctx.slots.faceRefineUnet) return "Not face-refined: no fused reference turbo model on this ComfyUI (Settings › Models has it, under MiniMax H3).";
  if (!ctx.slots.faceDetector) return "Not face-refined: no face detector on this ComfyUI (face_yolov8m.pt in models/ultralytics/bbox; Settings › Models has it).";
  // an older pack (before 0.32.0) has no audio lock: the pass was left out without a word, and the take named a face pass
  if (opts.audio && ctx.has && !ctx.has(AUDIO_LOCK)) return "Not face-refined: this ComfyUI's Afflatus node pack has no H3 Audio Lock yet (0.32.0 on; ComfyUI loads a newer pack when it restarts).";
  return null;
}

/**
 * Why a Face refine pastes the face back over its box rather than SAM's outline of it, said on its job as an option done
 * without is (jobPacks ranWithoutSaid): a pod whose Impact Pack failed to install, or a ComfyUI without it or without SAM's
 * model, made the coarser paste without a word (card #47). Null when SAM's outline is used.
 */
export function faceBoxSaid(ctx: Pick<BuildContext, "slots" | "has">): string | null {
  const what = "Ran without SAM's outline (the face pasted over its box)";
  const lacked = FACE_REFINE_MASK.find((n) => !ctx.has(n));
  if (lacked) return `${what}: its node pack ${packOfNode(lacked)?.name ?? lacked} is missing.`;
  if (!ctx.slots.faceSam) return `${what}: no SAM model on this ComfyUI (sam_vit_b_01ec64.pth in models/sams; Settings › Models has it).`;
  return null;
}

/** What Face refine made: the frames, its sampler and steps (a pass of the job's progress), the files it loads, and what its job says of it. */
export interface FaceRefined {
  images: Ref;
  pass: { node: string; steps: number } | null;
  loads: string[];
  /** Why the face was pasted over its box (faceBoxSaid); null when SAM's outline was used, or nothing was refined. */
  said: string | null;
}

/** The frame counts H3 samples: 17k + 5 (the pass pads to the next one, and cuts its result back). */
const onH3Grid = (frames: number) => (frames < 5 ? 5 : frames + ((17 - ((frames - 5) % 17)) % 17));

/**
 * The decoded frames with their faces redrawn, or the frames as they were (Face refine off, no picture, no model, or the
 * pack not installed where the job runs). `audio` is the clip's own sound, held as it is while the crops are redrawn (none:
 * redrawn without it); `clip`, `vae` and `audioVae` the H3 clip's own, else (a recipe that is not H3's) loaded from the
 * family's Face refine slots; `picture` the recipe's own picture of the person, when the form has no reference; `frames`
 * the count of `images` when it may be off H3's 17k + 5 (a SCAIL window that dropped the frames it carried on from); `only`
 * a Finish › Face refine, which redraws the faces and nothing else.
 */
export function faceRefined(
  g: GraphBuilder, ctx: BuildContext, input: FaceRefineValues, images: Ref,
  at: { audio?: Ref; vae?: Ref; audioVae?: Ref; clip?: Ref; picture?: string; frames?: number; only?: boolean },
): FaceRefined {
  const as: FaceRefined = { images, pass: null, loads: [], said: null };
  const own = !at.clip;
  if (!input.faceRefine || faceRefineSkipped(input, ctx, { picture: at.picture, own, audio: Boolean(at.audio) })) return as;
  // a Finish › Face refine is the pass alone: its pack is one it cannot run without, never an option to do without (its
  // Queue row offered Run without, and the finish then failed for want of the pass)
  if (at.only && !ctx.has(FACE_STITCH)) throw new Error(FACE_REFINE_PACK_NEEDED);
  if (!at.only && !wanted(ctx, { input: "faceRefine", nodes: [FACE_STITCH], without: "Face refine" })) return as;
  const face = facePicture(input, ctx, at.picture);
  if (!face) return as;
  const { slots } = ctx;
  g.phase("refining");
  const clip = at.clip ?? g.out("CLIPLoader", { clip_name: slots.faceClip, type: "minimax", device: "default" });
  const vae = at.vae ?? g.out("VAELoader", { vae_name: slots.faceVideoVae });
  const audioVae = at.audioVae ?? g.out("VAELoader", { vae_name: slots.faceAudioVae });
  // a count off H3's grid is made up to the next one with the last frame again, and the redrawn frames cut back to it
  const pad = at.frames ? onH3Grid(at.frames) - at.frames : 0;
  const base: Ref = pad ? g.out("ImageBatch", { image1: images, image2: g.out("RepeatImageBatch", { image: g.out("ImageFromBatch", { image: images, batch_index: -1, length: 1 }), amount: pad }) }) : images;
  const picture = g.out("ImageScaleToTotalPixels", { image: g.out("LoadImage", { image: face }), upscale_method: "lanczos", megapixels: 0.48, resolution_steps: 1 });
  // the person followed by face identity against the picture, the crop 2.5 face heights square on a 512 canvas (up to 768
  // for a face that would be enlarged past it), its centre and size smoothed over 21 and 51 frames; where no face is found,
  // the person detector's head, when that model is there
  const track = g.add("H3FaceTrackCrop", {
    images: base, detector: slots.faceDetector, confidence: 0.35, crop_factor: 2.5, canvas_width: 512, canvas_height: 512, canvas_mode: "auto_capped_768",
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
    clip, prompt: `Close-up of the face of the person in <Picture 1>${subject}. Sharp focus, clear details.`,
    width: [track, 4], height: [track, 5], length: [track, 6], ref_image_size: "match", vae, audio_vae: audioVae,
    "ref_images.ref_image_0": picture, ...(at.audio ? { "ref_audios.ref_audio_0": at.audio } : {}),
  });
  const started = g.out("H3InjectVideoLatent", { av_latent: [r2v, 1], images: [track, 0], vae });
  // without a sound, H3 makes one beside the redrawn faces, and it is left out
  const held = at.audio ? g.out(AUDIO_LOCK, { av_latent: started, audio_vae: audioVae, audio: at.audio }) : started;
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
  const redrawn = g.out("VAEDecode", { samples: [sampler, 0], vae });
  // pasted over the face's own outline (SAM) when SAM is there, else over the face's box; faded out where no face is found
  const boxed = faceBoxSaid(ctx);
  const sam = !boxed;
  const masked = sam
    ? { masks: g.out("H3FaceMaskSAM", { crops: [track, 0], sam_model: g.out("SAMLoader", { model_name: slots.faceSam, device_mode: "AUTO" }), transform: [track, 1], threshold: 0.93, dilation: 0, temporal_smooth: 5 }) }
    : {};
  const stitched = g.out("H3FaceStitch", {
    base_images: base, refined_crops: redrawn, transform: [track, 1], paste_region: "face_only", mask_dilation: 16, feather: 6,
    colour_match: 1, blend: 1, undetected_frames: "fade_out", feather_scales_with_crop: false, ...masked,
  });
  const loads = [
    `diffusion_models/${slots.faceRefineUnet}`, `ultralytics/${slots.faceDetector}`, ...(slots.faceSeg ? [`ultralytics/${slots.faceSeg}`] : []), ...(sam ? [`sams/${slots.faceSam}`] : []),
    ...(own ? [`text_encoders/${slots.faceClip}`, `vae/${slots.faceVideoVae}`, `vae/${slots.faceAudioVae}`] : []),
  ];
  const out: Ref = pad ? g.out("ImageFromBatch", { image: stitched, batch_index: 0, length: at.frames! }) : stitched;
  return { images: out, pass: { node: sampler, steps: input.faceRefineSteps }, loads, said: boxed };
}

/** Face refine's files, for the forms' sample builds (the graph checker's variants). */
export const FACE_REFINE_SLOTS = { faceRefineUnet: "minimax_h3_fused_refdelta_r1024_turbo8_int8.safetensors", faceDetector: "bbox/face_yolov8m.pt", faceSeg: "segm/person_yolov8m-seg.pt", faceSam: "sam_vit_b_01ec64.pth" };
/** And H3's own pieces, for a recipe that is not H3's (SCAIL's variants). */
export const FACE_REFINE_OWN_SLOTS = { faceClip: "qwen3vl_minimax_h3.safetensors", faceVideoVae: "minimax_h3_video_vae.safetensors", faceAudioVae: "minimax_h3_audio_vae.safetensors" };

/** The nodes a clip with Face refine on is built with, beside the clip's own (none required: it is done without when missing). */
// (its reference model's conditioning is the clip's own: a clip with a person's picture is made by the reference route)
export const FACE_REFINE_OPTIONAL = [...FACE_REFINE_NODES, ...FACE_REFINE_MASK, AUDIO_LOCK, "ImageScaleToTotalPixels"];
