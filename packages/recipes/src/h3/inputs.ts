import { REFERENCE_ROLES, type ClipValue, type CueValue, type InputSpec, type LoraValue, type ReferenceValue, type SizeValue } from "@afflatus/core";
import { H3_FORM_PIXELS, H3_FPS } from "./family";
import { UPSCALE, upscaleInputs } from "../video/upscale";
import { COLOUR_MATCH_INPUTS, type ColourMatch } from "../shared/finish";
import { H3_REFERENCES, H3_REFERENCE_VIDEOS } from "./condition";
import { H3_JOIN_FRAMES, H3_LANDINGS } from "./join";
import { FACE_REFINE_INPUTS } from "./faceRefine";
import { CUE_SOUND, H3_CUES } from "./cue";
import { H3_TURBO_ROW, TURBO_LORA_INPUTS } from "./turboRow";

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
  /** Sounds that land at moments of the clip, each a part of a file (cue.ts). */
  cues: CueValue[];
  /** Whose sound the take's file carries at each cue: CUE_SOUND's. */
  cueSound: string;
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
  voiceEven: boolean;
  subject: string;
  sharpRefs: boolean;
  seconds: number;
  shape: SizeValue;
  short: number;
  fast: boolean;
  /** Turbo's LoRA picked in its row of the LoRA list (empty: the slot's) and its weight (left out: 1). */
  turboLora?: string;
  turboWeight?: number;
  turboSteps: number;
  steps: number;
  sampler: string;
  scheduler: string;
  shiftVideo: number;
  shiftAudio: number;
  smooth: boolean;
  quick: boolean;
  cache: boolean;
  /** How wide the shot is (card #27): its words open the prompt, the same on every H3 form. "Any": the model's own. */
  shot?: string;
  /** Veda's sparse attention, and its key tiles kept of each query tile (generated, reference tokens). */
  veda?: boolean;
  vedaGenerated?: number;
  vedaReference?: number;
  joinFrom: string;
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
  seedvrModel?: string;
  upscaleNoise: number;
  upscaleSteps: number;
  upscaleTile: number;
  upscaleOverlap: number;
  upscaleChunk: number;
  upscaleWith: string;
  /** H3's latent upscaler file; left out, the family's (Settings › Models). */
  upscaleLatentModel?: string;
  cacheThreshold: number;
  cacheStart: number;
  cacheEnd: number;
  cacheSteps: number;
  crf: number;
  livePreview: boolean;
  faceRefine: boolean;
  faceRefineDenoise: number;
  faceRefineSteps: number;
  /** The model the faces are redrawn with: a file, OWN_MODEL (the clip's), or left out (the fused turbo's slot). */
  faceRefineModel?: string;
  /** A finish of a kept take that only refines its faces (Finish › Face refine): its own latent, nothing sampled. */
  faceRefineOnly: boolean;
  loras: LoraValue[];
  seed: number;
}

/** The recipe's inputs, in the order the form shows them. */
/**
 * Said in the "?" of every H3 text the user writes but the prompt as sent (card #49): H3's tags are Afflatus's to write,
 * around the words, in H3's own layout.
 */
/** What the reference videos are, said alike on every H3 form that takes them (its sound is each form's own line). */
export const REF_VIDEOS_WHAT = "short videos of a person, a place, clothes, an object or a look, and how they move: they are followed, they are not frames of the clip. The first 3 seconds of each are used.";
export const H3_NO_TAGS = "No <Picture 1> or <Video 1> to type: Afflatus adds H3's tags, saying which picture is whom.";

/**
 * Every H3 form's Sound card (card #170): the sound effects and the music H3 makes, the source's sound kept and its audio guide,
 * a recording's start and loudness. Reached under the Inputs tab, so that the four forms keep the same six tabs.
 */
/**
 * The rows Swap and Motion transfer share for their source video, written once so that their words cannot drift (every H3
 * form alike): the part's start, keeping the source's sound, and that sound as H3's guide.
 */
