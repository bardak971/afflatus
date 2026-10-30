import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";
import type { MorePicture } from "./condition";

/**
 * MiniMax H3 moved by a pose video: the driving video's people drawn as skeletons, frame by frame, and given to H3 by
 * alibaba-pai's Fun ControlNet Union 2.0 (ComfyUI's MiniMaxH3FunControlNetApply, a patch on the model). What the
 * picture shows comes from the picture, the reference pictures or the clip before; only the moves come from the video,
 * so a person replaced cannot come back through it (a swap takes their every frame in). Used by H3 · Motion transfer, on
 * every window: one with a Picture of its own, or one that carries on from a swap (card #42).
 *
 * Read from ComfyUI's code and the files (HANDOVER-swap-motion.md, phase 1, 2026-10-20): the control is VAE-encoded at the
 * sampled window's own size and lands on its rows only, so the reference pictures and a carried tail pass untouched, and the
 * pose covers the whole window, its run-up too. The 2.0 patch is curve-form (adaln_basis), as the fused swap turbo, ref2va
 * and DaSiWa's hybrids are: it loads on each. Its card trained Pose on DWPose skeletons; ComfyUI's own template draws
 * SDPose's. Which does better is not known yet: both are offered, DWPose first.
 */
export interface H3Motion {
  poseFrom: string;
  poseHands: boolean;
  poseFace: boolean;
  controlStrength: number;
  controlStart: number;
  controlEnd: number;
  /** The Fun ControlNet file, when not the h3Control slot's. */
  controlModel?: string;
}

/** Where the skeletons come from: comfyui_controlnet_aux's DWPose (the format the ControlNet was trained on), or ComfyUI's own SDPose. */
export const POSE_DWPOSE = "DWPose";
export const POSE_SDPOSE = "SDPose";

/** The chapter the motion's settings sit in. */
export const MOTION_CHAPTER = {
  id: "motion",
  label: "Motion",
  help: "How the source video moves the clip: its people drawn as skeletons (body, hands, face) frame by frame, which the Fun ControlNet holds H3 to. Nothing of the video's look comes through, only the moves.",
};

export const motionControlInputs: InputSpec[] = [
  {
    id: "controlModel", type: "model", label: "ControlNet", folder: "model_patches", slot: "h3Control", match: ["minimax.?h3.*fun.?controlnet"], chapter: "motion",
    note: "alibaba-pai's Fun ControlNet Union for MiniMax H3 (2.0), in ComfyUI's models/model_patches folder",
  },
  {
    id: "poseFrom", type: "choice", label: "Pose from", options: [POSE_DWPOSE, POSE_SDPOSE], default: POSE_DWPOSE, chapter: "motion",
    note: "what draws the skeletons. DWPose: the format the ControlNet was trained on (the comfyui_controlnet_aux pack). SDPose: ComfyUI's own, with RT-DETR finding the people (its two models)",
  },
  { id: "poseHands", type: "toggle", label: "Hands", default: true, chapter: "motion", note: "the fingers drawn too, so that the hands move as the video's" },
  { id: "poseFace", type: "toggle", label: "Face", default: true, chapter: "motion", note: "the face's landmarks drawn too: the mouth and the expression follow the video's (the face itself is the picture's)" },
  { id: "controlStrength", type: "number", label: "Control strength", min: 0, max: 2, step: 0.05, default: 1, chapter: "motion", note: "MiniMaxH3FunControlNetApply's strength: 1 is the ControlNet's own, the strongest it was trained at; above 1 only when the moves drift" },
  { id: "controlStart", type: "number", label: "Control from", min: 0, max: 1, step: 0.05, default: 0, chapter: "motion", advanced: true, note: "start_percent: the part of the sampling the pose holds. Later lets the first steps lay the scene out freely" },
  { id: "controlEnd", type: "number", label: "Control until", min: 0, max: 1, step: 0.05, default: 1, chapter: "motion", advanced: true, note: "end_percent: ending early lets the last steps finish the detail freely. On a turbo of 4 steps, each step is a quarter" },
];

/** The nodes a pose and its control take, by where the pose comes from. */
export function motionNodes(input: Pick<H3Motion, "poseFrom">): string[] {
  const pose = input.poseFrom === POSE_SDPOSE ? ["CheckpointLoaderSimple", "UNETLoader", "RTDETR_detect", "SDPoseKeypointExtractor", "SDPoseDrawKeypoints"] : ["DWPreprocessor"];
  return ["ModelPatchLoader", "MiniMaxH3FunControlNetApply", "LoadVideo", "GetVideoComponents", "ImageScale", ...pose];
}

/** The model files the control takes: the ControlNet, and SDPose's two when it draws the pose. */
export function motionNeeds(input: Pick<H3Motion, "poseFrom">): string[] {
  return ["h3Control", ...(input.poseFrom === POSE_SDPOSE ? ["sdpose", "rtdetr"] : [])];
}

