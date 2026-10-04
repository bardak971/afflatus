import { defineRecipe, GraphBuilder, REFERENCE_ROLES, type ClipValue, type LoraValue, type MediaFacts, type Ref, type ReferenceValue, type SizeValue, type Variant } from "@afflatus/core";
import { H3_FORM_PIXELS, H3_FPS, H3_MAX_FRAMES, h3Canvas, h3Frames } from "./family";
import { pixelUpscale, UPSCALE, upscaleInputs, upscaleNodes } from "../video/upscale";
import { h3Prompt, h3ReferencePrompt, type H3Mode } from "./prompt";

/** The sampler left to the recipe: the one that suits the steps (euler for a turbo's few, res_multistep otherwise). */
const AUTO_SAMPLER = "Auto";

export interface H3Video {
  model?: string;
  turboIn: string;
  hybrid: string;
  description: string;
  soundscape: string;
  music: string;
  start?: string;
  end?: string;
  mid?: string;
  midAt: number;
  previous?: ClipValue;
  next?: ClipValue;
  references: ReferenceValue[];
  refVideos: ReferenceValue[];
  voice?: string;
  voiceStart: number;
  voiceSeconds: number;
  subject: string;
  sharpRefs: boolean;
  seconds: number;
  shape: SizeValue;
  short: number;
  fast: boolean;
  turboSteps: number;
  steps: number;
  sampler: string;
  scheduler: string;
  shiftVideo: number;
  shiftAudio: number;
  smooth: boolean;
  quick: boolean;
  cache: boolean;
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleDenoise: number;
  upscaleSteps: number;
  upscaleTile: number;
  upscaleOverlap: number;
  upscaleChunk: number;
  upscaleWith: string;
  cacheThreshold: number;
  cacheStart: number;
  cacheEnd: number;
  cacheSteps: number;
  crf: number;
  livePreview: boolean;
  loras: LoraValue[];
  seed: number;
}

/**
 * How much of a neighbouring clip is handed over at a join: 22 frames (almost a second) carry the motion
 * and the voices over, not just the pose. A clip too short for that gives 5. The model takes guide clips
 * of 17k + 5 frames only.
 */
export const H3_JOIN_FRAMES = [22, 5];
/** How many frames of the next clip a join can land on: a position only (5), the motion too (22), a long run-in (39). Guide clips are 17k + 5 frames. */
export const H3_LANDINGS = ["5", "22", "39"] as const;
/** How many reference pictures the reference model is given at most (it takes 9; the opening picture is one of them). */
export const H3_REFERENCES = 6;
/** How many reference videos it takes. */
export const H3_REFERENCE_VIDEOS = 3;

const guideFrames = (m: MediaFacts | undefined) => {
  const n = m?.frames ?? 0;
  if (n % 17 !== 5 || n > 39) throw new Error(`a join takes 5, 22 or 39 frames of the other clip, not ${n}`);
  return n;
};

/** What a model other than the usual one is, as far as its file name says: fine-tunes are named for it ("…HybridTurboV3"). */
const namedFor = { turbo: /turbo|distill|lightning|(^|[^a-z0-9])\d+[ _-]?steps?/i, hybrid: /hybrid/i };

/**
 * The model the clip is made with, and what it is. The usual files are MiniMax's own: one model for
 * first and last frames, another for references, and a turbo LoRA for few steps. A fine-tune can be all
 * of that in one file: a hybrid follows references itself, a turbo (distilled) one needs no LoRA.
 */
const modelOf = (input: H3Video, slots: Record<string, string>) => {
  // the usual file can itself be a fine-tune, where MiniMax's own is not installed: what a file is is read from its name either way
  const file = input.model ?? slots.unet;
  const name = file?.split(/[\\/]/).pop() ?? "";
  const is = (said: string, named: RegExp) => said === "Yes" || (said !== "No" && named.test(name));
  return { file, turbo: is(input.turboIn, namedFor.turbo), hybrid: is(input.hybrid, namedFor.hybrid) };
};

/**
 * Which way the clip is made. With reference pictures or a voice, the reference model is used: the
 * pictures say who and what is in the clip without being frames of it, and the voice is the one the
 * person speaks with. Otherwise the pictures are the clip's first and last frame.
 */
const uses = (input: H3Video) => {
  const reference = input.references.length > 0 || input.refVideos.length > 0 || Boolean(input.voice);
  return {
    reference,
    start: Boolean(input.start && !input.previous),
    // a clip to arrive at says more than a picture: with both, the clip is followed. The reference model has no last frame.
    end: Boolean(input.end && !input.next && !reference),
  };
};