export const SOURCE_START: InputSpec = { id: "sourceStart", type: "number", label: "Source: start", min: 0, max: 3600, step: 0.1, default: 0, unit: " s", showWhen: "source" };
export const SOURCE_SOUND_INPUTS: InputSpec[] = [
  { id: "keepSound", type: "toggle", label: "Keep the source's sound", default: true, advanced: true, chapter: "sound", note: "the file carries the source video's own sound over its part; off, the sound H3 makes" },
  {
    // H3 moves the mouth to the sound it makes with the frames; without the source's, it drew lips to a sound then thrown
    // away for the source's own (the owner, 2026-10-17: "how his lips move are really awkward"). With it, the new mouth
    // followed the source person's 0.57 against 0.46 over the owner's Bulin 47 window, 0.51 against 0.39 on another mask (§9.11)
    id: "soundGuide", type: "toggle", label: "Audio guide", default: true, advanced: true, showWhen: "keepSound", chapter: "sound",
    note: "the source video's own sound given to H3 as a guide, as Lip sync gives its recording, so that the mouth is drawn to the words heard",
  },
];

export const H3_SOUND_CHAPTER = { id: "sound", label: "Sound", under: "inputs", help: "The sound H3 makes with the picture (its effects and music) and what it is given to hear: a recording, the source's own sound as an audio guide, a voice sample brought to one loudness." };

