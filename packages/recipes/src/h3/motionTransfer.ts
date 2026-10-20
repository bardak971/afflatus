import { defineRecipe, gridAtOrBefore, type BuildContext, type ClipValue, type GraphBuilder, type InputSpec, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS, H3_GRID } from "./family";
import { h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video } from "./video";
import { H3_CONTINUATION_NODES, H3_SEAM, H3_TRIM } from "./join";
import { H3_STARTS, modelOf, turboNeeds } from "./model";
import { latentUpscaleNeeds } from "./latent-upscale";
import { upscaleNeeds } from "../video/upscale";
import { rifeNeeds } from "../shared/finish";
import { partBounds } from "../motion/driving";
import { SWAP_FRAMES, SWAP_RUN_UP } from "./swap";
import { controlled, frameBefore, MOTION_CHAPTER, motionControlInputs, motionNeeds, motionNodes, poseVideo, POSE_SDPOSE, type H3Motion } from "./motion";
import { FACE_REFINE_SLOTS } from "./faceRefine";

/**
 * MiniMax H3 · Motion transfer (the owner's, 2026-10-18; built 2026-10-20): a picture made to move like a driving video,
 * as SCAIL-2 · Motion transfer, by H3 held to the video's pose (the Fun ControlNet, motion.ts). The picture opens the
 * clip as its first frame (given, or made with Make the picture from the source's frame); on a timeline's source lane each
 * window after the first carries on from the one before, every one moved by its own part's pose. The cast's pictures can
 * be added as references (H3's reference model, or a hybrid), the face then held to them along the windows.
 */
export interface H3MotionTransfer extends H3Video, H3Motion {
  picture?: string;
  driving?: ClipValue;
  drivingStart: number;
  drivingSeconds: number;
  keepSound: boolean;
  soundGuide: boolean;
}

/** A window of H3: the swap's, 90 to 141 frames (5.9 s at 24). */
const MOTION_LEAST = 90;
/** Frames of the window before a window carries on from, unless the form says otherwise (H3's own 22). */
const MOTION_CARRIED = 22;
const MOTION_PART = partBounds({ fps: H3_FPS, most: SWAP_FRAMES, least: MOTION_LEAST });

/** H3's inputs this form does not take: the picture is its first frame, the driving video its length and shape, its sound the video's. */
const NOT_TAKEN = new Set([
  "description", "soundscape", "music", "start", "end", "mid", "midAt", "handover", "next", "landing",
  "refVideos", "voice", "voiceStart", "voiceSeconds", "voiceEven", "seconds", "shape",
]);

const inputs: InputSpec[] = [
  {
    id: "driving", type: "clip", role: "source", label: "Driving video", frames: [SWAP_FRAMES], fps: H3_FPS, whole: true,
    window: { start: "drivingStart", seconds: "drivingSeconds", fits: { frames: SWAP_FRAMES, fps: H3_FPS, pad: 0, min: MOTION_LEAST / H3_FPS, grid: H3_GRID } },
    note: "how it moves: the body, the hands, the face, drawn as skeletons. One job takes 5.8 s of it; a longer video goes on a timeline's source lane, window by window",
  },
  { id: "drivingStart", type: "number", label: "Driving video: start", min: 0, max: 3600, step: 0.1, default: 0, unit: " s", showWhen: "driving" },
  { id: "drivingSeconds", type: "number", label: "Driving video: length", min: MOTION_PART.least, max: MOTION_PART.most, step: 0.01, default: 5.175, unit: " s", showWhen: "driving" },
  {
    id: "picture", type: "image", role: "source", label: "Picture",
    note: "what moves, its first frame: its room, its light and its people are kept, only the motion comes from the video. In the driving video's shape: the video is cut to the picture's from the centre",
  },
  {
    // each window keeps its own (traits.windows.own): clip 6 of a source can show something else than clip 2
    id: "description", type: "prompt", weights: false, label: "Prompt", style: "sentences", optional: true, designed: true, noCast: true,
    placeholder: "The man with short brown hair, in a white shirt and jeans, dances in the living room, turning on the spot and raising his arms.",
    note: "who is in the picture and what they do in this part, in the present tense: optional, it helps H3 keep what is there. Each clip of a source keeps its own",
  },
  // H3's colour match pulls towards the first frame: here the picture
  ...h3Inputs.filter((spec) => !NOT_TAKEN.has(spec.id)).map((spec) => (spec.showWhen === "start" ? { ...spec, showWhen: "picture" } : spec)),
  { id: "keepSound", type: "toggle", label: "Keep the driving video's sound", default: true, advanced: true, note: "the file carries the driving video's own sound over its part; off, the sound H3 makes" },
  {
    id: "soundGuide", type: "toggle", label: "Lips follow the driving video's sound", default: true, advanced: true, showWhen: "keepSound",
    note: "the driving video's sound given to H3 as a guide, as Lip sync gives its recording, so that the mouth is drawn to the words heard",
  },
  ...motionControlInputs,
];

