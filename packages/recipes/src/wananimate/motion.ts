import { defineRecipe, GraphBuilder, type Variant } from "@afflatus/core";
import { WAN_ANIMATE_FPS, WAN_ANIMATE_WINDOW } from "./family";
import { WAN_NEGATIVE } from "../wan/video";
import { applyLoras, livePreview, loraLoads } from "../shared/model";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import {
  drivingFrames, matchedToDriving, previousFrames, previousInput, MOTION_GRID, MOTION_NODES, MOTION_OPTIONAL, motionCanvas, motionFrames, motionInputs, motionOutInputs, motionSaved,
  type MotionShape, type MotionValues,
} from "../motion/driving";

/**
 * Wan Animate 2 · Motion transfer, as ComfyUI's template (video_wan_animate2) runs it: the driving video is the pose input as
 * it is, the picture the reference, the motion branch given an empty prompt of its own, lightx2v at 1 on the int8 model, its
 * cache of the driving video's reading, 6 steps of LCM at CFG 1 and shift 5, one 81-frame window a job (see SHAPE). The
 * latent it returns starts with the reference's own frame, trimmed off before decoding.
 */
export interface WanAnimateMotion extends MotionValues {
  steps: number;
  shift: number;
  cfg: number;
  poseStrength: number;
  referenceStrength: number;
  negative: string;
  motion: string;
  cache: string;
  livePreview: boolean;
}

/**
 * One window a job (81 frames, 3.4 s). The model (16 GB) does not fit a 12 GB card: its weights stream in at every step,
 * and a longer part in one job, by context windows or windows one after another, took 50 to 80 minutes for 10 s where a
 * window alone takes about 6 (2026-10-14). Longer: windows on a timeline, each carrying on from the one before (Previous clip).
 */
const SHAPE: MotionShape = { fps: WAN_ANIMATE_FPS, most: WAN_ANIMATE_WINDOW, least: 9 };

/** Where the reference's cached activations are kept: on the card (the template's), or in RAM when it does not fit. */
const CACHES: Record<string, { device: string; dtype: string }> = { "On the card, int8": { device: "gpu", dtype: "int8" }, "In RAM, int8": { device: "cpu", dtype: "int8" } };