/** What is said when the pose cannot be drawn on this ComfyUI. */
const DWPOSE_NEEDED = "Pose from DWPose needs the comfyui_controlnet_aux pack (ComfyUI-Manager installs it), or pick SDPose under Motion.";

/**
 * The skeletons of `file`'s frames at the clip's size: every person found, drawn on black, one frame for each. The
 * frames are made the clip's size first (as the control is fitted to it, centred) so that the pose is found at the size
 * it is used at.
 */
export function poseVideo(g: GraphBuilder, ctx: BuildContext, input: H3Motion, file: string, at: { width: number; height: number }): Ref {
  const was = g.at;
  // finding the people and drawing them is processing, not steps of the bar
  g.phase("processing");
  const frames = g.out("ImageScale", {
    image: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) }), 0],
    upscale_method: "lanczos", width: at.width, height: at.height, crop: "center",
  });
  let pose: Ref;
  if (input.poseFrom === POSE_SDPOSE) {
    const { sdpose, rtdetr } = ctx.slots;
    if (!sdpose || !rtdetr) throw new Error("Pose from SDPose needs sdpose_wholebody_fp16.safetensors (models/checkpoints) and rt_detr_v4-x-hgnet_fp16.safetensors (models/diffusion_models): Settings › Models has them.");
    // their models load as models do; finding and drawing is processing
    g.phase("loading");
    const model = g.add("CheckpointLoaderSimple", { ckpt_name: sdpose });
    const detector = g.out("UNETLoader", { unet_name: rtdetr, weight_dtype: "default" });
    g.phase("processing");
    // as ComfyUI's H3 ControlNet template: RT-DETR finds the people, SDPose their whole-body keypoints (feet and head too)
    const people = g.out("RTDETR_detect", { model: detector, image: frames, threshold: 0.5, class_name: "person", max_detections: 8 });
    const keypoints = g.out("SDPoseKeypointExtractor", { model: [model, 0], vae: [model, 2], image: frames, batch_size: 16, bboxes: people });
    pose = g.out("SDPoseDrawKeypoints", {
      keypoints, draw_body: true, draw_hands: input.poseHands, draw_face: input.poseFace, draw_feet: true,
      stick_width: 4, face_point_size: 2, score_threshold: 0.5, draw_head: true,
    });
  } else {
    if (!ctx.has("DWPreprocessor")) throw new Error(DWPOSE_NEEDED);
    const on = (yes: boolean) => (yes ? "enable" : "disable");
    // found at the clip's short side (on 64 px), as the guide picture's DWPose: its models download themselves the first time
    pose = g.out("DWPreprocessor", {
      image: frames, detect_hand: on(input.poseHands), detect_body: "enable", detect_face: on(input.poseFace),
      resolution: Math.min(2048, Math.round(Math.min(at.width, at.height) / 64) * 64),
      bbox_detector: "yolox_l.onnx", pose_estimator: "dw-ll_ucoco_384_bs5.torchscript.pt", scale_stick_for_xinsr_cn: "disable",
    });
  }
  g.phase(was);
  return pose;
}

/**
 * The clip before's last frame as handed over, as one more reference picture of the person: how they look on this
 * timeline (clothes, hair, glasses), held along the whole window. With the cast photo alone, a motion window took the
 * photo's navy shirt and grew its hair long past the carried frames' first second (the owner's Timeline 20, clip 3,
 * 2026-10-20): the carried tail holds only the start, and the photo is not dressed as the clip is. SCAIL-2 is given the
 * look on every frame by its picture; this is H3's nearest. None without a clip before.
 */
export function frameBefore(g: GraphBuilder, ctx: BuildContext): MorePicture[] {
  if (!ctx.uploads.previous) return [];
  const frames: Ref = [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.previous }) }), 0];
  return [{ image: g.out("ImageFromBatch", { image: frames, batch_index: -1, length: 1 }), role: "person" }];
}

/** The model held to `pose` by the Fun ControlNet: the patch loaded and applied, between the strength's start and end. */
export function controlled(g: GraphBuilder, ctx: BuildContext, input: H3Motion, model: Ref, vae: Ref, pose: Ref): { model: Ref; file: string } {
  const file = input.controlModel ?? ctx.slots.h3Control;
  if (!file) throw new Error("Motion needs the Fun ControlNet Union for MiniMax H3: minimax_h3_fun_controlnet_union_2.0_*.safetensors in ComfyUI's models/model_patches folder (Settings › Models has it).");
  const patched = g.out("MiniMaxH3FunControlNetApply", {
    model, model_patch: g.out("ModelPatchLoader", { name: file }), vae,
    strength: input.controlStrength, start_percent: input.controlStart, end_percent: Math.max(input.controlEnd, input.controlStart),
    control_video: pose,
  });
  return { model: patched, file };
}