/** The frames of the window: the part handed over (or asked for), floored to H3's 17k + 5, 90 to 141 (the carried frames among them). */
function framesOf(input: H3MotionTransfer, ctx: Pick<BuildContext, "media">): number {
  const have = ctx.media.driving?.frames ?? Math.round(input.drivingSeconds * H3_FPS);
  return Math.max(MOTION_LEAST, gridAtOrBefore(Math.min(SWAP_FRAMES, have), H3_GRID));
}

/**
 * The window as an H3 clip: opening on the picture (none once it carries on from the window before, whose last frames
 * start it), its own part the window less the frames carried, the cast's pictures as references.
 */
function asClip(input: H3MotionTransfer, frames: number, carried: number): H3Video {
  return {
    ...input,
    start: input.previous ? undefined : input.picture,
    end: undefined, mid: undefined, next: undefined, voice: undefined, midAt: 0,
    soundscape: "", music: "", refVideos: [], handover: false, landing: "22",
    context: input.context || String(MOTION_CARRIED), joinFrom: input.joinFrom || "Latent",
    seconds: (frames - carried) / H3_FPS,
    shape: { width: 576, height: 1024 },
  };
}

export const h3MotionTransfer = defineRecipe<H3MotionTransfer>({
  id: "h3.motion",
  family: "h3",
  version: 1,
  title: "Motion transfer",
  summary: "A picture moved like a driving video, H3 held to its pose: the picture's room, light and people kept, the motion the video's. Audio included.",
  output: "video",
  // made from a picture and another video; on a timeline, a window of a long source carrying on from the window before (its
  // last frames, in its latent), each window with its own prompt
  traits: {
    startFrame: false, endFrame: false, midFrames: false, continues: "clip", endAnchor: false, sound: true, fps: H3_FPS, frameGrid: H3_GRID,
    latentTrim: H3_TRIM, latentNodes: [...H3_CONTINUATION_NODES, H3_SEAM],
    windows: { most: SWAP_FRAMES, least: MOTION_LEAST, carried: MOTION_CARRIED, runUp: SWAP_RUN_UP, own: ["description"] },
  },
  inputs,
  chapters: [MOTION_CHAPTER],
  starts: H3_STARTS,
  presets: h3Video.presets,
  needsWith: (input, slots) => [...turboNeeds(input, slots), ...latentUpscaleNeeds(input), ...upscaleNeeds(input), ...rifeNeeds(input.smooth), ...motionNeeds(input)],
  nodes: (input) => [...new Set([
    // carrying on, the clip before's last frame is a picture of who moves: the reference route (with H3's reference model there)
    ...h3Video.nodes({ ...asClip(input, SWAP_FRAMES, input.previous ? MOTION_CARRIED : 0), ...(input.previous ? { references: [...input.references, { asset: "frame", role: "person" }] } : {}) }), ...motionNodes(input),
    ...(input.keepSound ? ["TrimAudioDuration"] : []), ...(input.keepSound && input.soundGuide ? ["MiniMaxH3AddGuide"] : []),
  // (carrying on with no cast photo, the frame is the only picture: nothing loaded from a file)
  ])].filter((n) => !(n === "LoadImage" && input.previous && input.references.length === 0)),
  // core's ImageFromBatch: the clip before's last frame, taken as a picture where the reference route runs (known by the slots)
  optionalNodes: [...(h3Video.optionalNodes ?? []), "ImageFromBatch"],
  finishing: (input) => h3Video.finishing!(asClip(input, SWAP_FRAMES, 0)),

  build(input, ctx) {
    if (!input.picture || !ctx.uploads.picture) throw new Error("Motion transfer needs a picture: what moves.");
    if (!input.driving || !ctx.uploads.driving) throw new Error("Motion transfer needs a driving video: how it moves.");
    const frames = framesOf(input, ctx);
    const carried = input.previous ? ctx.media.previous?.frames ?? MOTION_CARRIED : 0;
    const driving = ctx.media.driving;
    const keep = input.keepSound && Boolean(driving?.hasSound);
    // the picture is H3's first frame: its upload and its size where H3 reads a start picture
    const asStart = {
      ...ctx,
      uploads: { ...ctx.uploads, ...(ctx.uploads.picture ? { start: ctx.uploads.picture } : {}) },
      media: { ...ctx.media, ...(ctx.media.picture ? { start: ctx.media.picture } : {}) },
    };
    let heard: Ref | null = null;
    const drivingSound = (g: GraphBuilder, n: number) =>
      (heard ??= g.out("TrimAudioDuration", { audio: [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.driving }) }), 1], start_index: 0, duration: n / H3_FPS }));
    const clip = asClip(input, frames, carried);
    // a window carrying on is also given the clip before's last frame as a picture of who moves (how they look by now),
    // when H3's reference route can run here: a reference model there, or a hybrid picked (else the frames carried alone)
    const canRefer = input.references.length > 0 || Boolean(ctx.slots.refUnet) || modelOf(clip, ctx.slots).hybrid;
    const built = buildH3(clip, asStart, {
      ...(input.previous && canRefer ? { pictures: (g: GraphBuilder) => frameBefore(g, ctx) } : {}),
      ...(keep ? { sound: (g, _decoded, at) => drivingSound(g, at.frames) } : {}),
      ...(keep && input.soundGuide ? {
        guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: drivingSound(g, at.frames), frame_idx: 0 }),
      } : {}),
      model: (g, model, at) => {
        const pose = poseVideo(g, ctx, input, ctx.uploads.driving!, at);
        const made = controlled(g, ctx, input, model, at.vae, pose);
        const sd = input.poseFrom === POSE_SDPOSE ? [`checkpoints/${ctx.slots.sdpose}`, `diffusion_models/${ctx.slots.rtdetr}`] : [];
        return { model: made.model, loads: [`model_patches/${made.file}`, ...sd] };
      },
    });
    return built;
  },

  variants: ((): Variant<H3MotionTransfer>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
      h3Control: "minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors", sdpose: "sdpose_wholebody_fp16.safetensors", rtdetr: "rt_detr_v4-x-hgnet_fp16.safetensors", rife: "rife49.pth",
    };
    const part = { width: 720, height: 1280, frames: 141, fps: H3_FPS, hasSound: true };
    const picture = { width: 832, height: 1472 };
    const before = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    return [
      {
        name: "a picture moved by the driving video's pose (DWPose), its sound kept",
        input: { picture: "p1", driving: { asset: "v1" }, description: "A man dances in a living room." },
        slots: all, uploads: { picture: "p.png", driving: "v.mp4" }, media: { picture, driving: part },
      },
      {
        name: "the cast's picture as a reference, the pose from SDPose, full steps",
        input: { picture: "p1", driving: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], poseFrom: POSE_SDPOSE, fast: false, poseHands: false },
        slots: all, uploads: { picture: "p.png", driving: "v.mp4", "references.0": "r1.png" }, media: { picture, driving: part },
      },
      {
        name: "Face refine of the cast person (a Finish of it loads its own latent)",
        input: { picture: "p1", driving: { asset: "v1" }, references: [{ asset: "r1", role: "person" }], faceRefine: true },
        slots: { ...all, ...FACE_REFINE_SLOTS }, uploads: { picture: "p.png", driving: "v.mp4", "references.0": "r1.png", "self.latent": "own.safetensors" }, media: { picture, driving: part },
      },
      {
        // one file that is all three: no reference model, no turbo LoRA
        name: "a hybrid turbo fine-tune, the cast's picture as a reference, its colours matched to the picture, RIFE",
        input: { picture: "p1", driving: { asset: "v1" }, model: "SomeoneH3_hybridTurboV3.safetensors", references: [{ asset: "r1", role: "person" }], colourMatch: true, smooth: true, fast: true },
        slots: all, uploads: { picture: "p.png", driving: "v.mp4", "references.0": "r1.png" }, media: { picture, driving: part },
      },
      {
        name: "a window that carries on from the one before, a short run-up, the sound H3 makes",
        input: { picture: "p1", driving: { asset: "v1", at: 5 }, previous: { asset: "w1" }, context: "5", keepSound: false },
        slots: all, uploads: { picture: "p.png", driving: "v.mp4", previous: "w.mp4" }, media: { picture, driving: { ...part, frames: 124 }, previous: { ...before, frames: 5 } },
      },
    ];
  })(),
});