export const h3Inputs: InputSpec[] = [
  {
    id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["minimax.?h3", "(^|[^a-z0-9])h3([^a-z0-9]|$)"],
    note: "MiniMax's own, or a fine-tune of it",
  },
  {
    id: "description", type: "prompt", weights: false, label: "What happens", style: "sentences", main: true,
    placeholder: "She walks to the railing and looks out at the sea. The camera follows her slowly. (S1) says <d>[English] What a view.</d> softly.",
    note: H3_NO_TAGS,
  },
  { id: "soundscape", type: "prompt", weights: false, label: "Sound effects", style: "sentences", optional: true, chapter: "sound", placeholder: "waves, a light wind, seagulls far away" },
  { id: "music", type: "prompt", weights: false, label: "Music", style: "sentences", optional: true, chapter: "sound", placeholder: "none" },
  { id: "start", type: "image", role: "start", label: "First frame", note: "the first frame", optional: true },
  { id: "end", type: "image", role: "end", label: "Last frame", note: "the last frame. Not used with reference pictures, videos or a voice sample: the reference model takes no last frame", optional: true },
  { id: "mid", type: "image", role: "mid", at: "midAt", label: "Keyframe", note: "a picture the clip passes through, at the time set below", optional: true, advanced: true },
  { id: "midAt", type: "number", label: "Keyframe at", min: 0.5, max: 14.5, step: 0.5, default: 2.5, unit: " s", showWhen: "mid" },
  {
    // a sound alone pinned at a frame lands there exactly, and the picture meets it only when the words name it (card #79)
    id: "cues", type: "cues", label: "Sound cues", max: H3_CUES,
    note: "sounds that land at moments of the clip: a door slam, a clap, a line, a music hit. Each one is a part of its file and the moment it lands, in the clip's own time. H3 hears it there; the picture meets it when What happens names it at that moment (\"she claps her hands once\")",
  },
  {
    id: "cueSound", type: "choice", label: "In the take", options: [...CUE_SOUND], default: CUE_SOUND[0], showWhen: "cues",
    // the file's sound goes over H3's own there, and over a recording or a source's sound, which play on under it; over those,
    // the part is laid in either way, H3's sound not being in that file
    note: "the file's sound: each cue's part laid into the take at its moment. H3's own: H3 makes the sound, the file only guides it",
  },
  {
    id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: H3_JOIN_FRAMES, framesFrom: "context", fps: H3_FPS, look: "matched",
    note: "the motion and the voices of that clip continue into this one. With the Afflatus node pack in ComfyUI (Settings → ComfyUI), the clip continues from that clip's own latent, which keeps the look and the voice as well as the motion",
  },
  {
    id: "handover", type: "toggle", label: "Skip a frozen tail", default: true, showWhen: "previous", advanced: true, section: "rare",
    note: "H3 often holds its last frames still. When the clip before ends still for a quarter second or more, this clip carries on from its last lively moment and that clip is trimmed to it",
  },
  {
    id: "context", type: "choice", label: "Overlap frames", options: [...H3_LANDINGS], default: "22", showWhen: "previous", advanced: true, section: "rare",
    note: "pinned at the start as the run-up: 5 is a position, 22 brings its motion and voice too, 39 a long run-in. When the join jumps, try another count",
  },
  {
    id: "joinFrom", type: "choice", label: "Continue from", options: ["Latent", "Frames"], renamed: { Auto: "Latent", Hybrid: "Latent" }, default: "Latent", showWhen: "previous", advanced: true, section: "rare",
    // Latent: picture, motion and sound as the model made them, as if the whole chain were decoded at once; without the Afflatus
    // node pack or the clip before's saved latent, frames
    note: "Latent: the clip before's latent, decoded as one piece with it (a clean cut; Afflatus nodes). Frames: its last frames re-encoded, as plain ComfyUI; softens over a chain",
  },
  {
    id: "next", type: "clip", role: "next", label: "Next clip", optional: true, frames: H3_JOIN_FRAMES, framesFrom: "landing", fps: H3_FPS, advanced: true,
    note: "this clip ends exactly where that one begins",
  },
  {
    id: "landing", type: "choice", label: "Landing", options: [...H3_LANDINGS], default: "22", showWhen: "next",
    note: "frames of the next clip the join lands on: 5 is a position, 22 brings its motion too, 39 a long run-in (a short next clip gives fewer)",
  },
  {
    id: "references", type: "references", label: "Reference images", max: H3_REFERENCES, roles: [...REFERENCE_ROLES],
    // every "A person" picture is written into H3's layout as one character (prompt.ts): two different people blend into
    // one face, so the "?" says so (the owner, card #75). Shared by every H3 form that takes these pictures
    note: "pictures of a person, a place, clothes, an object or a look: they are followed, they are not frames of the clip. Every \"A person\" picture is the same person, seen another way. For two people, pin a keyframe that shows both",
  },
  {
    id: "refVideos", type: "references", media: "video", label: "Reference videos", max: H3_REFERENCE_VIDEOS, roles: [...REFERENCE_ROLES],
    // only a person's video gives its sound (as their voice): H3 lays a lone sound reference into the take as it is and
    // ignores it beside a voice (card #79), so a place's sound would become the clip's sound or do nothing
    note: `${REF_VIDEOS_WHAT} Only a person's video gives its sound, as their voice unless a voice sample is given; the sound of any other is left out: for a place's sound, use the music lane or a sound cue`,
  },
  {
    id: "voice", type: "audio", role: "voice", label: "Voice sample", optional: true, window: { start: "voiceStart", seconds: "voiceSeconds", even: "voiceEven" },
    note: "someone speaking: the person in the clip speaks with that voice. Only the part you set is used: the longer the better, up to 15 seconds of clean speech",
  },
  { id: "voiceStart", type: "number", label: "Voice sample: start", min: 0, max: 600, step: 0.5, default: 0, unit: " s", showWhen: "voice" },
  // 15 s carried his voice better than 8 s, at the same render time (3 seeds each, evened: 0.805 against 0.781, 2026-10-13)
  { id: "voiceSeconds", type: "number", label: "Voice sample: length", min: 2, max: 15, step: 0.5, default: 15, unit: " s", showWhen: "voice" },
  {
    id: "voiceEven", type: "toggle", label: "Normalize loudness", default: true, showWhen: "voice", advanced: true, chapter: "sound",
    note: "the part is brought to a usual speaking level (-16 LUFS, measured as EBU R128) before it is used: a quiet sample carries a voice weakly",
  },
  {
    id: "subject", type: "prompt", weights: false, label: "How they look", style: "sentences", optional: true, showWhen: "references", holds: "subject",
    placeholder: "brown hair, green eyes, freckles", note: `in a few words, to help the pictures. ${H3_NO_TAGS}`,
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
    note: "the short side of the frame. 576p suits drafts and the 8-step turbo LoRA (made at 544p); the model's own is 768p (1344×768), and the 4-step LoRA is made for it. Past 768p it is beyond what it was trained for: slower, it may drift, and some seeds black out part way through the clip (users' reports at 768 × 960 and up)",
  },
  ...upscaleInputs({ latent: true }),
  ...COLOUR_MATCH_INPUTS,
  ...FACE_REFINE_INPUTS,
  {
    id: "upscaleNoise", type: "number", label: "Re-sample denoise", min: 0.05, max: 0.95, step: 0.01, default: 0.35, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true,
    fromDenoise: { id: "upscaleDenoise", steps: "upscaleSteps", shift: "shiftVideo", oldDefault: { denoise: 0.15, steps: 2 } },
    // eased down to 0.012 and 0 over the steps (karras); higher also makes moving edges flicker, lower leaves the upscaler's grain
    note: "the σ the re-sample starts at, whatever the shift (0.35 = 35 % noise). Higher redraws more, and faces drift from the draft; Bicubic needs about 0.8",
  },
  { id: "upscaleSteps", type: "number", label: "Re-sample steps", min: 1, max: 6, step: 1, default: 3, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "from its denoise down to 0 (karras); each step is a pass over the whole clip" },
  {
    id: "upscaleWith", type: "choice", label: "Latent upscale method", options: ["H3's latent upscaler", "Plain resize"], renamed: { Auto: "H3's latent upscaler" }, labels: { "H3's latent upscaler": "Latent upscaler", "Plain resize": "Bicubic" }, default: "H3's latent upscaler", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true,
    note: "Latent upscaler: H3's 3D latent upscale model (Settings › Models, MiniMax H3); while its file is missing, Bicubic. Bicubic stays soft without denoise to work with",
  },
  {
    // the enlarging alone is a choice (the owner, 2026-10-29, card #159): the re-sampling stays on the clip's own model, its
    // look and its joins
    id: "upscaleLatentModel", type: "model", label: "Latent upscaler", folder: "latent_upscale_models", slot: "latentUpscaler", match: ["minimax.?h3.?latent.?upscaler"], showWhen: { input: "upscaleWith", in: ["H3's latent upscaler"] }, advanced: true,
    note: "from models/latent_upscale_models; left as it is, Settings › Models' file. The re-sample after it runs on the clip's own model",
  },
  { id: "upscaleTile", type: "number", label: "Re-sample tile size", min: 256, max: 1024, step: 32, default: 512, unit: " px", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "the frame is re-sampled one tile at a time: smaller tiles need less memory" },
  { id: "upscaleOverlap", type: "number", label: "Re-sample tile overlap", min: 32, max: 256, step: 32, default: 128, unit: " px", showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true },
  { id: "upscaleChunk", type: "number", label: "Re-sample temporal chunk", min: 17, max: 255, step: 17, default: 85, showWhen: { input: "upscale", in: [UPSCALE.latent] }, advanced: true, note: "the clip is re-sampled in stretches of this many frames, overlapping by 17" },
  {
    id: "fast", type: "toggle", label: "Turbo", note: "a few steps, about twice as fast, for drafts: with the turbo LoRA (one click in Settings → Models), or as it is with a turbo model. Without either, the full steps run", default: false, advanced: true, perModel: true,
    // the shifts the turbo LoRAs were trained at
    whenOn: { shiftVideo: 12, shiftAudio: 3, sampler: "euler" },
  },
  {
    id: "turboSteps", type: "number", label: "Turbo steps", min: 1, max: 16, step: 1, default: 8, oldZero: true, showWhen: "fast", advanced: true, perModel: true,
    note: "8 for the 8-step turbo LoRA and the distilled files; 4 for a 4-step one (a reference clip on MiniMax's 4-step reference LoRA starts on 4). ComfyUI's own template runs the 8-step LoRA at 6",
  },
  { id: "steps", type: "number", label: "Steps", note: "20 is ComfyUI's own template; 15 is a little quicker, 25 a little finer", min: 4, max: 50, step: 1, default: 20, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true },
  {
    id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, default: "res_multistep", advanced: true, perModel: true,
    note: "res_multistep at full steps, euler with Turbo (ComfyUI's own template uses res_multistep for both)",
  },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "BasicScheduler", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
  {
    id: "shiftVideo", type: "number", label: "Shift (video)", min: 1, max: 30, step: 0.5, default: 11, oldZero: true, advanced: true, perModel: true,
    note: "11 at full steps, 12 with the 8-step turbo LoRA and 6 with a 4-step one (what they were trained at). Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail). The model's own, when no shift is set at all, is 12",
  },
  {
    id: "shiftAudio", type: "number", label: "Shift (sound)", min: 1, max: 30, step: 0.5, default: 4, oldZero: true, advanced: true, perModel: true,
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
  { id: "cacheThreshold", type: "number", label: "Step cache threshold", note: "a step that would change the clip by less than this is skipped: higher skips more, faster and softer", min: 0.01, max: 0.5, step: 0.01, default: 0.05, showWhen: "cache", advanced: true, section: "speed" },
  { id: "cacheStart", type: "number", label: "Step cache start", note: "where in the render skipping may begin: the first steps decide the clip and are never skipped below this", min: 0, max: 0.9, step: 0.05, default: 0.15, showWhen: "cache", advanced: true, section: "speed" },
  { id: "cacheEnd", type: "number", label: "Step cache end", note: "where skipping stops, so that the last steps finish the detail", min: 0.1, max: 1, step: 0.05, default: 0.9, showWhen: "cache", advanced: true, section: "speed" },
  { id: "cacheSteps", type: "number", label: "Step cache max skips", note: "how many steps may be skipped one after the other", min: 1, max: 6, step: 1, default: 2, showWhen: "cache", advanced: true, section: "speed" },
  {
    // the shot as a word of the prompt (card #27), deterministic: the same words on every H3 form, in the prompt as sent
    id: "shot", type: "choice", label: "Shot", options: ["Any", "Wide", "Medium", "Close-up"], default: "Any",
    note: "how wide the shot is: its words open the prompt (\"Medium shot.\"), or follow a swap's first sentence. Any: as the model and the pictures make it. A prompt typed by hand in Prompt as sent is sent as it is",
  },
  {
    // every H3 form alike (the owner, 2026-10-20): the swap's toggle, on every form. The tested character-swap workflow runs it
    // at 32 / 32; its makers trained the predictors at 768p on 8-step turbo, other sizes and steps work
    id: "veda", type: "toggle", label: "Veda sparse attention", default: false, advanced: true, section: "speed",
    note: "faster on long clips: a small predictor picks the attention that matters and the rest is skipped, the steps unchanged. Needs the veda-sparse-attention node pack and its predictor (the reference model's for clips with references, the text-and-frames one otherwise), in Settings › Models; without them the full attention runs",
  },
  { id: "vedaGenerated", type: "number", label: "Veda generated sparsity", min: 8, max: 64, step: 8, default: 32, advanced: true, section: "speed", showWhen: "veda", note: "VedaSparseAttention's generated_sparsity: key tiles kept of each query tile, of the clip's own tokens; fewer is faster" },
  { id: "vedaReference", type: "number", label: "Veda reference sparsity", min: 8, max: 64, step: 8, default: 32, advanced: true, section: "speed", showWhen: "veda", note: "VedaSparseAttention's reference_sparsity: the same of the reference tokens (the pictures, a source video)" },
  {
    id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
    note: "while it renders, a short clip of what is forming, each step, with its sound so far. A small cost per step. Needs the KJNodes pack",
  },
  {
    id: "quick", type: "toggle", label: "Comfy Kitchen attention", default: true, advanced: true,
    note: "a faster attention for INT8 models (ModelAttentionBackend), on Nvidia and AMD cards. Turn it off if renders fail on another machine",
  },
  { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
  { id: "loras", type: "loras", label: "LoRAs", max: 6, added: [H3_TURBO_ROW] },
  ...TURBO_LORA_INPUTS,
  { id: "seed", type: "seed", label: "Seed" },
];
