import { REFERENCE_ROLES, type ClipValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import { H3_FORM_PIXELS, H3_FPS } from "./family";
import { UPSCALE, upscaleInputs } from "../video/upscale";
import { COLOUR_MATCH_INPUTS, type ColourMatch } from "../shared/finish";
import { H3_REFERENCES, H3_REFERENCE_VIDEOS } from "./condition";
import { H3_JOIN_FRAMES, H3_LANDINGS } from "./join";

export interface H3Video extends ColourMatch {
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
  /** Whether a frozen tail of the clip before is cut off, so this one carries on from its last lively moment (read by the server, not the graph). */
  handover: boolean;
  /** Frames of the clip before pinned at the start, as a string from H3_LANDINGS (read by the server, which trims the clip to them). */
  context: string;
  next?: ClipValue;
  /** Frames of the next clip the join lands on, as a string from H3_LANDINGS (read by the server). */
  landing: string;
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
  joinFrom: string;
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
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

/** The recipe's inputs, in the order the form shows them. */
export const h3Inputs: InputSpec[] = [
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
  { id: "mid", type: "image", role: "mid", at: "midAt", label: "Keyframe", note: "a picture the clip passes through, at the time set below", optional: true, advanced: true },
  { id: "midAt", type: "number", label: "Keyframe at", min: 0.5, max: 14.5, step: 0.5, default: 2.5, unit: " s", showWhen: "mid", advanced: true },
  {
    id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: H3_JOIN_FRAMES, framesFrom: "context", fps: H3_FPS,
    note: "the motion and the voices of that clip continue into this one. With the Afflatus node pack in ComfyUI (Settings → ComfyUI), the clip continues from that clip's own latent, which keeps the look and the voice as well as the motion",
  },
  {
    id: "handover", type: "toggle", label: "Skip a frozen tail", default: true, showWhen: "previous", advanced: true, section: "rare",
    note: "H3 often holds its last frames still. When the clip before ends still for a quarter second or more, this clip carries on from its last lively moment and that clip is trimmed to it",
  },
  {
    id: "context", type: "choice", label: "Frames from the clip before", options: [...H3_LANDINGS], default: "22", showWhen: "previous", advanced: true, section: "rare",
    note: "pinned at the start as the run-up: 5 is a position, 22 brings its motion and voice too, 39 a long run-in. When the join jumps, try another count",
  },
  {
    id: "joinFrom", type: "choice", label: "Continue from", options: ["Latent", "Frames"], renamed: { Auto: "Latent", Hybrid: "Latent" }, default: "Latent", showWhen: "previous", advanced: true, section: "rare",
    note: "what of the clip before guides this one. Latent: its exact latent (picture, motion and sound as the model made them), decoded as one piece with it so that the join is a plain cut, like the whole chain decoded at once (needs the Afflatus node pack and the clip before's saved latent; without them, frames). Frames: its last frames and sound re-encoded and pinned, as ComfyUI alone does it; a chain of these softens clip after clip",
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
    note: "the short side of the frame. 576p suits drafts and the 8-step turbo LoRA (made at 544p); the model's own is 768p (1344×768), and the 4-step LoRA is made for it. Past 768p it is beyond what it was trained for: slower, and it may drift",
  },
  ...upscaleInputs({ latent: true }),
  ...COLOUR_MATCH_INPUTS,
  {
    id: "upscaleDenoise", type: "number", label: "Upscale denoise", min: 0.05, max: 0.6, step: 0.01, default: 0.15, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true,
    note: "denoising strength of the re-sampling, on the model's shift: at shift 11, 0.15 starts near sigma 0.66 (DaSiWa's tiled upscaler runs about 0.6), 0.3 near 0.82. More draws more detail but shifts colour and light and lets each tile decide on its own. A plain resize of the latent (no H3 latent upscaler file) needs 0.3 or more, else it stays soft",
  },
  { id: "upscaleSteps", type: "number", label: "Upscale steps", min: 1, max: 6, step: 1, default: 2, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "steps of the re-sampling: 1 only sharpens, 2 adds detail, more is rarely worth it; each step is a pass over the whole clip" },
  {
    id: "upscaleWith", type: "choice", label: "Latent upscaler", options: ["H3's latent upscaler", "Plain resize"], renamed: { Auto: "H3's latent upscaler" }, default: "H3's latent upscaler", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true,
    note: "H3's own 3D upscaler model; while its file is not in ComfyUI, a plain resize is used instead: a bicubic resize of the latent, which is soft unless the re-sampling has steps and denoise to work with. The file is one click in Settings → Models, under MiniMax H3",
  },
  { id: "upscaleTile", type: "number", label: "Upscale tile size", min: 256, max: 1024, step: 32, default: 512, unit: " px", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "the frame is re-sampled one tile at a time: smaller tiles need less memory" },
  { id: "upscaleOverlap", type: "number", label: "Upscale tile overlap", min: 32, max: 256, step: 32, default: 128, unit: " px", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true },
  { id: "upscaleChunk", type: "number", label: "Upscale temporal chunk", min: 17, max: 255, step: 17, default: 85, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "the clip is re-sampled in stretches of this many frames, overlapping by 17" },
  {
    id: "fast", type: "toggle", label: "Turbo", note: "a few steps, about twice as fast, for drafts: with the turbo LoRA (one click in Settings → Models), or as it is with a turbo model. Without either, the full steps run", default: false, advanced: true, perModel: true,
    // the shifts the turbo LoRAs were trained at
    whenOn: { shiftVideo: 12, shiftAudio: 3, sampler: "euler" },
  },
  {
    id: "turboSteps", type: "number", label: "Turbo steps", min: 0, max: 16, step: 1, default: 8, showWhen: "fast", advanced: true, perModel: true,
    note: "8 for the 8-step turbo LoRA and the distilled files; 4 for a 4-step one. ComfyUI's own template runs the 8-step LoRA at 6",
  },
  { id: "steps", type: "number", label: "Steps", note: "20 is ComfyUI's own template; 15 is a little quicker, 25 a little finer", min: 4, max: 50, step: 1, default: 20, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true },
  {
    id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, default: "res_multistep", advanced: true, perModel: true,
    note: "res_multistep at full steps, euler with Turbo (ComfyUI's own template uses res_multistep for both)",
  },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "BasicScheduler", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
  {
    id: "shiftVideo", type: "number", label: "Shift (video)", min: 0, max: 30, step: 0.5, default: 11, advanced: true, perModel: true,
    note: "11 at full steps, 12 with the 8-step turbo LoRA and 6 with a 4-step one (what they were trained at). Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail). The model's own, when no shift is set at all, is 12",
  },
  {
    id: "shiftAudio", type: "number", label: "Shift (sound)", min: 0, max: 30, step: 0.5, default: 4, advanced: true, perModel: true,
    note: "4 at full steps, 3 with Turbo (the turbo LoRAs were trained at 3)",
  },
  {
    id: "turboIn", type: "choice", label: "Distilled model", options: ["From the name", "Yes", "No"], renamed: { Auto: "From the name" }, default: "From the name", advanced: true, section: "rare", perModel: true,
    note: "made for 4 to 8 steps: no turbo LoRA is added. From the name: when it says turbo, distill, lightning or a step count",
  },
  {
    id: "hybrid", type: "choice", label: "Hybrid model", options: ["From the name", "Yes", "No"], renamed: { Auto: "From the name" }, default: "From the name", advanced: true, section: "rare", perModel: true,
    note: "it follows reference pictures and voices itself; otherwise those clips use MiniMax's reference model. From the name: when it says hybrid",
  },
  { id: "smooth", type: "toggle", label: "RIFE ×2", note: "frame interpolation: frames interpolated with RIFE, from 24 to 48 a second", default: true, advanced: true },
  { id: "sharpRefs", type: "toggle", label: "Full-res references", note: "holds a face better, several times slower", default: false, advanced: true },
  { id: "cache", type: "toggle", label: "Step cache", note: "faster, softer: steps that barely change are skipped (MiniMaxH3Cache, from the ComfyUI-DaSiWa-Nodes pack; without it nothing changes). Only without Turbo", default: false, showWhen: { input: "fast", in: [false] }, advanced: true },
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
];
