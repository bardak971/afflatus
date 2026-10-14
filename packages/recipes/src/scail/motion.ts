import { defineRecipe, GraphBuilder, type Ref, type Variant } from "@afflatus/core";
import { SCAIL_CARRIED, SCAIL_CHUNK, SCAIL_FPS } from "./family";
import { applyLoras, livePreview, loraLoads } from "../shared/model";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import {
  chunkLengths, drivingFrames, previousFrames, previousInput, matchedToDriving, MOTION_GRID, MOTION_NODES, MOTION_OPTIONAL, motionOutInputs, motionCanvas, motionFrames, motionInputs,
  motionSaved, type MotionShape, type MotionValues,
} from "../motion/driving";

/**
 * SCAIL-2 · Motion transfer: the picture's people moved like the driving video's. As ComfyUI's SCAIL-2 template runs it in
 * its Animation mode (the mode the meme test used, 2026-10-14): SAM 3 finds the people in both and colours who is who, the
 * driving video's pose and those colours condition the model, the picture is its reference. A part longer than one chunk
 * (81 frames, 5.1 s) is made in chunks inside the job, each anchored on the last 5 frames of the one before and its
 * colours matched to that one's last frame, as the template's Extend does.
 */
export interface ScailMotion extends MotionValues {
  order: string;
  person: number;
  steps: number;
  shift: number;
  cfg: number;
  poseStrength: number;
  livePreview: boolean;
}

const SHAPE: MotionShape = { fps: SCAIL_FPS, most: 321, least: 9 };

/** Who is matched with whom, as SCAIL2ColoredMask sorts them. */
const ORDERS: Record<string, string> = { "Left to right": "left_to_right", "Biggest first": "area", "As found": "none" };

/** The turbo LoRA at the strength ComfyUI's template gives it. */
const TURBO_STRENGTH = 0.8;