export const wanAnimateMotion = defineRecipe<WanAnimateMotion>({
  id: "wananimate.motion",
  family: "wananimate",
  version: 1,
  title: "Motion transfer",
  summary: "A picture moved like a driving video, at the video's own frame rate. The picture's room, light and people are kept; the motion is the video's.",
  output: "video",
  traits: { startFrame: false, endFrame: false, midFrames: false, continues: false, endAnchor: false, sound: true, fps: WAN_ANIMATE_FPS, frameGrid: MOTION_GRID },
  inputs: [
    ...motionInputs(SHAPE, "Character Description: A man in his thirties with short brown hair and a short beard, a black t-shirt and a silver watch.\nBackground description: A crowded room lit by deep red light, people standing behind him."),
    {
      id: "motion", type: "prompt", label: "Motion", style: "sentences", optional: true, noCast: true, designed: true,
      placeholder: "He raps to the camera, moving his hands to the beat.",
      note: "what the person does, in a sentence: the prompt of the model's motion branch (its template's second text). Empty: it reads the video alone",
    },
    { id: "steps", type: "number", label: "Steps", min: 2, max: 40, step: 1, default: 6, advanced: true, perModel: true, note: "6 with the lightx2v LoRA, as ComfyUI's template" },
    { id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true, note: "1 with the lightx2v LoRA. Above 1 the negative prompt acts and every step takes twice as long" },
    { id: "shift", type: "number", label: "Shift", min: 0, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
    { id: "poseStrength", type: "number", label: "Pose strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "how hard the driving video's motion is held to: 1 as trained" },
    { id: "referenceStrength", type: "number", label: "Picture strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "how hard the frames hold to the picture: below 1 lets the prompt change it, above holds the face against drift" },
    { id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, default: WAN_NEGATIVE, advanced: true, perModel: true, note: "acts with a CFG scale above 1. The starting text is Wan's own, in Chinese" },
    {
      // in RAM by default: on the card (the template's) a 12 GB card ran out of memory at 576p after 28 minutes; in RAM 3.4 s took 3.4 minutes (2026-10-14)
      id: "cache", type: "choice", label: "Picture cache", options: Object.keys(CACHES), default: "In RAM, int8", advanced: true,
      note: "where the model's reading of the driving video is kept between steps, so that it is made once: in RAM (about 6 GB at 480p for 81 frames), or on the card, quicker when the card has the room",
    },
    {
      id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
      note: "while it renders, a short clip of what is forming, each step. Without it the preview is one still frame. A small cost per step. Needs the KJNodes pack",
    },
    previousInput(WAN_ANIMATE_FPS, 1),
    ...motionOutInputs(WAN_ANIMATE_FPS),
  ],
  needs: ["turbo", "clipVision"],
  nodes: () => [
    ...MOTION_NODES, "UNETLoader", "LoraLoaderModelOnly", "CLIPLoader", "VAELoader", "CLIPTextEncode", "CLIPVisionLoader", "CLIPVisionEncode", "ImageFromBatch",
    "WanAnimate2ToVideo", "WanAnimate2Cache", "ModelSamplingSD3", "KSamplerSelect", "BasicScheduler", "SamplerCustom", "TrimVideoLatent", "VAEDecode",
  ],
  optionalNodes: [...MOTION_OPTIONAL, VHS, ...CORE_VIDEO_OUT, "ModelPreviewOverrideKJ"],

  build(input, ctx) {
    if (!input.picture || !ctx.uploads.picture) throw new Error("Motion transfer needs a picture: what moves.");
    if (!input.driving || !ctx.uploads.driving) throw new Error("Motion transfer needs a driving video: how it moves.");
    const { slots } = ctx;
    for (const [slot, file] of [["unet", "wan_animate_2_int8_convrot.safetensors"], ["clip", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"], ["vae", "wan_2.1_vae.safetensors"], ["clipVision", "clip_vision_h.safetensors"]] as const) {
      if (!slots[slot]) throw new Error(`Wan Animate 2 needs ${file} (Settings › Models has it).`);
    }
    const frame = motionCanvas(input, ctx, 16);
    const total = motionFrames(input, ctx, SHAPE);
    const g = new GraphBuilder();
    const { frames: pose, parts } = drivingFrames(g, ctx, frame);
    // the picture at the clip's own frame, cut to its shape from the centre, as the template has it
    const picture = g.out("ImageScale", { image: g.out("LoadImage", { image: ctx.uploads.picture }), upscale_method: "area", width: frame.width, height: frame.height, crop: "center" });

    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "wan", device: "default" });
    const vae = g.out("VAELoader", { vae_name: slots.vae });
    const vision = g.out("CLIPVisionLoader", { clip_name: slots.clipVision });

    let model = g.out("UNETLoader", { unet_name: slots.unet, weight_dtype: "default" });
    if (slots.turbo) model = g.out("LoraLoaderModelOnly", { model, lora_name: slots.turbo, strength_model: 1 });
    model = applyLoras(g, model, input.loras);
    const cache = CACHES[input.cache] ?? CACHES["In RAM, int8"]!;
    model = g.out("WanAnimate2Cache", { model, device: cache.device, dtype: cache.dtype });
    const sigmas = g.out("BasicScheduler", { model, scheduler: "simple", steps: input.steps, denoise: 1 });
    const sampling = livePreview(g, ctx, g.out("ModelSamplingSD3", { model, shift: input.shift }), input.livePreview);

    const before = previousFrames(g, ctx);
    const cond = g.add("WanAnimate2ToVideo", {
      positive: g.out("CLIPTextEncode", { clip, text: input.prompt.trim() }), negative: g.out("CLIPTextEncode", { clip, text: input.negative }), vae,
      width: frame.width, height: frame.height, length: total, batch_size: 1, video_frame_offset: 0,
      pose_strength: input.poseStrength, pose_start_percent: 0, pose_end_percent: 1, reference_image_strength: input.referenceStrength,
      reference_image: picture, pose_video: pose, clip_vision_output: g.out("CLIPVisionEncode", { clip_vision: vision, image: picture, crop: "none" }),
      // the motion branch's own prompt (what the person does, not who: empty by default), and the driving video's first frame as its CLIP vision
      positive_pose: g.out("CLIPTextEncode", { clip, text: input.motion.trim() }),
      clip_vision_output_pose: g.out("CLIPVisionEncode", { clip_vision: vision, image: g.out("ImageFromBatch", { image: pose, batch_index: 0, length: 1 }), crop: "none" }),
      ...(before ? { continue_motion: before } : {}),
    });
    g.phase("sampling");
    const sampled = g.add("SamplerCustom", {
      model: sampling, add_noise: true, noise_seed: ctx.seed, cfg: input.cfg, positive: [cond, 0], negative: [cond, 1],
      sampler: g.out("KSamplerSelect", { sampler_name: "lcm" }), sigmas, latent_image: [cond, 2],
    });
    g.phase("decoding");
    // the reference's frame trimmed off the front, then the clip held to the part's frames
    const decoded = g.out("VAEDecode", { samples: g.out("TrimVideoLatent", { samples: [sampled, 0], trim_amount: [cond, 3] }), vae });
    // carrying on from the clip before, its frame at the start (the node says how many) is that clip's: dropped
    const made = before ? g.out("ImageFromBatch", { image: decoded, batch_index: [cond, 4], length: 4096 }) : g.out("ImageFromBatch", { image: decoded, batch_index: 0, length: total });
    const images = matchedToDriving(g, ctx, made, pose, input, frame);
    const saved = motionSaved(g, ctx, images, input, { frame, fps: WAN_ANIMATE_FPS, frames: total, parts });
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: saved.out, kind: "video", role: "result" }],
      totalSteps: input.steps,
      passes: [{ node: sampled, steps: input.steps }],
      loads: [
        ...saved.loads, `diffusion_models/${slots.unet}`, `text_encoders/${slots.clip}`, `vae/${slots.vae}`, `clip_vision/${slots.clipVision}`,
        ...(slots.turbo ? [`loras/${slots.turbo}`] : []), ...loraLoads(input.loras),
      ],
    };
  },

  variants: ((): Variant<WanAnimateMotion>[] => {
    const slots = {
      unet: "wan_animate_2_int8_convrot.safetensors", turbo: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors", clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
      vae: "wan_2.1_vae.safetensors", clipVision: "clip_vision_h.safetensors", tinyVae: "taew2_1.safetensors", rife: "rife49.pth",
    };
    const picture = { width: 768, height: 1360 };
    const part = (seconds: number) => ({ width: 480, height: 854, frames: Math.round(seconds * WAN_ANIMATE_FPS), fps: WAN_ANIMATE_FPS, hasSound: true });
    return [
      {
        name: "one window, matched to the driving video, its sound kept",
        input: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 3.3, prompt: "A man raps to the camera." },
        slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture, driving: part(3.4) },
      },
      {
        name: "carrying on from the clip before",
        input: { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" }, drivingSeconds: 3.3 },
        slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture, driving: part(3.4), previous: { width: 480, height: 854, frames: 1, fps: WAN_ANIMATE_FPS } },
      },
    ];
  })(),
});
