import { FACE_NODE, faceScore } from "../shared/face";
import { defineRecipe, GraphBuilder, type FrameGrid, type Ref, type Variant } from "@afflatus/core";
import { SCAIL_CARRIED, SCAIL_CHUNK, SCAIL_FPS, SCAIL_H3_GRID } from "./family";
import { applyLoras, livePreview, loraLoads } from "../shared/model";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { rifeNeeds, rifeSkippedSaid } from "../shared/finish";
import {
  chunkLengths, drivingFrames, previousFrames, previousInput, matchedToDriving, motionBatchNodes, MOTION_GRID, MOTION_NODES, MOTION_OPTIONAL, motionOutInputs, motionCanvas, motionFrames, motionInputs,
  motionSaved, motionSound, type MotionShape, type MotionValues,
} from "../motion/driving";
import { FACE_REFINE_OPTIONAL, FACE_REFINE_OTHER_INPUTS, FACE_REFINE_OWN_SLOTS, FACE_REFINE_SLOTS, faceRefined, faceRefineNeeds, faceRefineSkipped } from "../h3/faceRefine";

/**
 * SCAIL-2 · Motion transfer: the picture's people moved like the driving video's. As ComfyUI's SCAIL-2 template runs it in
 * its Animation mode (the mode the meme test used, 2026-10-14): SAM 3 finds the people in both and colours who is who, the
 * driving video's pose and those colours condition the model, the picture is its reference. A part longer than one chunk
 * (81 frames, 5.1 s) is made in chunks inside the job, each anchored on the last 5 frames of the one before and its
 * colours matched to that one's last frame, as the template's Extend does.
 */
export interface ScailMotion extends MotionValues {
  order: string;
  person: string;
  steps: number;
  shift: number;
  cfg: number;
  poseStrength: number;
  dpoStrength: number;
  livePreview: boolean;
  /** At 24 fps only: H3's Face refine on SCAIL's own frames. */
  faceRefine?: boolean;
  faceRefineDenoise?: number;
  faceRefineSteps?: number;
}

/**
 * The H3 nodes Face refine runs on SCAIL beside SCAIL's own (its text encoder, VAEs, loader and scheduler are SCAIL's node
 * types too); its pack's nodes and the audio lock stay optional, done without when missing.
 */
const FACE_REFINE_H3 = ["MiniMaxH3ReferenceToVideo", "MiniMaxH3SigmaShift", "ModelAttentionBackend", "SamplerCustomAdvanced", "RandomNoise", "BasicGuider"];


/** Who is matched with whom, as SCAIL2ColoredMask sorts them. */
const ORDERS: Record<string, string> = { "Left to right": "left_to_right", "Biggest first": "area", "As found": "none" };

/** The turbo LoRA at the strength ComfyUI's template gives it. */
const TURBO_STRENGTH = 0.8;

/**
 * SCAIL-2's Motion transfer at a frame rate: its own 16 (on Wan's 4k + 1 frames), or 24 on the counts H3's grid shares with
 * Wan's (17k + 5 and 4k + 1: 73, 141, 209, 277 frames), so that its clips meet H3's in time and H3's Face refine can run on its
 * own frames (card #36). The rate is the recipe's, not a form choice: the driving video and the clip before are cut at it, and
 * the timeline reads it from the traits.
 */