export const h3Video = defineRecipe<H3Video>({
  id: "h3.video",
  family: "h3",
  version: 2,
  title: "Video with audio",
  summary: "t2v, or i2v from a first and last frame, with reference images, or extending a previous clip. Audio included.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: true, sound: true,
    fps: H3_FPS, frameGrid: { step: 17, offset: 5 },
  },
  inputs: [
    {
      id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["minimax.?h3", "(^|[^a-z0-9])h3([^a-z0-9]|$)"],
      note: "MiniMax's own, or a fine-tune of it",
    },
    {
      id: "description", type: "prompt", weights: false, label: "Prompt", style: "sentences",
      placeholder: "She walks to the railing and looks out at the sea. The camera follows her slowly. (S1) says <d>[English] What a view.</d> softly.",
    },
    { id: "soundscape", type: "prompt", weights: false, label: "Sound effects", style: "sentences", optional: true, placeholder: "waves, a light wind, seagulls far away" },
    { id: "music", type: "prompt", weights: false, label: "Music", style: "sentences", optional: true, placeholder: "none" },
    { id: "start", type: "image", role: "start", label: "First frame", note: "the first frame", optional: true },
    { id: "end", type: "image", role: "end", label: "Last frame", note: "the last frame", optional: true },
    { id: "mid", type: "image", role: "mid", at: "midAt", label: "Keyframe", optional: true, advanced: true },
    { id: "midAt", type: "number", label: "Keyframe at", min: 0.5, max: 14.5, step: 0.5, default: 2.5, unit: " s", showWhen: "mid", advanced: true },
    {
      id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: H3_JOIN_FRAMES, fps: H3_FPS,
      note: "the motion and the voices of that clip continue into this one",
    },
    {
      id: "next", type: "clip", role: "next", label: "Next clip", optional: true, frames: H3_JOIN_FRAMES, framesFrom: "landing", fps: H3_FPS, advanced: true,
      note: "this clip ends exactly where that one begins",
    },
    {
      id: "landing", type: "choice", label: "Landing", options: [...H3_LANDINGS], default: "22", showWhen: "next", advanced: true,
      note: "frames of the next clip the join lands on: 5 is a position, 22 brings its motion too, 39 a long run-in (a short next clip gives fewer)",
    },
    {
      id: "references", type: "references", label: "Reference images", max: H3_REFERENCES, roles: [...REFERENCE_ROLES],
      note: "pictures of a person, a place, clothes, an object or a look: they are followed, they are not frames of the clip",
    },
    {
      id: "refVideos", type: "references", media: "video", label: "Reference videos", max: H3_REFERENCE_VIDEOS, roles: ["person"],
      note: "short videos of the person: how they look, move and sound. The first 3 seconds of each are used; a video's own sound is taken as their voice unless a voice sample is given",
    },
    {
      id: "voice", type: "audio", role: "voice", label: "Voice sample", optional: true, window: { start: "voiceStart", seconds: "voiceSeconds" },
      note: "someone speaking: the person in the clip speaks with that voice. Only the part you set is used: 5 to 10 seconds of clean speech carry a voice best",
    },
    { id: "voiceStart", type: "number", label: "Voice sample: start", min: 0, max: 600, step: 0.5, default: 0, unit: " s", showWhen: "voice" },
    { id: "voiceSeconds", type: "number", label: "Voice sample: length", min: 2, max: 15, step: 0.5, default: 8, unit: " s", showWhen: "voice" },
    {
      id: "subject", type: "prompt", weights: false, label: "Subject description", style: "sentences", optional: true, showWhen: "references", holds: "subject",
      placeholder: "brown hair, green eyes, freckles", note: "in a few words, to help the pictures",
    },
    { id: "seconds", type: "number", label: "Duration", min: 4, max: 15, step: 0.5, default: 5, unit: " s", note: "the model is trained on 4 to 15 seconds. A clip that joins others is made longer by the frames it shares with them, within 15 seconds in all" },
    {
      id: "shape", type: "size", label: "Aspect ratio", default: "tall", grid: 32, min: 256, max: 1344, ratioOnly: true,
      short: "short", maxPixels: H3_FORM_PIXELS, decidedBy: ["start", "end", "previous", "next"], scaledBy: { on: "upscale", by: "upscaleBy" },
      note: "an opening picture or a clip it joins decides the shape instead",
      shapes: [
        { id: "tall", label: "Tall", width: 576, height: 1024 },
        { id: "square", label: "Square", width: 768, height: 768 },
        { id: "wide", label: "Wide", width: 1024, height: 576 },
      ],
    },
    {
      id: "short", type: "number", label: "Resolution", min: 384, max: 1088, step: 32, default: 576, unit: "p", picks: [480, 576, 768, 1088],
      note: "the short side of the frame. 576p is the usual one. Past 768p the model is beyond what it was trained for: slower, and it may drift",
    },
    ...upscaleInputs({ latent: true }),
    {
      id: "upscaleDenoise", type: "number", label: "Upscale denoise", min: 0.05, max: 0.6, step: 0.05, default: 0.3, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true,
      note: "denoising strength of the re-sampling: 0.2 keeps the clip as it is, 0.3 to 0.4 draws real detail into it, higher invents more. A plain resize of the latent (no H3 latent upscaler file) needs 0.3 or more, else it stays soft",
    },
    { id: "upscaleSteps", type: "number", label: "Upscale steps", min: 1, max: 6, step: 1, default: 3, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "steps of the re-sampling: 1 only sharpens, 3 to 4 add detail; each step is a pass over the whole clip" },
    {
      id: "upscaleWith", type: "choice", label: "Latent upscaler", options: ["Auto", "H3's latent upscaler", "Plain resize"], default: "Auto", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true,
      note: "H3's own 3D upscaler model when its file is found (Auto), else a bicubic resize of the latent, which is soft unless the re-sampling has steps and denoise to work with. The file is one click in Settings → Models, under MiniMax H3",
    },
    { id: "upscaleTile", type: "number", label: "Upscale tile size", min: 256, max: 1024, step: 32, default: 512, unit: " px", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "the frame is re-sampled one tile at a time: smaller tiles need less memory" },
    { id: "upscaleOverlap", type: "number", label: "Upscale tile overlap", min: 32, max: 256, step: 32, default: 128, unit: " px", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true },
    { id: "upscaleChunk", type: "number", label: "Upscale temporal chunk", min: 17, max: 255, step: 17, default: 85, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "the clip is re-sampled in stretches of this many frames, overlapping by 17" },
    { id: "fast", type: "toggle", label: "Turbo", note: "a few steps, about twice as fast, for drafts: with the turbo LoRA (one click in Settings → Models), or as it is with a turbo model. Without either, the full steps run", default: false, advanced: true, perModel: true },
    {
      id: "turboSteps", type: "number", label: "Turbo steps", min: 0, max: 16, step: 1, default: 0, showWhen: "fast", advanced: true, perModel: true,
      note: "0 reads it from the LoRA's name (8step, 4step), else 8. ComfyUI's own template runs the 8-step LoRA at 6",
    },
    { id: "steps", type: "number", label: "Steps", note: "20 is ComfyUI's own template; 15 is a little quicker, 25 a little finer", min: 4, max: 50, step: 1, default: 20, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true },
    {
      id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, extra: [AUTO_SAMPLER], default: AUTO_SAMPLER, advanced: true, perModel: true,
      note: "Auto: euler with Turbo, res_multistep without (ComfyUI's own template uses res_multistep for both)",
    },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "BasicScheduler", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
    {
      id: "shiftVideo", type: "number", label: "Shift (video)", min: 0, max: 30, step: 0.5, default: 0, advanced: true, perModel: true,
      note: "0 picks it: 11 at full steps, 12 with the 8-step turbo LoRA and 6 with a 4-step one (what they were trained at). Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail). The model's own, when no shift is set at all, is 12",
    },
    {
      id: "shiftAudio", type: "number", label: "Shift (sound)", min: 0, max: 30, step: 0.5, default: 0, advanced: true, perModel: true,
      note: "0 picks it: 4 at full steps, 3 with Turbo (the turbo LoRAs were trained at 3)",
    },
    {
      id: "turboIn", type: "choice", label: "Distilled model", options: ["Auto", "Yes", "No"], default: "Auto", advanced: true, perModel: true,
      note: "made for 4 to 8 steps: no turbo LoRA is added. Auto reads it from the file name",
    },
    {
      id: "hybrid", type: "choice", label: "Hybrid model", options: ["Auto", "Yes", "No"], default: "Auto", advanced: true, perModel: true,
      note: "it follows reference pictures and voices itself; otherwise those clips use MiniMax's reference model. Auto reads it from the file name",
    },
    { id: "smooth", type: "toggle", label: "Frame interpolation (RIFE ×2)", note: "frames interpolated with RIFE, from 24 to 48 a second", default: true, advanced: true },
    { id: "sharpRefs", type: "toggle", label: "Reference images at full resolution", note: "holds a face better, several times slower", default: false, advanced: true },
    { id: "cache", type: "toggle", label: "Step cache", note: "faster, softer: steps that barely change are skipped (MiniMaxH3Cache). Only without Turbo", default: false, showWhen: { input: "fast", in: [false] }, advanced: true },
    {
      id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
      note: "while it renders, a short clip of what is forming, each step, with its sound so far. A small cost per step. Needs the KJNodes pack",
    },
    {
      id: "quick", type: "toggle", label: "Comfy Kitchen attention", default: true, advanced: true,
      note: "a faster attention for INT8 models (ModelAttentionBackend), on Nvidia and AMD cards. Turn it off if renders fail on another machine",
    },
    { id: "cacheThreshold", type: "number", label: "Step cache threshold", note: "a step that would change the clip by less than this is skipped: higher skips more, faster and softer", min: 0.01, max: 0.5, step: 0.01, default: 0.05, showWhen: "cache", advanced: true },
    { id: "cacheStart", type: "number", label: "Step cache start", note: "where in the render skipping may begin: the first steps decide the clip and are never skipped below this", min: 0, max: 0.9, step: 0.05, default: 0.15, showWhen: "cache", advanced: true },
    { id: "cacheEnd", type: "number", label: "Step cache end", note: "where skipping stops, so that the last steps finish the detail", min: 0.1, max: 1, step: 0.05, default: 0.9, showWhen: "cache", advanced: true },
    { id: "cacheSteps", type: "number", label: "Step cache max skips", note: "how many steps may be skipped one after the other", min: 1, max: 6, step: 1, default: 2, showWhen: "cache", advanced: true },
    { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
    { id: "loras", type: "loras", label: "LoRAs", max: 6 },
    { id: "seed", type: "seed", label: "Seed" },
  ],

  nodes(input) {
    const how = uses(input);
    const routeNodes = upscaleNodes(input);
    const guided = Boolean(input.previous || input.next || input.mid) || (how.start && (input.references.length > 0 || input.refVideos.length > 0));
    const picked = modelOf(input, {});
    // a turbo model that makes the clip itself takes no turbo LoRA
    const turboLora = input.fast && !(picked.turbo && (!how.reference || picked.hybrid));
    return [
      ...routeNodes,
      "UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3SigmaShift", how.reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", "RandomNoise", "KSamplerSelect",
      "BasicScheduler", "BasicGuider", "SamplerCustomAdvanced", input.upscale === UPSCALE.latent ? "VAEDecodeTiled" : "VAEDecode", "VAEDecodeAudio", "VHS_VideoCombine",
      ...(input.quick ? ["ModelAttentionBackend"] : []),
      ...(turboLora || input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : []),
      ...(how.start || how.end || input.mid || input.references.length ? ["LoadImage"] : []),
      ...(input.voice ? ["LoadAudio"] : []),
      ...(input.previous || input.next || input.refVideos.length ? ["LoadVideo", "GetVideoComponents"] : []),
      ...(guided ? ["MiniMaxH3AddGuide"] : []),
    ];
  },
  optionalNodes: ["RebatchImages", 
    "MiniMaxH3Cache", "ModelPatchTorchSettings", "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ",
    "MMH3UltimateUpscale", "MMH3LatentUpscaleWithModelParams", "MMH3LatentUpscaleParams", "MMH3SpatialSplitParams", "MMH3TemporalSplitParams",
  ],

  build(input, ctx) {
    const { slots, uploads, media } = ctx;
    const how = uses(input);
    const picked = modelOf(input, slots);
    if (how.reference && !picked.hybrid && !slots.refUnet) {
      throw new Error("Reference pictures and voices need MiniMax H3's reference model (put minimax_h3_ref2va_*.safetensors in ComfyUI's models/diffusion_models folder) or a hybrid model picked under Model.");
    }
    const head = input.previous ? guideFrames(media.previous) : 0;
    const tail = input.next ? guideFrames(media.next) : 0;
    // the frames shared with a neighbour are that neighbour's: the clip is made that much longer, so its own
    // part keeps the length asked for, within the 362 frames (15 s) the model was trained up to
    const ownSeconds = Math.min(input.seconds, (H3_MAX_FRAMES - head - tail) / H3_FPS);
    const seconds = ownSeconds + (head + tail) / H3_FPS;
    const frames = h3Frames(seconds);

    // the frame: a timeline's canvas, else the clip it joins, else the picture it opens or ends on, else the shape picked
    const like = input.previous ? media.previous : input.next ? media.next : how.start ? media.start : how.end ? media.end : undefined;
    const { width, height } = ctx.canvas
      ? h3Canvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height))
      : like && (input.previous || input.next)
        ? h3Canvas(like.width, like.height, Math.min(like.width, like.height))
        : like
          ? h3Canvas(like.width, like.height, input.short, H3_FORM_PIXELS)
          : h3Canvas(input.shape.width, input.shape.height, input.short, H3_FORM_PIXELS);

    const g = new GraphBuilder();
    const audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
    const vae = g.out("VAELoader", { vae_name: slots.videoVae });
    // references: a hybrid model follows them itself, any other hands those clips to MiniMax's reference model
    const own = !how.reference || picked.hybrid;
    const unet = own ? picked.file : slots.refUnet;
    // the reference model has a turbo LoRA of its own when one is installed; without it the usual one is
    // used, as the DaSiWa H3 workflow does (one turbo LoRA after whichever model the clip needs)
    const turboFile = how.reference && !picked.hybrid ? slots.refTurbo ?? slots.turbo : slots.turbo;
    // a turbo model is made for few steps as it is: the LoRA on top of it would be the same thing twice
    const distilled = own ? picked.turbo : namedFor.turbo.test(unet?.split(/[\\/]/).pop() ?? "");
    const lora = input.fast && !distilled ? turboFile : undefined;
    const turbo = distilled || Boolean(lora);
    // how many steps a turbo render takes: typed, else what the LoRA (or a distilled model) is named for, else 8
    const namedSteps = /(\d+)[ _-]?step/i.exec((lora ?? (distilled ? unet : "") ?? "").split(/[\\/]/).pop() ?? "");
    const turboSteps = input.turboSteps > 0 ? input.turboSteps : namedSteps ? Number(namedSteps[1]) : 8;
    let model = g.out("UNETLoader", { unet_name: unet, weight_dtype: "default" });
    // the step cache is for full renders: with the turbo LoRA's 8 steps there is nothing to skip, and it hurts
    if (input.cache && !turbo && ctx.has("MiniMaxH3Cache")) {
      model = g.out("MiniMaxH3Cache", { model, reuse_threshold: input.cacheThreshold, start_percent: Math.min(input.cacheStart, input.cacheEnd), end_percent: input.cacheEnd, max_steps: input.cacheSteps, device: "auto", verbose: false });
    }
    if (input.quick) model = g.out("ModelAttentionBackend", { model, attention: "comfy kitchen attention" });
    if (ctx.has("ModelPatchTorchSettings")) model = g.out("ModelPatchTorchSettings", { model, enable_fp16_accumulation: true });
    if (lora) model = g.out("LoraLoaderModelOnly", { model, lora_name: lora, strength_model: 1 });
    for (const l of input.loras) {
      if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    }
    // the shifts typed in, else the ones that suit the steps: the turbo LoRAs were trained at 12/3 (8 steps) and 6/3 (4 steps)
    model = g.out("MiniMaxH3SigmaShift", { model, shift_video: input.shiftVideo > 0 ? input.shiftVideo : turbo ? (turboSteps <= 4 ? 6 : 12) : 11, shift_audio: input.shiftAudio > 0 ? input.shiftAudio : turbo ? 3 : 4 });
    // the live preview: each step, a few frames of the latent decoded small (with the tiny VAE when it is there)
    // and the sound so far, sent as a short clip to whoever queued the prompt: what ComfyUI itself shows
    if (input.livePreview && ctx.has("ModelPreviewOverrideKJ")) {
      model = g.out("ModelPreviewOverrideKJ", {
        model, max_resolution: 512, jpeg_quality: 75, suppress_default_preview: true, preview_frames: 16, preview_fps: 12,
        tiny_vae: slots.tinyVae ?? "none", audio_vae: audioVae,
      });
    }

    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "minimax", device: "default" });
    let start: string;
    let positive: Ref;
    if (how.reference) {
      // a voice with a picture to open on and nothing else: that picture is who speaks, not a frame
      const voiceOnly = input.references.length === 0 && input.refVideos.length === 0;
      // videos of the person: their frames, and their sound as the voice when no voice sample is given
      const videos = input.refVideos.map((_, i) => ({
        parts: g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: uploads[`refVideos.${i}`] }) }),
        sound: Boolean(media[`refVideos.${i}`]?.hasSound) && !input.voice,
      }));
      const pictures = voiceOnly ? (how.start ? [{ file: uploads.start, role: "person" }] : []) : input.references.map((r, i) => ({ file: uploads[`references.${i}`], role: r.role }));
      // with references, the clip can still open on its picture: it is given as one more picture and pinned at the first frame
      const opening = !voiceOnly && how.start;
      const files = [...pictures.map((p) => p.file), ...(opening ? [uploads.start] : [])];
      const prompt = h3ReferencePrompt(input, { roles: pictures.map((p) => p.role), videos: videos.map((v) => v.sound), voice: Boolean(input.voice), continues: Boolean(input.previous), opening, voiceOnly });
      start = g.add("MiniMaxH3ReferenceToVideo", {
        clip, vae, audio_vae: audioVae, prompt, width, height, length: frames, ref_image_size: input.sharpRefs ? "max" : "match",
        // inputs of a group that grows are named "<group>.<prefix><n>", counting from 0
        ...Object.fromEntries(files.map((file, i) => [`ref_images.ref_image_${i}`, g.out("LoadImage", { image: file })])),
        ...Object.fromEntries(videos.map((v, i) => [`ref_videos.ref_video_${i}`, [v.parts, 0]])),
        // the sound goes with the video of the same number
        ...Object.fromEntries(videos.flatMap((v, i) => (v.sound ? [[`ref_video_audios.ref_video_audio_${i}`, [v.parts, 1]]] : []))),
        ...(input.voice ? { "ref_audios.ref_audio_0": g.out("LoadAudio", { audio: uploads.voice }) } : {}),
      });
      positive = [start, 0];
      // one frame only: a longer still freezes the opening and the model then jumps to another scene
      if (opening) positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent: [start, 1], image: g.out("LoadImage", { image: uploads.start }), frame_idx: 0 });
    } else {
      const mode: H3Mode = how.start ? (how.end ? "both" : "start") : how.end ? "land" : "free";
      start = g.add("MiniMaxH3ImageToVideo", {
        clip, vae, prompt: h3Prompt(mode, seconds, input), width, height, length: frames,
        ...(how.start ? { first_frame: g.out("LoadImage", { image: uploads.start }) } : {}),
        ...(how.end ? { last_frame: g.out("LoadImage", { image: uploads.end }) } : {}),
      });
      positive = [start, 0];
    }
    const latent: Ref = [start, 1];
    // a join: the neighbour's frames and their sound are pinned in place, at the very start or the very end
    const pin = (file: string | undefined, facts: MediaFacts | undefined, at: number) => {
      const parts = g.add("GetVideoComponents", { video: g.out("LoadVideo", { file }) });
      positive = g.out("MiniMaxH3AddGuide", {
        positive, vae, audio_vae: audioVae, latent, image: [parts, 0], frame_idx: at,
        ...(facts?.hasSound === false ? {} : { audio: [parts, 1] }),
      });
    };
    if (input.previous) pin(uploads.previous, media.previous, 0);
    if (input.next) pin(uploads.next, media.next, -tail);
    // a picture the clip passes through: one frame pinned at its moment, counted after the frames shared with the clip before
    if (input.mid) {
      const at = Math.max(1, Math.min(frames - tail - 2, head + Math.round(Math.min(input.midAt, ownSeconds - 0.25) * H3_FPS)));
      positive = g.out("MiniMaxH3AddGuide", { positive, vae, audio_vae: audioVae, latent, image: g.out("LoadImage", { image: uploads.mid }), frame_idx: at });
    }

    // a turbo model with Fast off takes the steps typed (4 to 8 are what it is made for)
    const steps = lora || (distilled && input.fast) ? turboSteps : input.steps;
    g.phase("sampling");
    const sampled = g.add("SamplerCustomAdvanced", {
      noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
      guider: g.out("BasicGuider", { model, conditioning: positive }),
      sampler: g.out("KSamplerSelect", { sampler_name: input.sampler !== AUTO_SAMPLER ? input.sampler : turbo ? "euler" : "res_multistep" }),
      sigmas: g.out("BasicScheduler", { model, scheduler: input.scheduler, steps, denoise: 1 }),
      latent_image: latent,
    });

    // the upscale pass: the finished latent enlarged, then re-sampled lightly, one stretch of frames and one
    // tile at a time (the node offloads the model between the two, so both fit where one does). The sound
    // is carried through untouched. The same model, sampler and conditioning as the clip
    let finished: Ref = [sampled, 0];
    const upscaling = input.upscale === UPSCALE.latent && ctx.has("MMH3UltimateUpscale");
    if (upscaling) {
      const r32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);
      const big = { width: r32(width * input.upscaleBy), height: r32(height * input.upscaleBy) };
      const withModel = input.upscaleWith !== "Plain resize" && Boolean(slots.latentUpscaler) && ctx.has("MMH3LatentUpscaleWithModelParams");
      if (input.upscaleWith === "H3's latent upscaler" && !withModel) throw new Error("H3's latent upscaler was not found: put minimax_h3_latent_upscaler_3d_*.safetensors in ComfyUI's models/latent_upscale_models folder, or set the upscale pass to a plain resize.");
      g.phase("upscaling");
      const enlarge = withModel
        ? g.out("MMH3LatentUpscaleWithModelParams", { model_name: slots.latentUpscaler, ...big, device: "cuda", precision: "fp16", offload_model: true })
        : g.out("MMH3LatentUpscaleParams", { method: "bicubic", ...big });
      const tiles = g.out("MMH3SpatialSplitParams", {
        upscale_width: big.width, upscale_height: big.height, tile_size_mode: "specific_size", tile_width: input.upscaleTile, tile_height: input.upscaleTile, grid_rows: 2, grid_cols: 2,
        spatial_w_overlap: input.upscaleOverlap, spatial_h_overlap: input.upscaleOverlap, fade_width: 64, fade_height: 64, min_tile_size: 256,
        overlap_mode: "later", overlap_blend: "linear", masked_area_noise: 0.05, brightness_match: true, dynamic_fade: "widening", dynamic_fade_min: 32,
      });
      const stretches = g.out("MMH3TemporalSplitParams", { chunk_length: input.upscaleChunk, temporal_overlap: 17, anchor_strength: 0.999 });
      g.phase("refining");
      finished = g.out("MMH3UltimateUpscale", {
        model, conditioning: positive, latent: [sampled, 0], noise: g.out("RandomNoise", { noise_seed: ctx.seed + 1 }),
        sampler: g.out("KSamplerSelect", { sampler_name: input.sampler !== AUTO_SAMPLER ? input.sampler : turbo ? "euler" : "res_multistep" }),
        sigmas: g.out("BasicScheduler", { model, scheduler: input.scheduler, steps: input.upscaleSteps, denoise: input.upscaleDenoise }),
        cfg: 1, latent_upscale_param: enlarge, temporal_split_param: stretches, spatial_split_param: tiles,
      });
    }

    g.phase("decoding");
    // the enlarged latent is decoded in tiles and stretches: whole, a doubled 7-second clip asks for tens of GB and falls back to the processor
    let images = input.upscale === UPSCALE.latent
      ? g.out("VAEDecodeTiled", { samples: finished, vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 })
      : g.out("VAEDecode", { samples: finished, vae });
    const audio = g.out("VAEDecodeAudio", { samples: finished, vae: audioVae });
    const smooth = input.smooth && Boolean(slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");
    if (smooth) {
      g.phase("interpolating");
      images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
    }
    // the pixel routes: the final frames enlarged by an upscale model or by RTX VSR
    const pixel = pixelUpscale(g, images, input, { width, height }, ctx);
    images = pixel.images;
    g.phase("encoding");
    // into ComfyUI's temp folder, which it clears itself: nothing piles up in output/
    const out = g.add("VHS_VideoCombine", {
      images, audio, frame_rate: smooth ? H3_FPS * 2 : H3_FPS, loop_count: 0, filename_prefix: "Afflatus/video", format: "video/h264-mp4",
      pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: input.crf, save_metadata: false, trim_to_audio: false,
    });

    const ms = (n: number) => Math.round((n / H3_FPS) * 1000);
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "video", role: "result" }],
      totalSteps: steps,
      passes: [{ node: sampled, steps }],
      loads: [`diffusion_models/${unet}`, `text_encoders/${slots.clip}`, ...(lora ? [`loras/${lora}`] : []), ...pixel.loads],
      ...(head || tail ? { overlap: { headMs: ms(head), tailMs: ms(tail) } } : {}),
    };
  },

  advice(input, card) {
    const out = [];
    const small = card.vramGb <= 13;
    const tiny = card.vramGb <= 9;
    const gb = Math.round(card.vramGb);
    if (input.short > 768) out.push({ input: "short", level: "heavy" as const, text: "past what the model was trained for: slower, and it may drift" });
    if (input.upscale === UPSCALE.latent) out.push({ input: "upscale", level: "slow" as const, text: "about as long again as the clip itself" });
    else if (input.short >= 768 && input.seconds > 6 && small) out.push({ input: "short", level: "heavy" as const, text: `probably too big for a ${gb} GB card at this length` });
    else if (input.short > (tiny ? 480 : 576) && small) out.push({ input: "short", level: "slow" as const, text: `slow on your ${gb} GB card` });
    if (input.seconds > 8 && small) out.push({ input: "seconds", level: "slow" as const, text: `long clips slow down a lot on a ${gb} GB card: two clips that flow on are faster` });
    if (input.sharpRefs && input.references.length) out.push({ input: "sharpRefs", level: "slow" as const, text: "several times slower" });
    return out;
  },

  variants: ((): Variant<H3Video>[] => {
    const slots = { unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors" };
    const all = { ...slots, turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors" };
    const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    const picture = { width: 832, height: 1216 };
    return [
      { name: "words only, plain", input: { description: "a", fast: false, smooth: false, quick: false }, slots },
      { name: "fast, smooth, quick", input: { description: "a", cache: true }, slots: all },
      { name: "full steps with the step cache", input: { description: "a", fast: false, cache: true }, slots: all },
      {
        name: "opens on a picture and ends on another, a LoRA",
        input: { description: "a", start: "p1", end: "p2", loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }], fast: false },
        slots, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      {
        name: "carries on from a clip",
        input: { description: "a", previous: { asset: "c1" }, start: "ignored" },
        slots: all, uploads: { previous: "a.mp4", start: "a.png" }, media: { previous: joined },
      },
      {
        name: "between two clips, the next one silent and short",
        input: { description: "a", previous: { asset: "c1", at: 3000 }, next: { asset: "c2" }, end: "ignored" },
        slots: all, uploads: { previous: "a.mp4", next: "b.mp4", end: "b.png" },
        media: { previous: joined, next: { ...joined, frames: 5, hasSound: false } }, canvas: { width: 1024, height: 576 },
      },
      {
        name: "a person and a place from reference pictures, a voice, opening on a picture",
        input: {
          description: "a", subject: "brown hair", start: "p1", end: "ignored", voice: "v1", sharpRefs: true,
          references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "person" }, { asset: "r3", role: "place" }],
        },
        slots: all, uploads: { start: "a.png", end: "b.png", voice: "v.wav", "references.0": "r1.png", "references.1": "r2.png", "references.2": "r3.png" },
        media: { start: picture },
      },
      {
        name: "references, carrying on from a clip",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "clothing" }], fast: false },
        slots: all, uploads: { previous: "a.mp4", "references.0": "r1.png" }, media: { previous: joined },
      },
      {
        // one file that is all three: no reference model, no turbo LoRA
        name: "a hybrid turbo fine-tune, with a reference picture",
        input: { description: "a", model: "SomeoneH3_hybridTurboV3.safetensors", references: [{ asset: "r1", role: "person" }] },
        slots: { ...slots, turbo: all.turbo }, uploads: { "references.0": "r1.png" },
      },
      {
        name: "a video of the person with its sound, and a picture of the place",
        input: { description: "a", refVideos: [{ asset: "v1", role: "person" }, { asset: "v2", role: "person" }], references: [{ asset: "r1", role: "place" }] },
        slots: all, uploads: { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4", "references.0": "r1.png" },
        media: { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: false } },
      },
      {
        name: "passes through a picture half way",
        input: { description: "a", start: "p1", mid: "p2", midAt: 2.5 },
        slots: all, uploads: { start: "a.png", mid: "m.png" }, media: { start: picture },
      },
      { name: "latent upscale, plain resize", input: { description: "a", upscale: UPSCALE.latent }, slots: all },
      { name: "latent upscale, H3's upscaler", input: { description: "a", upscale: UPSCALE.latent, upscaleBy: 1.5, fast: false }, slots: { ...all, latentUpscaler: "minimax_h3_latent_upscaler_3d_fp16.safetensors" } },
      { name: "pixel upscale with a model", input: { description: "a", upscale: UPSCALE.model, upscaleModel: "4x-UltraSharp.pth" }, slots: all },
      { name: "pixel upscale with RTX VSR", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all },
      {
        name: "a voice only, with the picture of who speaks",
        input: { description: "a", start: "p1", voice: "v1" },
        slots: all, uploads: { start: "a.png", voice: "v.wav" }, media: { start: picture },
      },
    ];
  })(),
});
