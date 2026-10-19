import { defineRecipe, GraphBuilder, type BuildContext, type ClipValue, type LoraValue, type MediaFacts, type Recipe, type Ref, type SizeValue, type Variant } from "@afflatus/core";
import { LTX_CANVAS_SHORT, LTX_MAX_PIXELS, ltxCanvas, ltxFramesAt } from "./family";
import { UPSCALE, UPSCALE_OPTIONAL, upscaleInputs, upscaleNeeds, upscaleNodes } from "../video/upscale";
import { faster, SPEED_INPUTS, speedNodes, type SpeedSettings } from "../shared/speed";
import { loadUnet, unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { colourMatched, COLOUR_MATCH_INPUTS, COLOUR_MATCH_NODES, finishFrames, openingStart, rifeNeeds, rifeSkippedSaid, type ColourMatch } from "../shared/finish";
import { applyLoras, livePreview, loraLoads } from "../shared/model";

/**
 * The LTX video recipe, made for a version of the model: LTX 2.3 and LTX 2.5 are the same two-pass graph (half the size
 * first, enlarged ×2 in the latent, refined in a few steps) with the same schedules, and differ in their files (2.5's Gemma 4
 * encoder carries the text projection inside it, and it has no one-file checkpoint), their frame rate (25 against 24),
 * their sampler (`euler` against `euler_ancestral`), their guider (CFG against 2.5's dual CFG, video and audio apart) and
 * their decoder's tiles. What differs is the spec; the rest is here once.
 */
export interface LtxSpec {
  id: string;
  family: string;
  /** The family's name in what is said ("LTX 2.3"). */
  name: string;
  title: string;
  summary: string;
  fps: number;
  /**
   * How the model's files are loaded: "checkpoint", LTX 2.3's one checkpoint (or its split files with a text projection
   * of their own); "split", LTX 2.5's split files, the projection inside its Gemma 4 file.
   */
  loader: "checkpoint" | "split";
  /** The guider: ComfyUI's CFGGuider, or 2.5's LTXVDualCFGGuider (video and audio alike at the form's CFG). */
  guider: "cfg" | "dual";
  /** The sampler the model's own template runs. */
  sampler: string;
  /** The decoder's tiles, as the template sets them. */
  decode: { tile: number; frames: number; overlap: number };
  /** What the Model choice lists (file name patterns). */
  modelMatch: string[];
  /** KJNodes' LTX2_NAG offered: tried on 2.3; not on 2.5's new blocks. */
  nag: boolean;
  /** The temporal upscaler's file, as the error names it. */
  temporalFile: string;
  /** What is said when the model is not found, and when its split files lack a part. */
  missing: { model: string; parts: string };
  variants: Variant<LtxVideo>[];
}

const SMOOTH_AUTO = "Auto";
const SMOOTH_RIFE = "RIFE (pixels)";
const SMOOTH_LTX = "LTX temporal (latent)";

/** The schedule LTX's authors give for the distilled model: 8 steps, written out (2.3 and 2.5 alike). */
export const LTX_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0";
/** The schedule of the second pass, over the enlarged clip: 3 steps that only refine. */
export const LTX_REFINE_SIGMAS = "0.85, 0.7250, 0.4219, 0.0";
/** How the refining pass comes down from where it starts, in three steps, as LTX's authors wrote it: shares of its first value. */
const REFINE_SHAPE = LTX_REFINE_SIGMAS.split(",").map((x) => Number(x) / 0.85);
/**
 * The schedule of the refining pass: it starts at `from` (how much of the enlarged clip is redrawn) and
 * comes down to nothing in `steps` steps. At 0.85 in 3 steps it is LTX's own, to the digit; other
 * figures follow the same curve.
 */
function refineSigmas(from: number, steps: number): string {
  const shares = steps === 3 ? REFINE_SHAPE : Array.from({ length: steps + 1 }, (_x, i) => 1 - (i / steps) ** 1.75);
  return shares.map((x, i) => (i === shares.length - 1 ? "0.0" : String(Number((from * x).toFixed(4))))).join(", ");
}
const OWN_SCHEDULE = "LTX's own (8 steps)";
const BY_STEPS = "By steps";

/**
 * How many frames of the clip before open a clip that carries on from it: its last second (25 frames, on the model's 8n + 1)
 * as a video guide at frame 0, the way LTX's own extension works from a clip's tail (its authors' pipelines carry 25 to 73
 * frames; 25 is what a short clip can give). A clip too short for that gives 9. Hidden on a timeline as H3's run-up is.
 */
export const LTX_JOIN_FRAMES = [25, 9];
/** The guide's strength on those frames: they are the clip before's own and are not shown, so they are held exactly. */
const CARRY_STRENGTH = 1;
/** The longest clip the model takes, in seconds: the frames shared with the clip before count in it. */
const LTX_MAX_SECONDS = 20;

export interface LtxVideo extends ColourMatch {
  model?: string;
  turboIn: string;
  prompt: string;
  negative: string;
  nag: boolean;
  nagScale: number;
  start?: string;
  previous?: ClipValue;
  end?: string;
  mid?: string;
  midAt: number;
  midStrength: number;
  seconds: number;
  shape: SizeValue;
  short: number;
  twoPass: boolean;
  refineStrength: number;
  refineSteps: number;
  loraStrength: number;
  tile: number;
  tileFrames: number;
  crf: number;
  schedule: string;
  steps: number;
  maxShift: number;
  baseShift: number;
  terminal: number;
  stretch: boolean;
  cfg: number;
  sampler: string;
  startStrength: number;
  endStrength: number;
  compression: number;
  smooth: boolean;
  smoothWith: string;
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
  livePreview: boolean;
  sage: SpeedSettings["sage"];
  sageKernel: SpeedSettings["sageKernel"];
  compile: SpeedSettings["compile"];
  loras: LoraValue[];
  seed: number;
}

/** What a model is, as far as its file name says: the distilled one, or a merge known to be made for a few steps. */
// The fine-tune lines are named: DragonLeap and SolsticeCoin are distilled (DMD, 8 to 12 steps at CFG 1), GoldenLace is not
const namedDistilled = /distill|turbo|lightning|lightspeed|dmd|dragonleap|solsticecoin|(^|[^a-z0-9])\d+[ _-]?steps?/i;

/**
 * How the model is loaded. In separate files when a diffusion model is picked or found; otherwise (LTX 2.3) from
 * the one checkpoint. Whether it is distilled decides if the distilled LoRA goes on top of it.
 */
const modelOf = (spec: LtxSpec, input: LtxVideo, slots: Record<string, string>) => {
  const unet = input.model ?? slots.unet;
  const checkpoint = spec.loader === "checkpoint" && !unet ? slots.checkpoint : undefined;
  const name = (unet ?? checkpoint)?.split(/[\\/]/).pop() ?? "";
  return { unet, checkpoint, distilled: input.turboIn === "Yes" || (input.turboIn !== "No" && namedDistilled.test(name)) };
};

/**
 * Which way the clip is made. In two passes when it can be: a first pass at half the size, enlarged in
 * latent space, then a short second pass that refines it. That needs the latent upscaler, and it is how
 * a clip is made from words or from an opening picture. A clip that ends on a picture is made in one
 * pass at full size, its pictures given as guides: the way ComfyUI's own first-and-last-frame template does it.
 */
const uses = (input: LtxVideo, slots: Record<string, string>) => ({ twoPass: input.twoPass && Boolean(slots.upscaler) && !input.end });

/**
 * The frame a keyframe is pinned at: its moment at the model's frame rate, counted after the frames shared with the clip
 * before (`head`), kept off the first frame and off the last one, which belong to the first and the last picture.
 */
const midFrame = (input: LtxVideo, fps: number, frames: number, head = 0) => {
  // on the model's 8-frame steps (the node rounds a guide's index down to one by itself, so 2.5 s typed landed at 2.24 s),
  // off the first frame and the last, which belong to the first and the last picture
  const step = 8;
  const at = head + Math.round((input.midAt * fps) / step) * step;
  return Math.max(step, Math.min(frames - 1 - step, at));
};

/** The frames of the clip before a clip opens on, as they were handed over: 25 or 9, on the model's 8n + 1. */
function headFramesOf(m: MediaFacts | undefined): number {
  const n = m?.frames ?? 0;
  if (!LTX_JOIN_FRAMES.includes(n)) throw new Error(`a clip carries on from ${LTX_JOIN_FRAMES.join(" or ")} frames of the clip before, not ${n}`);
  return n;
}
/**
 * How many steps the refining pass takes: the form's, and one more than LTX's own 3 on a clip past 241 frames (9.6 s),
 * where users find the ×2 upscaler needs it (Lightricks discussion #13, 2026-03). A count typed other than 3 is taken as typed.
 */
const refineStepsOf = (input: LtxVideo, frames: number) => (input.refineSteps === 3 && frames > 241 ? 4 : input.refineSteps);

/** Frames as the model likes them: at the clip's size, and roughened like frames of video. */
function ltxGuideFrames(g: GraphBuilder, input: LtxVideo, images: Ref, w: number, h: number): Ref {
  const sized = g.out("ImageScale", { image: images, upscale_method: "lanczos", width: w, height: h, crop: "center" });
  return g.out("LTXVPreprocess", { image: sized, img_compression: input.compression });
}
/** A picture the same way. */
const ltxFrame = (g: GraphBuilder, input: LtxVideo, upload: string | undefined, w: number, h: number): Ref => ltxGuideFrames(g, input, g.out("LoadImage", { image: upload }), w, h);

/**
 * The model, its text encoder and its two VAEs: from files of their own or from the one checkpoint, the LoRAs and the
 * speed-ups on it, then the distilled LoRA and the live preview. `model` samples every pass; `first` the first one.
 */
function ltxLoad(spec: LtxSpec, g: GraphBuilder, ctx: BuildContext, input: LtxVideo, picked: ReturnType<typeof modelOf>) {
  const { slots } = ctx;
  let model: Ref;
  let clip: Ref;
  let vae: Ref;
  let audioVae: Ref;
  if (picked.unet) {
    model = loadUnet(g, ctx, picked.unet);
    // 2.3's split files: the text encoder and its projection are two files; 2.5's Gemma 4 file carries the projection
    clip = spec.loader === "checkpoint"
      ? g.out("DualCLIPLoader", { clip_name1: slots.clip, clip_name2: slots.projection, type: "ltxv", device: "default" })
      : g.out("CLIPLoader", { clip_name: slots.clip, type: "ltxv", device: "default" });
    vae = g.out("VAELoader", { vae_name: slots.videoVae });
    audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
  } else {
    const loaded = g.add("CheckpointLoaderSimple", { ckpt_name: picked.checkpoint });
    model = [loaded, 0];
    vae = [loaded, 2];
    audioVae = g.out("LTXVAudioVAELoader", { ckpt_name: picked.checkpoint });
    clip = g.out("LTXAVTextEncoderLoader", { text_encoder: slots.clip, ckpt_name: picked.checkpoint, device: "default" });
  }
  model = faster(g, applyLoras(g, model, input.loras), input, ctx);
  const byHand = input.schedule !== BY_STEPS;
  // the live preview, without sound: the node plays it for H3 alone (seen on a real render: an audio VAE given here is not used)
  const previewed = (m: Ref): Ref => livePreview(g, ctx, m, input.livePreview);
  // the full model: with LTX's own 8 steps the distilled LoRA goes on the whole render at half strength, as
  // ComfyUI's template has it; with By steps the dev model samples on its own schedule and the LoRA refines only
  const lora = !picked.distilled && slots.turbo ? slots.turbo : undefined;
  // the model without the LoRA is only sampled with when there is no LoRA, or By steps is off (the first pass runs on it)
  const plain = lora && byHand ? null : previewed(model);
  const boosted = lora ? previewed(g.out("LoraLoaderModelOnly", { model, lora_name: lora, strength_model: input.loraStrength })) : plain!;
  return { model: boosted, first: byHand ? boosted : plain!, clip, vae, audioVae, lora };
}

/** What every pass of a render takes: the model, the conditioning, the sampler, the empty sound, the schedule of the first pass, and the passes so far. */
interface LtxRun {
  spec: LtxSpec;
  g: GraphBuilder;
  ctx: BuildContext;
  input: LtxVideo;
  loaded: ReturnType<typeof ltxLoad>;
  cond: string;
  sampler: Ref;
  sound: Ref;
  sigmas: (latent: Ref) => Ref;
  steps: number;
  frame: { width: number; height: number; frames: number };
  passes: Array<{ node: string; steps: number }>;
  /** The clip before's last frames, as handed over, and how many: the clip opens on them. Null when it starts on its own. */
  previous: Ref | null;
  head: number;
  /** The clip opens on its first-frame picture (not when it carries on from a clip: that one's frames open it). */
  opens: boolean;
}

/** The guider of a pass: CFG on the conditioning, or 2.5's dual CFG with the video and the sound at the same scale. */
function guiderOf(run: LtxRun, model: Ref, positive: Ref, negative: Ref): Ref {
  const { spec, g, input } = run;
  return spec.guider === "dual"
    ? g.out("LTXVDualCFGGuider", { model, positive, negative, video_cfg: input.cfg, audio_cfg: input.cfg })
    : g.out("CFGGuider", { model, positive, negative, cfg: input.cfg });
}

/**
 * The guides on a pass's latent, at that pass's size: the clip before's frames at frame 0, then the keyframe at its moment.
 * Frames added to the clip, taken out again once the pass is sampled (LTXVCropGuides), so that they are neither enlarged as
 * part of the clip nor decoded with it.
 */
function guided(run: LtxRun, on: Ref, wide: number, high: number, opening?: string): { positive: Ref; negative: Ref; latent: Ref; any: boolean } {
  const { spec, g, ctx, input, cond, loaded } = run;
  let positive: Ref = [cond, 0];
  let negative: Ref = [cond, 1];
  let latent = on;
  const add = (image: Ref, at: number, strength: number) => {
    const added = g.add("LTXVAddGuide", { positive, negative, vae: loaded.vae, latent, image, frame_idx: at, strength });
    positive = [added, 0];
    negative = [added, 1];
    latent = [added, 2];
  };
  if (run.previous) add(ltxGuideFrames(g, input, run.previous, wide, high), 0, CARRY_STRENGTH);
  // the first picture as a guide (the one-pass route; the two-pass one puts it in the latent itself)
  else if (opening) add(ltxFrame(g, input, opening, wide, high), 0, input.startStrength);
  if (input.mid) add(ltxFrame(g, input, ctx.uploads.mid, wide, high), midFrame(input, spec.fps, run.frame.frames, run.head), input.midStrength);
  return { positive, negative, latent, any: Boolean(run.previous || opening || input.mid) };
}

/**
 * Two passes: the first at half the size, where the whole clip is decided, picture and sound; then the clip
 * enlarged ×2 in latent space and refined in a few steps, the sound of the first pass kept.
 */
function ltxTwoPass(run: LtxRun): { video: Ref; audio: Ref } {
  const { g, ctx, input, loaded, sampler, sound, frame, passes } = run;
  const { vae } = loaded;
  const { width, height, frames } = frame;
  const w = width / 2;
  const h = height / 2;
  let latent: Ref = g.out("EmptyLTXVLatentVideo", { width: w, height: h, length: frames, batch_size: 1 });
  if (run.opens) latent = g.out("LTXVImgToVideoInplace", { vae, image: ltxFrame(g, input, ctx.uploads.start, w, h), latent, strength: input.startStrength, bypass: false });
  // the clip before's frames and the keyframe are guides in each pass, at that pass's size (see guided)
  const cropped = (by: { positive: Ref; negative: Ref; any: boolean }, sampled: Ref): Ref => (by.any ? [g.add("LTXVCropGuides", { positive: by.positive, negative: by.negative, latent: sampled }), 2] : sampled);
  const half = guided(run, latent, w, h);
  g.phase("sampling");
  const first = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
    guider: guiderOf(run, loaded.first, half.positive, half.negative),
    sampler, sigmas: run.sigmas(half.latent),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: half.latent, audio_latent: sound }),
  });
  passes.push({ node: first, steps: run.steps });
  const made = g.add("LTXVSeparateAVLatent", { av_latent: [first, 0] });
  const decided = cropped(half, [made, 0]);

  g.phase("upscaling");
  let large: Ref = g.out("LTXVLatentUpsampler", { samples: decided, upscale_model: g.out("LatentUpscaleModelLoader", { model_name: ctx.slots.upscaler }), vae });
  // the opening picture again, at full size and at full strength: the first frame is the picture itself
  if (run.opens) large = g.out("LTXVImgToVideoInplace", { vae, image: ltxFrame(g, input, ctx.uploads.start, width, height), latent: large, strength: 1, bypass: false });
  const full = guided(run, large, width, height);
  g.phase("refining");
  const refine = refineStepsOf(input, frames);
  const second = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed + 1 }),
    guider: guiderOf(run, loaded.model, full.positive, full.negative),
    sampler, sigmas: g.out("ManualSigmas", { sigmas: refineSigmas(input.refineStrength, refine) }),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: full.latent, audio_latent: [made, 1] }),
  });
  passes.push({ node: second, steps: refine });
  const done = g.add("LTXVSeparateAVLatent", { av_latent: [second, 0] });
  return { video: cropped(full, [done, 0]), audio: [done, 1] };
}