function scailAt(o: { id: string; title: string; fps: number; grid: FrameGrid; most: number; least: number; seconds?: number; hidden?: true; faceRefine?: true }) {
  const fps = o.fps;
  const shape: MotionShape = { fps, most: o.most, least: o.least, grid: o.grid, ...(o.seconds ? { seconds: o.seconds } : {}) };
  return defineRecipe<ScailMotion>({
    id: o.id,
    family: "scail",
    version: 1,
    title: o.title,
    ...(o.hidden ? { hidden: true as const } : {}),
    summary: "A picture moved like a driving video: body, hands and mouth. The picture's room, light and people are kept; the motion is the video's.",
    output: "video",
    // made from a picture and another video; on a timeline, a window of a long source carrying on from the window before (its last frames)
    // on H3's grid, H3's Face refine runs on its own frames: a finish of a take redraws the take's frames (it keeps no latent)
    traits: { startFrame: false, endFrame: false, midFrames: false, continues: "clip", endAnchor: false, sound: true, fps, frameGrid: o.grid, windows: { most: shape.most, least: shape.least, carried: SCAIL_CARRIED }, ...(o.faceRefine ? { faceRefine: "faceRefine" } : {}) },
    inputs: [
      ...motionInputs(shape),
      {
        id: "order", type: "choice", label: "Who moves like whom", options: Object.keys(ORDERS), default: "Left to right",
        note: "SAM 3 finds the people in the picture and in the video; they are paired in this order (the first in the picture moves like the first in the video)",
      },
      {
        // SAM 3 tracks up to 4 people (max_objects); drafts saved when this was a number keep their choice
        id: "person", type: "choice", label: "Who is moved", options: ["Everyone", "1", "2", "3", "4"], renamed: { "0": "Everyone", "1": "1", "2": "2", "3": "3", "4": "4" }, default: "Everyone", advanced: true,
        note: "everyone SAM 3 finds, or only one of them: 1 is the first in the order above",
      },
      { id: "steps", type: "number", label: "Steps", min: 2, max: 40, step: 1, default: 6, advanced: true, perModel: true, note: "6 with the lightx2v LoRA, as ComfyUI's template. its full-model setting is 40 steps at CFG 5; 20 full steps were slower and no better on the tests" },
      { id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true, note: "1 with the lightx2v LoRA. Above 1 every step takes twice as long" },
      { id: "shift", type: "number", label: "Shift", min: 0, max: 20, step: 0.5, default: 8, advanced: true, perModel: true, note: "8, SCAIL-2's own" },
      { id: "poseStrength", type: "number", label: "Pose strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, note: "how hard the driving video's pose is held to" },
      {
        id: "dpoStrength", type: "number", label: "DPO LoRA strength", min: 0, max: 2, step: 0.05, default: 1, advanced: true, perModel: true,
        note: "SCAIL-2's own DPO LoRA (hands, lips and eyes), 1 as its template. Its authors say to lower it when the driving video's face shows through the picture's person",
      },
      {
        id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
        note: "while it renders, a short clip of what is forming, each step. Without it the preview is one still frame. A small cost per step. Needs the KJNodes pack",
      },
      previousInput(fps, SCAIL_CARRIED),
      ...motionOutInputs(fps),
      ...(o.faceRefine ? FACE_REFINE_OTHER_INPUTS : []),
    ],
    needs: ["dpo", "turbo", "clipVision", "sam"],
    // RIFE with "RIFE ×2" on, Face refine's files (H3's, its text encoder and VAEs too) with it on
    needsWith: (input) => [...rifeNeeds(input.smooth), ...(o.faceRefine ? faceRefineNeeds(input, { own: true }) : [])],
    nodes: (input) => [
      ...MOTION_NODES, "UNETLoader", "LoraLoaderModelOnly", "CLIPLoader", "VAELoader", "CLIPTextEncode", "CLIPVisionLoader", "CLIPVisionEncode",
      "CheckpointLoaderSimple", "SAM3_VideoTrack", "SCAIL2ColoredMask", "WanSCAILToVideo", "ModelSamplingSD3", "KSamplerSelect", "BasicScheduler", "SamplerCustom", "VAEDecode",
      ...(motionFrames(input, { media: {} }, shape) > SCAIL_CHUNK ? ["ImageFromBatch", "ImageBatch"] : input.previous ? ["ImageFromBatch", "ImageBatch"] : []), ...motionBatchNodes(input),
      // Face refine: H3's nodes, and a window carrying on (its frames off H3's grid by the ones it dropped) made up to it and cut back
      ...(o.faceRefine && input.faceRefine ? [...FACE_REFINE_H3, ...(input.previous ? ["ImageFromBatch", "ImageBatch", "RepeatImageBatch"] : [])] : []),
    ],
    optionalNodes: [...MOTION_OPTIONAL, VHS, ...CORE_VIDEO_OUT, "ModelPreviewOverrideKJ", FACE_NODE, ...(o.faceRefine ? FACE_REFINE_OPTIONAL : [])],

    build(input, ctx) {
      if (!input.picture || !ctx.uploads.picture) throw new Error("Motion transfer needs a picture: what moves.");
      if (!input.driving || !ctx.uploads.driving) throw new Error("Motion transfer needs a driving video: how it moves.");
      const { slots } = ctx;
      for (const [slot, file] of [["unet", "wan2.1_14B_SCAIL_2_int8_convrot.safetensors"], ["clip", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"], ["vae", "wan_2.1_vae.safetensors"]] as const) {
        if (!slots[slot]) throw new Error(`SCAIL-2 needs ${file} (Settings › Models has it).`);
      }
      const frame = motionCanvas(input, ctx, 32);
      const total = motionFrames(input, ctx, shape);
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
        object_indices: input.person === "Everyone" ? "" : String(Number(input.person) - 1), sort_by: ORDERS[input.order] ?? "left_to_right", replacement_mode: false,
      });

      // as the template: the DPO LoRA, then lightx2v. The scheduler reads the shifted model: reading the one before it (as the
      // template), the sigmas took the model's own shift (8) and the form's Shift did nothing; its default is that 8
      let model = g.out("UNETLoader", { unet_name: slots.unet, weight_dtype: "default" });
      if (slots.dpo && input.dpoStrength !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: slots.dpo, strength_model: input.dpoStrength });
      if (slots.turbo) model = g.out("LoraLoaderModelOnly", { model, lora_name: slots.turbo, strength_model: TURBO_STRENGTH });
      model = applyLoras(g, model, input.loras);
      const sampling = g.out("ModelSamplingSD3", { model, shift: input.shift });
      const shifted = livePreview(g, ctx, sampling, input.livePreview);
      const sigmas = g.out("BasicScheduler", { model: sampling, scheduler: "simple", steps: input.steps, denoise: 1 });
      const sampler = g.out("KSamplerSelect", { sampler_name: "euler" });

      const lengths = chunkLengths(total, SCAIL_CHUNK, SCAIL_CARRIED);
      let made: Ref | null = null;
      // the clip before, when there is one, anchors the first chunk as a chunk before it would: its frames dropped, its colours held
      let previous: Ref | null = previousFrames(g, ctx);
      let offset: Ref | number = 0;
      // a window that carries on: the clip before's last moments as this one made them again (its first chunk's carried frames),
      // kept in front of its own, hidden: the join fades over them with both clips moving (motionSaved's head)
      let head: Ref | null = null;
      const passes: Array<{ node: string; steps: number; frames: number }> = [];
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
        passes.push({ node: sampled, steps: input.steps, frames: length });
        g.phase("decoding");
        const decoded = g.out("VAEDecode", { samples: [sampled, 1], vae });
        let fresh = decoded;
        const held = Boolean(previous) && ctx.has("ColorTransfer");
        if (previous) {
          // its first frames are the ones carried over: dropped, and its colours held to where the chunk before ended
          const last = held ? g.out("ImageFromBatch", { image: previous, batch_index: -1, length: 1 }) : null;
          const hold = (x: Ref) => (last ? g.out("ColorTransfer", { image_target: x, image_ref: last, method: "reinhard_lab", source_stats: "per_frame", strength: 1 }) : x);
          fresh = hold(g.out("ImageFromBatch", { image: decoded, batch_index: SCAIL_CARRIED, length: 4096 }));
          if (i === 0 && ctx.uploads.previous) head = hold(g.out("ImageFromBatch", { image: decoded, batch_index: 0, length: SCAIL_CARRIED }));
        }
        made = made ? g.out("ImageBatch", { image1: made, image2: fresh }) : fresh;
        // the chunk after anchors on this one as it is kept: its colours held, once they were (as the template's Extend hands on
        // ColorTransfer's frames); from the third chunk on, each was held to the chunk before's raw frames, not its held ones
        previous = held ? fresh : decoded;
        offset = [cond, 3];
      });

      // Face refine (24 fps): H3's pass on SCAIL's own frames, before anything else is done to them, so that the clip, its raw
      // frames and the window after (which carries on from them) all have the refined faces. Its person is the Picture's
      // (read only where the form has them: the 16 fps form has no Face refine)
      const refineValues = o.faceRefine && input.faceRefine
        ? { faceRefine: true, faceRefineDenoise: input.faceRefineDenoise ?? 0.35, faceRefineSteps: input.faceRefineSteps ?? 4, references: [], subject: "", quick: true }
        : { faceRefine: false, faceRefineDenoise: 0, faceRefineSteps: 0, references: [], subject: "", quick: true };
      // the sound its pass holds, on its own frames (the file's, motionSaved's, may start half a frame earlier)
      const sound = refineValues.faceRefine ? motionSound(g, ctx, input, { fps, frames: total, parts, carried: SCAIL_CARRIED }) : undefined;
      const faces = faceRefined(g, ctx, refineValues, made!, { audio: sound, picture: ctx.uploads.picture, frames: total - (ctx.uploads.previous ? SCAIL_CARRIED : 0) });
      const withHead = head ? g.out("ImageBatch", { image1: head, image2: faces.images }) : faces.images;
      const images = matchedToDriving(g, ctx, withHead, pose, input, frame, fps);
      const saved = motionSaved(g, ctx, images, input, { frame, fps, frames: total, parts, carried: SCAIL_CARRIED, ...(head ? { head: SCAIL_CARRIED } : {}), made: faces.images, ...(sound ? { sound } : {}) });
      const said = [rifeSkippedSaid(input.smooth, ctx), faceRefineSkipped(refineValues, ctx, { picture: ctx.uploads.picture, own: true, audio: Boolean(sound) })].filter((x): x is string => Boolean(x));
      if (faces.pass) passes.push({ ...faces.pass, frames: total });
      return {
        ...(said.length ? { warnings: said } : {}),
        graph: g.graph,
        phases: g.phases,
        outputs: [
          { node: saved.out, kind: "video", role: "result" },
          ...(saved.raw ? [{ node: saved.raw, kind: "video" as const, role: "raw" as const }] : []),
          // the face along the clip against the Picture's: a window whose person drifted is flagged on the timeline
          ...faceScore(g, ctx, images, [picture]),
        ],
        totalSteps: input.steps * lengths.length + (faces.pass?.steps ?? 0),
        // the frames a step samples (its largest chunk: the steps are counted per chunk above), said: read off its nodes, the
        // "rest of the batch" of ImageFromBatch (length 4096) was counted, and a timeline's windows were recorded with 30 to 50
        // times their work (forecasts of 375 and 533 min for 4 min); the whole part, with the chunks' steps, was 4 times over
        frames: Math.max(...lengths),
        passes,
        // its head, hidden on a timeline: the join fades over it with both clips moving
        ...(saved.headMs ? { overlap: { headMs: saved.headMs, tailMs: 0, moving: true } } : {}),
        loads: [
          ...saved.loads, `diffusion_models/${slots.unet}`, `text_encoders/${slots.clip}`, `vae/${slots.vae}`, `clip_vision/${slots.clipVision}`, `checkpoints/${slots.sam}`,
          ...(slots.dpo ? [`loras/${slots.dpo}`] : []), ...(slots.turbo ? [`loras/${slots.turbo}`] : []), ...loraLoads(input.loras), ...faces.loads,
        ],
      };
    },

    variants: ((): Variant<ScailMotion>[] => {
      const slots = {
        tinyVae: "taew2_1.safetensors", unet: "wan2.1_14B_SCAIL_2_int8_convrot.safetensors", dpo: "wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", turbo: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
        clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", vae: "wan_2.1_vae.safetensors", clipVision: "clip_vision_h.safetensors", sam: "sam3.1_multiplex_fp16.safetensors", rife: "rife49.pth",
      };
      const picture = { width: 768, height: 1360 };
      const part = (seconds: number) => ({ width: 480, height: 854, frames: Math.round(seconds * fps), fps, hasSound: true });
      return [
        {
          name: "one chunk, matched to the driving video, its sound kept",
          input: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 5, prompt: "A man raps to the camera." },
          slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture, driving: part(5) },
        },
        {
          name: "ten seconds in two chunks, one person, biggest first, no match, no RIFE",
          input: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 10, order: "Biggest first", person: "1", matchDriving: false, smooth: false, keepSound: false, loras: [{ file: "l.safetensors", weight: 0.7 }] },
          slots, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture, driving: part(10) },
        },
        ...(o.faceRefine ? [
          {
            name: "Face refine on SCAIL's own frames, towards the Picture, the driving video's sound held",
            input: { picture: "p1", driving: { asset: "v1" }, drivingSeconds: 141 / fps, faceRefine: true },
            slots: { ...slots, ...FACE_REFINE_SLOTS, ...FACE_REFINE_OWN_SLOTS }, uploads: { picture: "p.png", driving: "d.mp4" }, media: { picture, driving: part(141 / fps) },
          },
          {
            name: "Face refine on a window carrying on, its frames made up to H3's grid, no sound kept",
            input: { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" }, drivingSeconds: 141 / fps, keepSound: false, faceRefine: true },
            slots: { ...slots, ...FACE_REFINE_SLOTS, ...FACE_REFINE_OWN_SLOTS }, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4", "previous.look": "prev.png" },
            media: { picture, driving: part(141 / fps), previous: { width: 480, height: 854, frames: 5, fps } },
          },
        ] : []),
        {
          name: "carrying on from the clip before",
          input: { picture: "p1", driving: { asset: "v1" }, previous: { asset: "v0" }, drivingSeconds: 5 },
          slots, uploads: { picture: "p.png", driving: "d.mp4", previous: "prev.mp4", "previous.look": "prev.png" }, media: { picture, driving: part(5), previous: { width: 480, height: 854, frames: 5, fps } },
        },
      ];
    })(),
  });
}

/** SCAIL-2 · Motion transfer as it is offered: 16 fps, its chunks of 81 frames (5.1 s), at most 321 frames (20 s) a job. */
export const scailMotion = scailAt({ id: "scail.motion", title: "Motion transfer", fps: SCAIL_FPS, grid: MOTION_GRID, most: 321, least: 9 });

/**
 * The same at 24 fps on H3's grid, offered beside it, not in its place (the owner, 2026-10-21: the test held, but one of
 * its renders came out oddly, so 16 stays the default): 73 to 277 frames (3 to 11.5 s) a job, 141 (5.9 s, H3's longest) to
 * start on, its 81-frame chunks then 3.4 s each.
 */
export const scailMotion24 = scailAt({ id: "scail.motion24", title: "Motion transfer (24 fps)", fps: 24, grid: SCAIL_H3_GRID, most: 277, least: 73, seconds: 141 / 24, faceRefine: true });