export const scailMotion = defineRecipe<ScailMotion>({
  id: "scail.motion",
  family: "scail",
  version: 1,
  title: "Motion transfer",
  summary: "A picture moved like a driving video: body, hands and mouth. The picture's room, light and people are kept; the motion is the video's.",
  output: "video",
  // a video of its own, made from a picture and another video: no join with the clips around it
  traits: { startFrame: false, endFrame: false, midFrames: false, continues: "clip", endAnchor: false, sound: true, fps: SCAIL_FPS, frameGrid: MOTION_GRID, windows: { most: SHAPE.most, least: SHAPE.least, carried: SCAIL_CARRIED } },
  inputs: [
    ...motionInputs(SHAPE),
    {
      id: "order", type: "choice", label: "Who moves like whom", options: Object.keys(ORDERS), default: "Left to right",
      note: "SAM 3 finds the people in the picture and in the video; they are paired in this order (the first in the picture moves like the first in the video)",
    },
    {
      id: "person", type: "number", label: "Only person", min: 0, max: 8, step: 1, default: 0, advanced: true,
      note: "0: everyone found is moved. 1, 2…: only that one, in the order above",
    },
    { id: "steps", type: "number", label: "Steps", min: 2, max: 40, step: 1, default: 6, advanced: true, perModel: true, note: "6 with the lightx2v LoRA, as ComfyUI's template. 20 full steps were slower and no better on the tests" },
    { id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true, note: "1 with the lightx2v LoRA. Above 1 every step takes twice as long" },
    { id: "shift", type: "number", label: "Shift", min: 0, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
    { id: "poseStrength", type: "number", label: "Pose strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "how hard the driving video's pose is held to" },
    {
      id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
      note: "while it renders, a short clip of what is forming, each step. Without it the preview is one still frame. A small cost per step. Needs the KJNodes pack",
    },
    previousInput(SCAIL_FPS, SCAIL_CARRIED),
    ...motionOutInputs(SCAIL_FPS),
  ],
  needs: ["dpo", "turbo", "clipVision", "sam"],
  nodes: (input) => [
    ...MOTION_NODES, "UNETLoader", "LoraLoaderModelOnly", "CLIPLoader", "VAELoader", "CLIPTextEncode", "CLIPVisionLoader", "CLIPVisionEncode",
    "CheckpointLoaderSimple", "SAM3_VideoTrack", "SCAIL2ColoredMask", "WanSCAILToVideo", "ModelSamplingSD3", "KSamplerSelect", "BasicScheduler", "SamplerCustom", "VAEDecode",
    ...(input.drivingSeconds * SCAIL_FPS > SCAIL_CHUNK ? ["ImageFromBatch", "ImageBatch"] : input.previous ? ["ImageFromBatch"] : []),
  ],
  optionalNodes: [...MOTION_OPTIONAL, VHS, ...CORE_VIDEO_OUT, "ModelPreviewOverrideKJ"],

  build(input, ctx) {
    if (!input.picture || !ctx.uploads.picture) throw new Error("Motion transfer needs a picture: what moves.");
    if (!input.driving || !ctx.uploads.driving) throw new Error("Motion transfer needs a driving video: how it moves.");
    const { slots } = ctx;
    for (const [slot, file] of [["unet", "wan2.1_14B_SCAIL_2_int8_convrot.safetensors"], ["clip", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"], ["vae", "wan_2.1_vae.safetensors"]] as const) {
      if (!slots[slot]) throw new Error(`SCAIL-2 needs ${file} (Settings › Models has it).`);
    }
    const frame = motionCanvas(input, ctx, 32);
    const total = motionFrames(input, ctx, SHAPE);
    const g = new GraphBuilder();
    const { frames: pose, parts } = drivingFrames(g, ctx, frame);
    const picture = g.out("LoadImage", { image: ctx.uploads.picture });

    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "wan", device: "default" });
    const vae = g.out("VAELoader", { vae_name: slots.vae });
    const positive = g.out("CLIPTextEncode", { clip, text: input.prompt.trim() });
    const negative = g.out("CLIPTextEncode", { clip, text: "" });
    const vision = g.out("CLIPVisionEncode", { clip_vision: g.out("CLIPVisionLoader", { clip_name: slots.clipVision }), image: picture, crop: "none" });

    // who is who: SAM 3 finds the people in the video and in the picture, and the mask colours pair them in order
    const sam = g.add("CheckpointLoaderSimple", { ckpt_name: slots.sam });
    const people = g.out("CLIPTextEncode", { clip: [sam, 1], text: "person" });
    const track = (images: Ref) => g.out("SAM3_VideoTrack", { images, model: [sam, 0], detection_threshold: 0.5, max_objects: 4, detect_interval: 1, conditioning: people });
    const masks = g.add("SCAIL2ColoredMask", {
      driving_track_data: track(pose), ref_track_data: track(picture),
      object_indices: input.person > 0 ? String(input.person - 1) : "", sort_by: ORDERS[input.order] ?? "left_to_right", replacement_mode: false,
    });

    // as the template: the DPO LoRA, then lightx2v; the scheduler reads the model before the shift, the sampler after it
    let model = g.out("UNETLoader", { unet_name: slots.unet, weight_dtype: "default" });
    if (slots.dpo) model = g.out("LoraLoaderModelOnly", { model, lora_name: slots.dpo, strength_model: 1 });
    if (slots.turbo) model = g.out("LoraLoaderModelOnly", { model, lora_name: slots.turbo, strength_model: TURBO_STRENGTH });
    model = applyLoras(g, model, input.loras);
    const shifted = livePreview(g, ctx, g.out("ModelSamplingSD3", { model, shift: input.shift }), input.livePreview);
    const sigmas = g.out("BasicScheduler", { model, scheduler: "simple", steps: input.steps, denoise: 1 });
    const sampler = g.out("KSamplerSelect", { sampler_name: "euler" });

    const lengths = chunkLengths(total, SCAIL_CHUNK, SCAIL_CARRIED);
    let made: Ref | null = null;
    // the clip before, when there is one, anchors the first chunk as a chunk before it would: its frames dropped, its colours held
    let previous: Ref | null = previousFrames(g, ctx);
    let offset: Ref | number = 0;
    const passes: Array<{ node: string; steps: number }> = [];
    lengths.forEach((length, i) => {
      g.phase("sampling");
      const cond = g.add("WanSCAILToVideo", {
        positive, negative, vae, width: frame.width, height: frame.height, length, batch_size: 1,
        pose_strength: input.poseStrength, pose_start: 0, pose_end: 1, video_frame_offset: offset, previous_frame_count: SCAIL_CARRIED,
        pose_video: pose, pose_video_mask: [masks, 0], replacement_mode: false, reference_image: picture, reference_image_mask: [masks, 1], clip_vision_output: vision,
        ...(previous ? { previous_frames: previous } : {}),
      });
      const sampled = g.add("SamplerCustom", {
        model: shifted, add_noise: true, noise_seed: ctx.seed + i, cfg: input.cfg, positive: [cond, 0], negative: [cond, 1], sampler, sigmas, latent_image: [cond, 2],
      });
      passes.push({ node: sampled, steps: input.steps });
      g.phase("decoding");
      const decoded = g.out("VAEDecode", { samples: [sampled, 1], vae });
      let fresh = decoded;
      if (previous) {
        // its first frames are the ones carried over: dropped, and its colours held to where the chunk before ended
        fresh = g.out("ImageFromBatch", { image: decoded, batch_index: SCAIL_CARRIED, length: 4096 });
        if (ctx.has("ColorTransfer")) {
          fresh = g.out("ColorTransfer", { image_target: fresh, image_ref: g.out("ImageFromBatch", { image: previous, batch_index: -1, length: 1 }), method: "reinhard_lab", source_stats: "per_frame", strength: 1 });
        }
      }
      made = made ? g.out("ImageBatch", { image1: made, image2: fresh }) : fresh;
      previous = decoded;
      offset = [cond, 3];
    });

    const images = matchedToDriving(g, ctx, made!, pose, input, frame);
    const saved = motionSaved(g, ctx, images, input, { frame, fps: SCAIL_FPS, frames: total, parts, carried: SCAIL_CARRIED });
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: saved.out, kind: "video", role: "result" }],
      totalSteps: input.steps * lengths.length,
      passes,
      loads: [
        ...saved.loads, `diffusion_models/${slots.unet}`, `text_encoders/${slots.clip}`, `vae/${slots.vae}`, `clip_vision/${slots.clipVision}`, `checkpoints/${slots.sam}`,
        ...(slots.dpo ? [`loras/${slots.dpo}`] : []), ...(slots.turbo ? [`loras/${slots.turbo}`] : []), ...loraLoads(input.loras),
      ],
    };
  },

  variants: ((): Variant<ScailMotion>[] => {
    const slots = {
      tinyVae: "taew2_1.safetensors", unet: "wan2.1_14B_SCAIL_2_int8_convrot.safetensors", dpo: "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", turbo: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
      clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", vae: "wan_2.1_vae.safetensors", clipVision: "clip_vision_h.safetensors", sam: "sam3.1_multiplex_fp16.safetensors", rife: "rife49.pth",
    };
    const picture = { width: 768, height: 1360 };
    const part = (seconds: number) => ({ width: 480, height: 854, frames: Math.round(seconds * SCAIL_FPS), fps: SCAIL_FPS, hasSound: true });
    return [
      {
        name: "one chunk, matched to the driving video, its sound kept",
        input: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 5, prompt: "A man raps to the camera." },
        slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture, driving: part(5) },
      },
      {
        name: "ten seconds in two chunks, one person, biggest first, no match, no RIFE",
        input: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 10, order: "Biggest first", person: 1, matchDriving: false, smooth: false, keepSound: false, loras: [{ file: "l.safetensors", weight: 0.7 }] },
        slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture, driving: part(10) },
      },
      {
        name: "carrying on from the clip before",
        input: { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" }, drivingSeconds: 5 },
        slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4" }, media: { picture, driving: part(5), previous: { width: 480, height: 854, frames: 5, fps: SCAIL_FPS } },
      },
    ];
  })(),
});