/** One pass at full size, the pictures given as guides at the first and the last frame, and the keyframe at its own. */
function ltxOnePass(run: LtxRun): { video: Ref; audio: Ref } {
  const { g, ctx, input, loaded, sampler, sound, frame, passes } = run;
  const { width, height, frames } = frame;
  // the clip before's frames at frame 0, else the first picture; then the keyframe; then the last picture
  let { positive, negative, latent, any } = guided(run, g.out("EmptyLTXVLatentVideo", { width, height, length: frames, batch_size: 1 }), width, height, run.opens ? ctx.uploads.start : undefined);
  const guide = (upload: string | undefined, at: number, strength: number) => {
    const added = g.add("LTXVAddGuide", { positive, negative, vae: loaded.vae, latent, image: ltxFrame(g, input, upload, width, height), frame_idx: at, strength });
    positive = [added, 0];
    negative = [added, 1];
    latent = [added, 2];
    any = true;
  };
  // -1 is still the clip's last frame after the keyframe's guide: ComfyUI counts back from the clip without the guide frames added to it
  if (input.end) guide(ctx.uploads.end, -1, input.endStrength);
  g.phase("sampling");
  const only = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
    guider: guiderOf(run, loaded.model, positive, negative),
    sampler, sigmas: run.sigmas(latent),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: latent, audio_latent: sound }),
  });
  passes.push({ node: only, steps: run.steps });
  const done = g.add("LTXVSeparateAVLatent", { av_latent: [only, 0] });
  // the guides are frames added to the clip: they are taken out again before it is decoded
  return { video: any ? [g.add("LTXVCropGuides", { positive, negative, latent: [done, 0] }), 2] : [done, 0], audio: [done, 1] };
}

/** Twice the frames with LTX's temporal upscaler: the latent's frames doubled (the sound untouched), then a short pass settles them. */
function ltxTemporal(run: LtxRun, made: { video: Ref; audio: Ref }): { video: Ref; audio: Ref } {
  const { g, ctx, loaded, cond, sampler, passes } = run;
  g.phase("interpolating");
  const doubled = g.out("LTXVLatentUpsampler", { samples: made.video, upscale_model: g.out("LatentUpscaleModelLoader", { model_name: ctx.slots.temporal }), vae: loaded.vae });
  const settled = g.add("SamplerCustomAdvanced", {
    noise: g.out("RandomNoise", { noise_seed: ctx.seed + 2 }),
    guider: guiderOf(run, loaded.model, [cond, 0], [cond, 1]),
    sampler, sigmas: g.out("ManualSigmas", { sigmas: refineSigmas(0.5, 2) }),
    latent_image: g.out("LTXVConcatAVLatent", { video_latent: doubled, audio_latent: made.audio }),
  });
  passes.push({ node: settled, steps: 2 });
  const apart = g.add("LTXVSeparateAVLatent", { av_latent: [settled, 0] });
  return { video: [apart, 0], audio: [apart, 1] };
}

/** The recipe of a version of LTX, from its spec. */
export function ltxRecipe(spec: LtxSpec): Recipe<LtxVideo> {
  const { fps } = spec;
  return defineRecipe<LtxVideo>({
    // RIFE when the frames are interpolated with it: asked for, or Auto without LTX's temporal upscaler (or with SeedVR2,
    // which takes RIFE after it), as the build below picks. The temporal upscaler when it is asked for by name (Auto does
    // without it), and SeedVR2's files for its upscale: the build refuses either missing
    needsWith: (input, slots = {}) => [
      ...rifeNeeds(input.smooth && input.smoothWith !== SMOOTH_LTX && (input.smoothWith === SMOOTH_RIFE || !slots.temporal || (input.smoothWith === SMOOTH_AUTO && input.upscale === UPSCALE.seedvr))),
      ...(input.smooth && input.smoothWith === SMOOTH_LTX ? ["temporal"] : []),
      ...upscaleNeeds(input),
    ],
    id: spec.id,
    family: spec.family,
    version: 1,
    title: spec.title,
    summary: spec.summary,
    output: "video",
    traits: {
      startFrame: true, endFrame: true, midFrames: true, continues: "clip", endAnchor: false, sound: true,
      fps, frameGrid: { step: 8, offset: 1 },
    },
    inputs: [
      {
        id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: spec.modelMatch,
        note: spec.loader === "checkpoint" ? "a diffusion model in a file of its own (a fine-tune, usually). Left alone with none there, the one checkpoint is used" : "the diffusion model: the distilled one, or a fine-tune of it",
      },
      {
        id: "prompt", type: "prompt", label: "Prompt", style: "sentences",
        placeholder: "A medium close-up. She turns to the camera and says quietly: \"What a view.\" Wind, and waves far below.",
      },
      { id: "start", type: "image", role: "start", label: "First frame", note: "the first frame", optional: true },
      {
        id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: LTX_JOIN_FRAMES, fps, advanced: true,
        note: "the clip this one carries on from: its last second (25 frames) opens this clip as a guide, so that the motion carries over, not only the last picture. On a timeline those frames are hidden, the clip plays from its own. A first frame is not used with it",
      },
      { id: "end", type: "image", role: "end", label: "Last frame", note: "the last frame. With one, the clip is made in one pass at full size", optional: true },
      { id: "mid", type: "image", role: "mid", at: "midAt", label: "Keyframe", note: "a picture the clip passes through, at the time set below", optional: true, advanced: true },
      { id: "midAt", type: "number", label: "Keyframe at", min: 0.5, max: 19.5, step: 0.5, default: 2.5, unit: " s", showWhen: "mid", advanced: true, note: "snapped to the model's 8-frame steps (about a third of a second)" },
      { id: "seconds", type: "number", label: "Duration", min: 1, max: 20, step: 0.5, default: 5, unit: " s" },
      {
        id: "shape", type: "size", label: "Aspect ratio", default: "wide", grid: 64, min: 256, max: 1920, ratioOnly: true,
        short: "short", maxPixels: LTX_MAX_PIXELS, decidedBy: ["start", "end", "mid"], scaledBy: { on: "upscale", by: "upscaleBy" },
        note: "a start image decides the shape instead",
        shapes: [
          { id: "tall", label: "Tall", width: 704, height: 1280 },
          { id: "square", label: "Square", width: 960, height: 960 },
          { id: "wide", label: "Wide", width: 1280, height: 704 },
        ],
      },
      { id: "short", type: "number", label: "Resolution", note: "the short side of the frame: 704 is about 720p, 1088 about 1080p. Larger is sharper and much slower", min: 384, max: 1088, step: 64, default: 704, unit: "p", picks: [512, 704, 832, 1088] },
      ...upscaleInputs(),
      ...COLOUR_MATCH_INPUTS,
      {
        id: "twoPass", type: "toggle", label: "Two-pass (latent upscale)", default: true, advanced: true,
        note: "half the size first, enlarged with the latent upscaler, then 3 steps that refine: faster and sharper. Off, or without the upscaler, or with an end image: one pass at full size. A keyframe guides both passes",
      },
      {
        id: "refineStrength", type: "number", label: "Refine denoise", min: 0.3, max: 1, step: 0.05, default: 0.85, showWhen: "twoPass", advanced: true,
        note: "where the refining pass starts: 0.85 is LTX's own. Lower keeps the enlarged clip closer to the first pass, higher lets it change more",
      },
      { id: "refineSteps", type: "number", label: "Refine steps", note: "3 is LTX's own; left at 3, a clip past 241 frames (9.6 s) takes 4, which users find the enlarged clip needs. Another count is taken as typed", min: 1, max: 8, step: 1, default: 3, showWhen: "twoPass", advanced: true },
      {
        id: "turboIn", type: "choice", label: "Distilled model", options: ["From the name", "Yes", "No"], renamed: { Auto: "From the name" }, default: "From the name", advanced: true, section: "rare", perModel: true,
        note: "made for 8 steps as it is: no distilled LoRA is added. From the name: when it says distilled, turbo, lightning or a step count",
      },
      {
        id: "schedule", type: "choice", label: "Schedule", options: [OWN_SCHEDULE, BY_STEPS], default: OWN_SCHEDULE, advanced: true, perModel: true,
        note: "LTX's own is the 8 steps its authors give for the distilled model. By steps: LTX's scheduler at a number of steps, for the full (dev) model, which ComfyUI's template runs at 20 steps and CFG 4, the distilled LoRA refining only",
      },
      { id: "steps", type: "number", label: "Steps", note: "20 in ComfyUI's template for the dev model", min: 2, max: 50, step: 1, default: 20, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      {
        id: "maxShift", type: "number", label: "Max shift", min: 0, max: 10, step: 0.05, default: 2.05, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true,
        note: "LTX's scheduler shifts its schedule by the size of the clip, between the base shift (small clips) and this (large ones): 2.05 and 0.95 are the model's own",
      },
      { id: "baseShift", type: "number", label: "Base shift", min: 0, max: 10, step: 0.05, default: 0.95, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      { id: "terminal", type: "number", label: "Terminal sigma", note: "where the schedule ends: 0.1 is the model's own; lower runs it further towards a clean clip", min: 0, max: 0.99, step: 0.01, default: 0.1, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      { id: "stretch", type: "toggle", label: "Stretch the schedule", note: "the schedule stretched so that it ends at the terminal sigma, as the model's own does", default: true, showWhen: { input: "schedule", in: [BY_STEPS] }, advanced: true, perModel: true },
      {
        id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true,
        note: spec.guider === "dual"
          ? "1 for the distilled model and LTX's own schedule, on the picture and the sound alike (the model's dual guider); 3 to 4 with By steps on the dev model. Above 1 the negative prompt acts and every step takes twice as long"
          : "1 for a distilled model and LTX's own schedule; 3 to 4 with By steps on the dev model (ComfyUI's template: 4). Above 1 the negative prompt acts and every step takes twice as long",
      },
      { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, default: spec.sampler, advanced: true, perModel: true, note: `${spec.sampler} is what ${spec.name}'s own template runs` },
      {
        id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, advanced: true, perModel: true,
        default: "blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, pc game, console game, video game, cartoon, childish, ugly",
        note: spec.nag ? "acts with a CFG scale above 1, or at 1 through NAG" : "acts with a CFG scale above 1",
      },
      ...(spec.nag
        ? [
            {
              id: "nag", type: "toggle", label: "NAG", default: false, advanced: true, perModel: true,
              note: "Normalized Attention Guidance: the negative prompt acts at CFG 1, where it is otherwise ignored, at little cost. Needs KJNodes. Off by default: untried on LTX by its authors",
            } as const,
            { id: "nagScale", type: "number", label: "NAG scale", min: 1, max: 30, step: 0.5, default: 11, showWhen: "nag", advanced: true, perModel: true, note: "how hard the negative pushes: 11 is its authors' value" } as const,
          ]
        : []),
      { id: "startStrength", type: "number", label: "First frame strength", min: 0.1, max: 1, step: 0.05, default: 0.7, showWhen: "start", advanced: true, note: "lower lets the first frames move away from the picture sooner" },
      { id: "endStrength", type: "number", label: "Last frame strength", min: 0.1, max: 1, step: 0.05, default: 0.7, showWhen: "end", advanced: true },
      {
        id: "midStrength", type: "number", label: "Keyframe strength", min: 0.1, max: 1, step: 0.05, default: 0.8, showWhen: "mid", advanced: true,
        note: "how closely the clip holds the keyframe at its moment: lower lets it pass near the picture rather than through it",
      },
      {
        id: "compression", type: "number", label: "Input CRF", min: 0, max: 50, step: 1, default: 18, advanced: true,
        note: "the start, keyframe and end pictures are compressed like a video frame before the model sees them: a picture that is too clean gives a clip that does not move. 0 leaves them as they are",
      },
      {
        id: "loraStrength", type: "number", label: "Distilled LoRA strength", min: 0, max: 1.5, step: 0.05, default: 0.5, advanced: true, perModel: true,
        note: "only for a model that is not distilled: how strongly the distilled LoRA is put on it. 0.5 is what ComfyUI's template uses with LTX's own schedule; with By steps the LoRA refines only, at 1 in the template",
      },
      { id: "tile", type: "number", label: "VAE decode tile size", note: `the clip is turned into pictures piece by piece: smaller pieces need less memory and take longer. ${spec.decode.tile} is the template's`, min: 256, max: 2048, step: 32, default: spec.decode.tile, unit: " px", advanced: true },
      { id: "tileFrames", type: "number", label: "VAE decode temporal tile", note: `fewer needs less memory. 4096 is all of them at once; ${spec.decode.frames} is the template's`, min: 16, max: 4096, step: 8, default: spec.decode.frames, advanced: true },
      { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
      {
        id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
        note: "while it renders, a short clip of what is forming, each step, without its sound. Without it the preview is one still frame: the start image. A small cost per step. Needs the KJNodes pack",
      },
      ...SPEED_INPUTS,
      { id: "smooth", type: "toggle", label: "Interpolate ×2", note: `frame interpolation, from ${fps} to ${fps * 2} frames a second: with LTX's own temporal upscaler in latent space when its file is there (motion-aware, then a short refine), else RIFE on the pixels`, default: false, advanced: true },
      {
        id: "smoothWith", type: "choice", label: "Interpolate with", options: [SMOOTH_AUTO, SMOOTH_LTX, SMOOTH_RIFE], default: SMOOTH_AUTO, showWhen: "smooth", advanced: true,
        note: "Auto takes LTX's temporal upscaler when its file is there, else RIFE. The temporal upscaler doubles the latent's frames and a 2-step pass settles them: experimental, the refine after it is not Lightricks' published setting",
      },
      { id: "loras", type: "loras", label: "LoRAs", max: 6 },
      { id: "seed", type: "seed", label: "Seed" },
    ],

    nodes(input) {
      const routeNodes = upscaleNodes(input);
      return [
        ...routeNodes,
        "CLIPTextEncode", "LTXVConditioning", "EmptyLTXVLatentVideo", "LTXVEmptyLatentAudio", "LTXVConcatAVLatent", "LTXVSeparateAVLatent",
        "RandomNoise", "KSamplerSelect", spec.guider === "dual" ? "LTXVDualCFGGuider" : "CFGGuider", "SamplerCustomAdvanced", "VAEDecodeTiled", "LTXVAudioVAEDecode", ...speedNodes(input),
        ...(input.model ? unetNodes(input.model).filter((n) => n !== "UNETLoader") : []),
        ...(spec.loader === "split" ? ["UNETLoader", "CLIPLoader", "VAELoader"] : []),
        ...(input.schedule === BY_STEPS ? ["LTXVScheduler"] : []),
        ...((input.start && !input.previous) || input.end || input.mid ? ["LoadImage", "ImageScale", "LTXVPreprocess"] : []),
        ...(input.previous ? ["LoadVideo", "GetVideoComponents", "ImageScale", "LTXVPreprocess"] : []),
      ];
    },
    // which loaders, and which way the clip is made, depend on the files this ComfyUI has
    optionalNodes: [...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, ...COLOUR_MATCH_NODES,
      // 2.3's loaders depend on which files are there (one checkpoint, or split files); 2.5's are always its split files' (nodes)
      ...(spec.loader === "checkpoint" ? ["UNETLoader", "DualCLIPLoader", "VAELoader", "CheckpointLoaderSimple", "LTXVAudioVAELoader", "LTXAVTextEncoderLoader"] : []),
      "LoraLoaderModelOnly",
      "LatentUpscaleModelLoader", "LTXVLatentUpsampler", "LTXVImgToVideoInplace", "LTXVAddGuide", "LTXVCropGuides", "ManualSigmas",
      "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ", ...(spec.nag ? ["LTX2_NAG"] : []),
    ],

    build(input, ctx) {
      const { slots, media } = ctx;
      const picked = modelOf(spec, input, slots);
      const how = uses(input, slots);
      if (!picked.unet && !picked.checkpoint) throw new Error(spec.missing.model);
      if (picked.unet && (!slots.videoVae || !slots.audioVae || (spec.loader === "checkpoint" && !slots.projection))) throw new Error(spec.missing.parts);

      // the frame: a timeline's canvas, else the clip it carries on from, else the picture it opens or ends on (or its keyframe,
      // when it has no other), else the shape picked. A canvas is taken at its own size up to the model's 720p (LTX_CANVAS_SHORT),
      // as Wan's is up to its 720p: a clip at a 1080p timeline's size was 1088p, slower and no better (users put LTX's sweet spot
      // at 720p; the owner, 2026-10-15)
      const opens = Boolean(input.start) && !input.previous;
      const like = input.previous ? media.previous : opens ? media.start : input.end ? media.end : input.mid ? media.mid : undefined;
      const { width, height } = ctx.canvas
        ? ltxCanvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height, LTX_CANVAS_SHORT))
        : like?.width
          ? ltxCanvas(like.width, like.height, input.short)
          : ltxCanvas(input.shape.width, input.shape.height, input.short);
      // the frames shared with the clip before are that clip's: the clip is made that much longer, within the 20 s the model takes
      const head = input.previous ? headFramesOf(media.previous) : 0;
      const frames = ltxFramesAt(Math.min(input.seconds, LTX_MAX_SECONDS - head / fps) + head / fps, fps);

      const g = new GraphBuilder();
      const loaded = ltxLoad(spec, g, ctx, input, picked);
      const byHand = input.schedule !== BY_STEPS;
      const steps = byHand ? LTX_SIGMAS.split(",").length - 1 : input.steps;
      const cond = g.add("LTXVConditioning", {
        positive: g.out("CLIPTextEncode", { clip: loaded.clip, text: input.prompt }),
        negative: g.out("CLIPTextEncode", { clip: loaded.clip, text: input.negative }),
        frame_rate: fps,
      });
      // At CFG 1 the negative prompt is never read. NAG (KJNodes' LTX2_NAG, its authors' alpha and tau) puts it back
      // inside the attention, on every model the passes sample with. Off by default: one tester found it still let
      // text overlays through on dialogue-heavy prompts, and nothing LTX-specific has been published for it.
      if (spec.nag && input.nag && input.cfg <= 1 && input.negative.trim() !== "" && ctx.has("LTX2_NAG")) {
        const nag = (model: Ref): Ref => g.out("LTX2_NAG", { model, nag_scale: input.nagScale, nag_alpha: 0.25, nag_tau: 2.5, nag_cond_video: [cond, 1], inplace: true });
        const same = loaded.first === loaded.model;
        loaded.model = nag(loaded.model);
        loaded.first = same ? loaded.model : nag(loaded.first);
      }
      const run: LtxRun = {
        spec, g, ctx, input, loaded, cond, steps, frame: { width, height, frames }, passes: [], head, opens,
        // the clip before's last frames as handed over (cut by the server to LTX_JOIN_FRAMES at the model's rate)
        previous: input.previous ? [g.add("GetVideoComponents", { video: g.out("LoadVideo", { file: ctx.uploads.previous }) }), 0] : null,
        sampler: g.out("KSamplerSelect", { sampler_name: input.sampler }),
        sound: g.out("LTXVEmptyLatentAudio", { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: loaded.audioVae }),
        // By steps: LTX's own scheduler, shifted by the size of the latent it is given
        sigmas: (latent) => (byHand ? g.out("ManualSigmas", { sigmas: LTX_SIGMAS }) : g.out("LTXVScheduler", { steps, max_shift: input.maxShift, base_shift: input.baseShift, stretch: input.stretch, terminal: input.terminal, latent })),
      };
      let made = how.twoPass ? ltxTwoPass(run) : ltxOnePass(run);

      // twice the frames: LTX's temporal upscaler doubles the latent's frames; else RIFE on the decoded pictures
      const canTemporal = Boolean(slots.temporal) && ctx.has("LTXVLatentUpsampler") && ctx.has("LatentUpscaleModelLoader");
      if (input.smooth && input.smoothWith === SMOOTH_LTX && !canTemporal) throw new Error(`LTX's temporal upscaler was not found: put ${spec.temporalFile} in ComfyUI's models/latent_upscale_models folder (one click in Settings → Models), or interpolate with RIFE.`);
      // Auto with SeedVR2: RIFE after it, not the latent doubling before it (SeedVR2 would restore twice the frames); asked for, as asked
      const temporal = input.smooth && input.smoothWith !== SMOOTH_RIFE && canTemporal && !(input.smoothWith === SMOOTH_AUTO && input.upscale === UPSCALE.seedvr);
      if (temporal) made = ltxTemporal(run, made);
      g.phase("decoding");
      const images = g.out("VAEDecodeTiled", { samples: made.video, vae: loaded.vae, tile_size: input.tile, overlap: 64, temporal_size: input.tileFrames, temporal_overlap: spec.decode.overlap });
      const heard = g.out("LTXVAudioVAEDecode", { samples: made.audio, audio_vae: loaded.audioVae });
      const done = finishFrames(g, ctx, colourMatched(g, ctx, images, openingStart(input)), input, { frame: { width, height }, rife: input.smooth && !temporal, fps, audio: heard, doubled: temporal });
      const unsmoothed = rifeSkippedSaid(input.smooth && !temporal, ctx);

      return {
        ...(unsmoothed ? { warnings: [unsmoothed] } : {}),
        graph: g.graph,
        phases: g.phases,
        outputs: [{ node: done.out, kind: "video", role: "result" }],
        totalSteps: run.passes.reduce((n, p) => n + p.steps, 0),
        passes: run.passes,
        // a continuation counts its frames as an extension and an overlap: hidden on a timeline, faded over the clip before (a
        // join on pixels, as joinKindOf reads it)
        frames,
        ...(head ? { overlap: { headMs: Math.round((head / fps) * 1000), tailMs: 0 } } : {}),
        loads: [
          ...done.loads,
          ...(picked.unet
            ? [`diffusion_models/${picked.unet}`, `text_encoders/${slots.clip}`, ...(spec.loader === "checkpoint" ? [`text_encoders/${slots.projection}`] : []), `vae/${slots.videoVae}`, `vae/${slots.audioVae}`]
            : [`checkpoints/${picked.checkpoint}`, `text_encoders/${slots.clip}`]),
          ...(how.twoPass ? [`latent_upscale_models/${slots.upscaler}`] : []),
          ...(temporal ? [`latent_upscale_models/${slots.temporal}`] : []),
          ...(loaded.lora ? [`loras/${loaded.lora}`] : []),
          ...loraLoads(input.loras),
        ],
      };
    },

    variants: spec.variants,
  });
}
