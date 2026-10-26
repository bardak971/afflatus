import { defineRecipe, GraphBuilder, type BuildContext, type ClipValue, type LoraValue, type Ref, type SizeValue, type Variant } from "@afflatus/core";
import { WAN_FORM_PIXELS, WAN_FPS, wanCanvas, wanFrames } from "./family";
import { UPSCALE_OPTIONAL, upscaleInputs, upscaleNeeds, upscaleNodes } from "../video/upscale";
import { colourMatched, COLOUR_MATCH_INPUTS, COLOUR_MATCH_NODES, finishFrames, openingStart, rifeNeeds, rifeRuns, rifeSkippedSaid, type ColourMatch } from "../shared/finish";
import { previousFrames } from "../motion/driving";
import { applyLoras, livePreview, loraLoads } from "../shared/model";
import { faster, SPEED_INPUTS, speedNodes, type SpeedSettings } from "../shared/speed";
import { loadUnet, unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, VHS } from "../shared/out";
import { recordingInputs, recordingNodes, recordingOnClip, type Recording, type RecordingFrames } from "../shared/recording";
import { FACE_NODE, FACE_PHOTO, facePhotos, faceScore } from "../shared/face";

/**
 * Wan's own negative prompt, as its authors give it (in Chinese: washed-out colours, overexposure, a
 * still picture, blurred detail, subtitles, bad hands and faces, extra limbs, a cluttered background,
 * walking backwards). It only acts above CFG 1, and with Turbo through NAG.
 */
export const WAN_NEGATIVE = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

/**
 * What a Wan clip under a recording holds of it (card #82): its part at Wan's 16 a second, on its frame grid, 1 to 15 s (a
 * recording is cut into parts for Lip sync's clips, up to 15 s; Wan is made for about 5, and drifts on longer ones).
 */
export const WAN_RECORDING: RecordingFrames = { fps: WAN_FPS, frames: wanFrames(15), min: 1, most: 15, grid: { step: 4, offset: 1 } };

export interface WanVideo extends ColourMatch, Partial<Recording> {
  model?: string;
  modelLow?: string;
  turboIn: string;
  prompt: string;
  negative: string;
  start?: string;
  /** The cast person's picture the take is scored against (Wan takes no reference pictures). */
  facePhoto?: string;
  end?: string;
  previous?: ClipValue;
  seconds: number;
  shape: SizeValue;
  short: number;
  fast: boolean;
  turboSteps: number;
  turboStrength: number;
  turboHybrid: boolean;
  nag: boolean;
  nagScale: number;
  steps: number;
  split: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  shift: number;
  smooth: boolean;
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
  livePreview: boolean;
  sage: SpeedSettings["sage"];
  sageKernel: SpeedSettings["sageKernel"];
  compile: SpeedSettings["compile"];
  fps: number;
  crf: number;
  loras: LoraValue[];
  lorasLow: LoraValue[];
  seed: number;
}

/** What a fine-tune is, as far as its file name says: merges made for a few steps are named for it, or are known ones. */
// The fine-tune lines: "Lightspeed" is distilled, "TrueVision" is made for the full steps (20 to 30 at CFG 3.5), so the maker's name alone says nothing
const namedTurbo = /turbo|distill|lightning|lightx2v|lightspeed|rapid|smoothmix|(^|[^a-z0-9])\d+[ _-]?steps?/i;

/** Which way the clip is made: from words alone (the words-to-video models), or opening / ending on a picture (a clip it carries on from is one). */
const uses = (input: WanVideo) => ({ words: !input.start && !input.end && !input.previous, both: Boolean(input.end) });

/**
 * SVI 2.0 Pro (Stable Video Infinity, KJNodes' WanImageToVideoSVIPro): a clip carries on from the clip before in the latent.
 * Its first latent frame is pinned to an anchor picture (here the clip before's last frame), and the clip before's last
 * latent frame (`SVI_MOTION_LATENTS`: its last 4 frames) is handed over unpinned, as the motion to carry on. The clip's first
 * frames (`SVI_DROPPED`) are dropped, its next 4 are the clip before's last moments made again moving (kept as its head,
 * hidden on a timeline: the join fades over them as over a SCAIL-2 window's), and its own frames come after.
 */
const SVI_MOTION_LATENTS = 1;
/** The frames that remake the clip before's last ones: one latent frame's worth. */
const SVI_HEAD = 4 * SVI_MOTION_LATENTS;
/**
 * The frames dropped before the head: the anchor, and the one after it. Measured on a chain (card #82, 2026-10-25): with the
 * anchor alone dropped, every head frame matched the clip before's frame one earlier than its place, so its last moment
 * (about 60 ms) played twice at each join. The head starts one frame later, and ends on that clip's last frame made again.
 */
const SVI_DROPPED = 2;
/**
 * The frames of the clip before handed over: 9, encoded as 3 latent frames, the last of which is the motion carried (the VAE
 * is causal: a few frames before it bring that latent closer to the clip's own); 5 for a clip too short.
 */
const SVI_FRAMES = [9, 5];

/**
 * How a clip that carries on from the clip before is made: through SVI 2.0 Pro when its LoRAs and its node are there, else
 * opened on the clip before's last frame, still (a cut), with why. Null for a clip that carries on from nothing.
 */
function carryOf(input: WanVideo, ctx: Pick<BuildContext, "slots" | "uploads" | "has">): { svi: true } | { svi: false; why: string; still: boolean } | null {
  if (!input.previous || !ctx.uploads.previous) return null;
  const cut = "A cut: this clip opens on the clip before's last frame, still";
  if (input.end) return { svi: false, still: false, why: `${cut}, as SVI 2.0 Pro takes no last frame and this clip ends on one.` };
  if (!ctx.slots.sviHigh || !ctx.slots.sviLow) return { svi: false, still: true, why: `${cut}: SVI 2.0 Pro's two LoRAs, which carry the motion on, are not on this ComfyUI (models/loras; Settings › Models has them).` };
  if (!ctx.has("WanImageToVideoSVIPro")) return { svi: false, still: true, why: `${cut}: this ComfyUI has no WanImageToVideoSVIPro node, which carries the motion on (a newer KJNodes has it).` };
  return { svi: true };
}

/**
 * A clip made through SVI 2.0 Pro (its anchor frame dropped), its colours brought to where the clip before ends: one transform
 * for every frame (ComfyUI's ColorTransfer), the one that takes its head's last frame (that clip's last moment, made again) to
 * that clip's last frame as handed over. SVI shifts the colours a little at each clip, a step at every join that adds up along
 * a chain (users' reports); one transform takes the step away and keeps the light changes the clip itself makes. Without the
 * node, as it is (said on the job).
 */
function sviColours(g: GraphBuilder, ctx: Pick<BuildContext, "has">, images: Ref, before: Ref): Ref {
  if (!ctx.has("ColorTransfer")) return images;
  const last = g.out("ImageFromBatch", { image: before, batch_index: -1, length: 1 });
  return g.out("ColorTransfer", { image_target: images, image_ref: last, method: "reinhard_lab", source_stats: "target_frame", "source_stats.target_index": SVI_HEAD - 1, strength: 1 });
}

/** What a Wan model is made for, when its file name says: opening on a picture (I2V), or words alone (T2V). */
const madeFor = (file: string | undefined): "picture" | "words" | undefined => {
  const name = file?.split(/[\\/]/).pop() ?? "";
  if (/i2v|img2vid|image.?to.?video|flf2v/i.test(name)) return "picture";
  if (/t2v|txt2vid|text.?to.?video/i.test(name)) return "words";
  return undefined;
};

/**
 * The two models the clip is made with, and whether they are made for a few steps as they are. Left
 * alone, they are the usual files of the way the clip is made. A model picked on the form is used when
 * it is made for that way, or does not say: a picture-to-video model given no picture makes a flat gray
 * clip, and a words-to-video model does not look at the picture, so the usual files of the way take the
 * place of a model made for the other one (and without them, nothing is rendered: see build).
 */
const modelsOf = (input: WanVideo, slots: Record<string, string>) => {
  const words = uses(input).words;
  const way = words ? "words" : "picture";
  const fits = (file: string | undefined) => (file && (madeFor(file) ?? way) === way ? file : undefined);
  const high = fits(input.model) ?? (words ? slots.t2vHigh : slots.i2vHigh);
  const low = fits(input.modelLow) ?? (words ? slots.t2vLow : slots.i2vLow);
  const name = high?.split(/[\\/]/).pop() ?? "";
  const distilled = input.turboIn === "Yes" || (input.turboIn !== "No" && namedTurbo.test(name));
  return { high, low, distilled, turboHigh: words ? slots.t2vTurboHigh : slots.i2vTurboHigh, turboLow: words ? slots.t2vTurboLow : slots.i2vTurboLow };
};
type WanModels = ReturnType<typeof modelsOf> & { high: string; low: string };

/**
 * The two models, each with its LoRAs, the speed-ups, the shift and the live preview, and the high-noise one
 * again without its turbo LoRA for the hybrid turbo pass. Turbo: the two lightx2v LoRAs, unless the model is made
 * for a few steps as it is. Without their files (and with a model that is not distilled) there is no Turbo: the
 * clip takes the full steps.
 */
function wanLoad(g: GraphBuilder, ctx: BuildContext, input: WanVideo, picked: WanModels, svi: { high: string; low: string } | null) {
  const turboLoras = input.fast && !picked.distilled && picked.turboHigh && picked.turboLow ? { high: picked.turboHigh, low: picked.turboLow } : null;
  const turbo = input.fast && (picked.distilled || Boolean(turboLoras));
  // the form's shift: 8 at full steps (the template's), and Turbo starts it on 5, what the lightx2v LoRAs are made for
  const shift = input.shift;
  // the live preview shows the clip forming; ComfyUI's own preview is the first frame alone: the start image, still
  const finish = (model: Ref): Ref => livePreview(g, ctx, g.out("ModelSamplingSD3", { model: faster(g, model, input, ctx), shift }), input.livePreview);
  /**
   * The model with its LoRAs, and the same model with the user's LoRAs but without the turbo one (for the hybrid pass). SVI 2.0
   * Pro's LoRA, for a clip that carries on through it, goes on first, under the turbo one and on the hybrid pass's model too.
   */
  const load = (file: string, sviLora: string | undefined, turboLora: string | undefined, strength: number, loras: LoraValue[]) => {
    const unet = loadUnet(g, ctx, file);
    const base = sviLora ? g.out("LoraLoaderModelOnly", { model: unet, lora_name: sviLora, strength_model: 1 }) : unet;
    const boosted = applyLoras(g, turboLora ? g.out("LoraLoaderModelOnly", { model: base, lora_name: turboLora, strength_model: strength }) : base, loras);
    return { model: finish(boosted), plain: turboLora && input.turboHybrid ? finish(applyLoras(g, base, loras)) : null };
  };
  const high = load(picked.high, svi?.high, turboLoras?.high, input.turboStrength, input.loras);
  const low = load(picked.low, svi?.low, turboLoras?.low, 1, input.lorasLow).model;
  return { high: high.model, plain: high.plain, low, turbo, turboLoras, shift };
}

/**
 * The step at which the low-noise model takes over. A share typed in (split > 0) is taken as it is. Left at 0 (Auto), it is
 * where the noise level falls below the one Wan 2.2's two models were split at in training (0.9 for image to video,
 * 0.875 for text to video, as Wan's own code and KJ's SigmaToStep switch): the same step as half at the defaults, but it
 * follows a shift or a step count that is changed. Worked out on ComfyUI's simple / normal / sgm_uniform spacing of the
 * shifted flow sigmas (sigma = s·t / (1 + (s − 1)·t)); on another scheduler, half.
 */
export function wanHandover(steps: number, shift: number, scheduler: string, words: boolean, split: number): number {
  const clamp = (n: number) => Math.max(1, Math.min(steps - 1, n));
  if (split > 0) return clamp(Math.round(steps * split));
  if (!["simple", "normal", "sgm_uniform"].includes(scheduler)) return clamp(Math.round(steps / 2));
  const boundary = words ? 0.875 : 0.9;
  for (let i = 1; i < steps; i++) {
    const t = 1 - i / steps;
    if ((shift * t) / (1 + (shift - 1) * t) < boundary) return clamp(i);
  }
  return clamp(steps - 1);
}

/**
 * The texts, and the latent to fill: an empty one from words alone, else the first (and the last) picture, which the node resizes
 * to the canvas itself. A clip that carries on (`carried`, the clip before's frames as handed over): through SVI 2.0 Pro, those
 * frames at this clip's size, encoded, the last one the anchor and the last latent frame the motion; without it, the clip before's
 * last frame as the first frame.
 */
function wanLatent(g: GraphBuilder, ctx: BuildContext, input: WanVideo, frame: { width: number; height: number; frames: number }, clip: Ref, vae: Ref, carried: { frames: Ref; svi: boolean } | null) {
  const { width, height, frames } = frame;
  let positive: Ref = g.out("CLIPTextEncode", { clip, text: input.prompt });
  let negative: Ref = g.out("CLIPTextEncode", { clip, text: input.negative });
  const how = uses(input);
  if (how.words) return { positive, negative, latent: g.out("EmptyHunyuanLatentVideo", { width, height, length: frames, batch_size: 1 }) };
  if (carried?.svi) {
    const sized = g.out("ImageScale", { image: carried.frames, upscale_method: "lanczos", width, height, crop: "center" });
    const anchor = g.out("VAEEncode", { pixels: g.out("ImageFromBatch", { image: sized, batch_index: -1, length: 1 }), vae });
    const node = g.add("WanImageToVideoSVIPro", {
      positive, negative, length: frames, anchor_samples: anchor, prev_samples: g.out("VAEEncode", { pixels: sized, vae }), motion_latent_count: SVI_MOTION_LATENTS,
    });
    return { positive: [node, 0] as Ref, negative: [node, 1] as Ref, latent: [node, 2] as Ref };
  }
  const opening = carried ? g.out("ImageFromBatch", { image: carried.frames, batch_index: -1, length: 1 }) : input.start ? g.out("LoadImage", { image: ctx.uploads.start }) : null;
  const node = g.add(how.both ? "WanFirstLastFrameToVideo" : "WanImageToVideo", {
    positive, negative, vae, width, height, length: frames, batch_size: 1,
    ...(opening ? { start_image: opening } : {}),
    ...(input.end ? { end_image: g.out("LoadImage", { image: ctx.uploads.end }) } : {}),
  });
  positive = [node, 0];
  negative = [node, 1];
  return { positive, negative, latent: [node, 2] as Ref };
}

/**
 * Hybrid turbo's lead: the steps taken out of Turbo's own and run first on the high-noise model without its turbo LoRA, at
 * the full CFG scale, where the motion is decided. One of Turbo's 4 (two from 6), so the high-noise model with its LoRA keeps
 * one after it: 0.6.3's split, render-checked on 2026-10-11 (about a fifth more motion). 0.7.0 tried two steps added in front
 * of the 4 (a 6-step schedule); its clips ghosted, a double exposure from about 1.8 s (card #82, 2026-10-26), so the split is
 * back to this one.
 */
const turboLead = (steps: number, handover: number) => Math.min(handover - 1, steps >= 6 ? 2 : 1);

/**
 * Two passes over one schedule: the high-noise model makes the first steps and hands its latent, still noisy, to
 * the low-noise model, which finishes it. With the hybrid turbo pass (the 3-sampler split), Turbo's first step or two
 * (turboLead) run on the high-noise model without its turbo LoRA at the full CFG scale; then the LoRAs at CFG 1 as usual, on
 * the rest of the same schedule.
 */
function wanPasses(g: GraphBuilder, ctx: BuildContext, input: WanVideo, models: ReturnType<typeof wanLoad>, cond: { positive: Ref; negative: Ref; latent: Ref }) {
  const { positive, negative, latent } = cond;
  // At CFG 1 the negative prompt is never read. NAG puts it back inside the attention instead (KJNodes' WanVideoNAG,
  // at its authors' alpha and tau), on the two models Turbo runs at CFG 1; the hybrid lead runs at full CFG already.
  const nagged = models.turbo && input.nag && input.negative.trim() !== "" && ctx.has("WanVideoNAG");
  const nag = (model: Ref): Ref => (nagged ? g.out("WanVideoNAG", { model, conditioning: negative, nag_scale: input.nagScale, nag_alpha: 0.25, nag_tau: 2.5 }) : model);
  const high = nag(models.high);
  const low = nag(models.low);
  const steps = models.turbo ? input.turboSteps : input.steps;
  const cfg = models.turbo ? 1 : input.cfg;
  const handover = wanHandover(steps, models.shift, input.scheduler, uses(input).words, input.split);
  const lead = models.turbo && input.turboHybrid && models.plain ? turboLead(steps, handover) : 0;
  const passes: Array<{ node: string; steps: number }> = [];
  g.phase("sampling");
  let latentSoFar = latent;
  if (lead > 0) {
    const motion = g.add("KSamplerAdvanced", {
      model: models.plain!, positive, negative, latent_image: latentSoFar, add_noise: "enable", noise_seed: ctx.seed, steps, cfg: input.cfg,
      sampler_name: input.sampler, scheduler: input.scheduler, start_at_step: 0, end_at_step: lead, return_with_leftover_noise: "enable",
    });
    latentSoFar = [motion, 0];
    passes.push({ node: motion, steps: lead });
  }
  const first = g.add("KSamplerAdvanced", {
    model: high, positive, negative, latent_image: latentSoFar, add_noise: lead > 0 ? "disable" : "enable", noise_seed: lead > 0 ? 0 : ctx.seed, steps, cfg,
    sampler_name: input.sampler, scheduler: input.scheduler, start_at_step: lead, end_at_step: handover, return_with_leftover_noise: "enable",
  });
  passes.push({ node: first, steps: handover - lead });
  g.phase("refining");
  const second = g.add("KSamplerAdvanced", {
    model: low, positive, negative, latent_image: [first, 0], add_noise: "disable", noise_seed: 0, steps, cfg,
    sampler_name: input.sampler, scheduler: input.scheduler, start_at_step: handover, end_at_step: 10000, return_with_leftover_noise: "disable",
  });
  passes.push({ node: second, steps: steps - handover });
  return { sampled: second, passes, steps };
}

/**
 * Turbo's two LoRAs, when Turbo is on and the model picked is not made for a few steps (modelsOf): without them on the
 * machine the clip would take the full steps, as if Turbo were off (a pod was never sent them: 20 steps for 4, 2026-10-15).
 */
const turboNeeds = (input: WanVideo, slots: Record<string, string> = {}): string[] => {
  if (!input.fast) return [];
  // the high model the build loads: the one picked when it is made for this way, else the way's usual file
  const name = (modelsOf(input, slots).high ?? input.model)?.split(/[\\/]/).pop() ?? "";
  if (input.turboIn === "Yes" || (input.turboIn !== "No" && namedTurbo.test(name))) return [];
  return uses(input).words ? ["t2vTurboHigh", "t2vTurboLow"] : ["i2vTurboHigh", "i2vTurboLow"];
};

export const wanVideo = defineRecipe<WanVideo>({
  id: "wan.video",
  // the lightx2v LoRAs with Turbo, SVI 2.0 Pro's for a clip that carries on, RIFE with "RIFE ×2" on
  needsWith: (input, slots) => [...turboNeeds(input, slots), ...(input.previous && !input.end ? ["sviHigh", "sviLow"] : []), ...upscaleNeeds(input), ...rifeNeeds(input.smooth)],
  family: "wan",
  version: 1,
  title: "Video",
  summary: "i2v from a first frame, from a first and last frame, or t2v. No audio.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: false, continues: "clip", endAnchor: false, sound: false,
    fps: WAN_FPS, frameGrid: { step: 4, offset: 1 },
  },
  inputs: [
    {
      id: "model", type: "model", label: "High-noise model", folder: "diffusion_models", slot: "i2vHigh", match: ["wan.?2[._]?2.*high", "wan.*high"],
      note: "the first steps: the motion and the composition. Wan's own, or a fine-tune's high-noise file",
    },
    {
      id: "modelLow", type: "model", label: "Low-noise model", folder: "diffusion_models", slot: "i2vLow", match: ["wan.?2[._]?2.*low", "wan.*low"],
      note: "the last steps: the detail. The low-noise file that goes with the one above",
    },
    {
      id: "prompt", type: "prompt", label: "Prompt", style: "sentences",
      placeholder: "She turns to the camera and smiles, her hair moving in the wind. The camera pushes in slowly.",
    },
    { id: "start", type: "image", role: "start", label: "First frame", note: "the first frame. Without one, the clip is made from the words alone, which needs words-to-video (T2V) models: picture-to-video (I2V) ones make a gray clip without a picture", optional: true },
    { id: "end", type: "image", role: "end", label: "Last frame", note: "the last frame", optional: true },
    FACE_PHOTO,
    {
      id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: SVI_FRAMES, fps: WAN_FPS, advanced: true,
      note: "the clip this one carries on from, through SVI 2.0 Pro: its last frames go in the latent, so that the motion carries over, not only the last picture; on a timeline, the clip before. Its colours are matched to where that clip ends (SVI shifts them a little, clip after clip). Style LoRAs inside an SVI chain can slow its motion down to slow motion. Needs SVI's two LoRAs (Settings › Models) and KJNodes: without them, or with a Last frame, the clip opens on that clip's last frame, still (a cut). A First frame is not used with it",
    },
    { id: "seconds", type: "number", label: "Duration", min: 1, max: 10, step: 0.5, default: 5, unit: " s", note: "the model is made for about 5 seconds: longer clips drift" },
    {
      id: "shape", type: "size", label: "Aspect ratio", default: "tall", grid: 16, min: 256, max: 1280, ratioOnly: true,
      short: "short", maxPixels: WAN_FORM_PIXELS, decidedBy: ["start", "end"], scaledBy: { on: "upscale", by: "upscaleBy" },
      note: "a start image decides the shape instead",
      shapes: [
        { id: "tall", label: "Tall", width: 480, height: 832 },
        { id: "square", label: "Square", width: 640, height: 640 },
        { id: "wide", label: "Wide", width: 832, height: 480 },
      ],
    },
    {
      id: "short", type: "number", label: "Resolution", min: 320, max: 1088, step: 16, default: 480, unit: "p", picks: [480, 576, 720, 1080],
      note: "the short side of the frame. Wan is made for 480p and 720p; with the turbo LoRAs a tall 480p clip often comes out slow or nearly still (users' reports), 576p and 720p move more. Past 720p it is beyond what it was trained for: much slower, and it may drift",
    },
    ...upscaleInputs(),
    ...COLOUR_MATCH_INPUTS,
    { id: "fast", type: "toggle", label: "Turbo", note: "4 steps at CFG 1, for drafts: with the lightx2v LoRAs (one click in Settings → Models), or as it is with a model made for it. Quicker, with less motion than the full steps", default: false, advanced: true, perModel: true,
      // the shift the lightx2v LoRAs are made for
      whenOn: { shift: 5 },
    },
    {
      id: "turboIn", type: "choice", label: "Distilled model", options: ["From the name", "Yes", "No"], renamed: { Auto: "From the name" }, default: "From the name", advanced: true, section: "rare", perModel: true,
      note: "made for a few steps: no turbo LoRA is added. From the name: when it says turbo, distill, lightning or a step count",
    },
    { id: "turboSteps", type: "number", label: "Turbo steps", note: "4 is what the turbo LoRAs are made for; some fine-tunes ask for 6 or 8", min: 2, max: 12, step: 1, default: 4, showWhen: "fast", advanced: true, perModel: true },
    {
      id: "turboStrength", type: "number", label: "High-noise turbo", min: 0.2, max: 1.2, step: 0.05, default: 1, showWhen: "fast", advanced: true, perModel: true,
      note: "the turbo LoRA's strength on the high-noise model. 1 is the LoRAs' own. 0.6 to 0.8 on the high-noise half brings back motion the 4-step LoRA flattens; the low-noise half stays at 1",
    },
    {
      id: "turboHybrid", type: "toggle", label: "Hybrid turbo", default: true, showWhen: "fast", advanced: true, perModel: true,
      note: "the 3-sampler split: Turbo's first step (two from 6) runs on the high-noise model WITHOUT the turbo LoRA, at the full CFG scale (the motion is decided there), then the LoRAs take over at CFG 1 for the rest. The turbo LoRAs alone make Wan's motion slow, close to slow motion; with the split it moves like a full render, for the same steps, a little slower each. Only with the turbo LoRAs, not with a distilled model",
    },
    {
      id: "nag", type: "toggle", label: "NAG", default: true, showWhen: "fast", advanced: true, perModel: true,
      note: "Normalized Attention Guidance: the negative prompt acts in Turbo, where CFG 1 ignores it, at little cost. Needs KJNodes",
    },
    { id: "nagScale", type: "number", label: "NAG scale", min: 1, max: 30, step: 0.5, default: 11, showWhen: "nag", advanced: true, perModel: true, note: "how hard the negative pushes: 11 is its authors' value" },
    { id: "steps", type: "number", label: "Steps", min: 2, max: 50, step: 1, default: 20, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true },
    {
      id: "split", type: "number", label: "High-noise share", min: 0, max: 0.9, step: 0.05, default: 0, advanced: true, perModel: true,
      note: "the share of the steps the first model makes before the second takes over. 0 is Auto: where the noise falls below the level the two models were split at in training (0.9 for image to video, 0.875 for text to video), from the steps and the shift; 0.5 is half",
    },
    {
      id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 3.5, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true,
      note: "with Turbo it is 1. Above 1 the negative prompt acts and every step takes twice as long",
    },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerAdvanced", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSamplerAdvanced", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
    {
      id: "shift", type: "number", label: "Shift", min: 1, max: 20, step: 0.5, default: 8, oldZero: true, advanced: true, perModel: true,
      note: "8 at full steps (ComfyUI's template: with it the half-way handover meets the noise level the two models were split at), 5 with Turbo (what the lightx2v LoRAs are made for). Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail)",
    },
    {
      id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, default: WAN_NEGATIVE, advanced: true, perModel: true,
      note: "acts with a CFG scale above 1, and with Turbo through NAG. The starting text is Wan's own, in Chinese",
    },
    ...SPEED_INPUTS,
    { id: "smooth", type: "toggle", label: "RIFE ×2", note: "frame interpolation: frames interpolated with RIFE, 32 a second in place of 16", default: true, advanced: true },
    {
      id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
      note: "while it renders, a short clip of what is forming, each step. Without it the preview is one still frame: the start image. A small cost per step. Needs the KJNodes pack",
    },
    {
      id: "fps", type: "number", label: "Frame rate (fps)", min: 8, max: 60, step: 1, default: WAN_FPS, advanced: true,
      note: "Wan makes 16 pictures for a second of motion. Another figure plays the same pictures faster or slower: 24 makes the motion quicker and the clip shorter. Doubled when Smooth is on. Under a recording, 16: the clip lasts as long as its part",
    },
    { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
    { id: "loras", type: "loras", label: "LoRAs (high noise)", max: 6, note: "Wan LoRAs come in two files: the HIGH one here" },
    { id: "lorasLow", type: "loras", label: "LoRAs (low noise)", max: 6, note: "and the LOW one here. A LoRA in one file goes in both" },
    { id: "seed", type: "seed", label: "Seed" },
    // a clip under a recording it plays over (card #82): its place in the recording, set by the timeline, never drawn
    ...recordingInputs({ shown: false, fit: WAN_RECORDING, note: "the recording the clip is under: Wan makes no sound, its part is the clip's sound" }),
  ],

  nodes(input) {
    const routeNodes = upscaleNodes(input);
    const how = uses(input);
    const picked = modelsOf(input, {});
    const any = (list: LoraValue[]) => list.some((l) => l.weight !== 0);
    return [
      ...routeNodes,
      ...unetNodes(input.model), "CLIPLoader", "VAELoader", "CLIPTextEncode", "ModelSamplingSD3", "KSamplerAdvanced", "VAEDecode", ...speedNodes(input),
      // a clip that carries on: through SVI 2.0 Pro where its LoRAs and node are there, else opened on the clip before's last
      // frame (the nodes of either way are optional below, the build picks)
      ...(input.previous && !how.both ? [] : [how.words ? "EmptyHunyuanLatentVideo" : how.both ? "WanFirstLastFrameToVideo" : "WanImageToVideo"]),
      ...(input.previous ? ["LoadVideo", "GetVideoComponents", "ImageFromBatch"] : how.words ? [] : ["LoadImage"]),
      ...((input.fast && !picked.distilled) || any(input.loras) || any(input.lorasLow) ? ["LoraLoaderModelOnly"] : []),
      // under a recording: its part, cut (and the silence before it of a head, among the optional nodes)
      ...(input.recording ? recordingNodes({ joined: false }) : []),
    ];
  },
  // the video is written by VideoHelperSuite when it is there, else by ComfyUI's own two nodes
  optionalNodes: [...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ", "WanVideoNAG", ...COLOUR_MATCH_NODES,
    // a clip that carries on: SVI 2.0 Pro's way, or the clip before's last frame as its first
    "WanImageToVideoSVIPro", "ImageScale", "VAEEncode", "LoraLoaderModelOnly", "WanImageToVideo",
    // under a recording, carrying on through SVI: the head's silence before the part
    "AudioConcat", "AudioAdjustVolume",
    // the face along the take against its person's picture
    FACE_NODE],

  build(input, ctx) {
    const { slots, media } = ctx;
    const how = uses(input);
    const picked = modelsOf(input, slots);
    if (!picked.high || !picked.low) {
      const other = madeFor(input.model) ?? madeFor(input.modelLow);
      throw new Error(how.words
        ? `A clip made from words alone needs Wan 2.2's words-to-video (T2V) models: wan2.2_t2v_high_noise and wan2.2_t2v_low_noise, or a T2V fine-tune, in ComfyUI's models/diffusion_models folder.${other === "picture" ? " The models picked are picture-to-video (I2V) models: without a picture they make a flat gray clip." : ""} Or give it a start image.`
        : other === "words"
          ? "The models picked are words-to-video (T2V) models: they do not look at the start image. Pick picture-to-video (I2V) models, or take the start image away."
          : "Wan 2.2 comes as two models: the high-noise and the low-noise file are both needed.");
    }

    // under a recording it plays over (card #82): the clip lasts as long as its part, at Wan's own 16 a second (another rate
    // would play it off its part), and its files carry the part: Wan makes no sound, so the recording plays on across it
    const laid = input.recording ? recordingOnClip({ recordingSeconds: input.recordingSeconds ?? 0 }, ctx, 0, WAN_RECORDING) : null;
    const fps = laid ? WAN_FPS : input.fps;
    // the frame: a timeline's canvas, else the clip it carries on from, else the picture it opens or ends on, else the shape picked
    const carry = carryOf(input, ctx);
    const like = carry ? media.previous : input.start ? media.start : input.end ? media.end : undefined;
    const { width, height } = ctx.canvas
      ? wanCanvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height, 720))
      : like?.width
        ? wanCanvas(like.width, like.height, input.short, WAN_FORM_PIXELS)
        : wanCanvas(input.shape.width, input.shape.height, input.short, WAN_FORM_PIXELS);
    // through SVI, the frames dropped and the head come first: the clip's own frames are as many as without it, less the two
    // dropped (81 make 79, about 5 s), as Wan's frame counts go by fours
    const svi = carry?.svi ? { high: slots.sviHigh!, low: slots.sviLow! } : null;
    const frames = wanFrames(laid ? laid.seconds : input.seconds) + (svi ? SVI_HEAD : 0);

    const g = new GraphBuilder();
    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "wan", device: "default" });
    const vae = g.out("VAELoader", { vae_name: slots.vae });
    const models = wanLoad(g, ctx, input, picked as WanModels, svi);
    const before = carry ? previousFrames(g, ctx)! : null;
    const cond = wanLatent(g, ctx, input, { width, height, frames }, clip, vae, before ? { frames: before, svi: Boolean(svi) } : null);
    const { sampled, passes, steps } = wanPasses(g, ctx, input, models, cond);

    g.phase("decoding");
    const decoded = g.out("VAEDecode", { samples: [sampled, 0], vae });
    // through SVI: the first frames dropped, the head kept, and the colours brought to where the clip before ends
    const own = svi && before ? sviColours(g, ctx, g.out("ImageFromBatch", { image: decoded, batch_index: SVI_DROPPED, length: 4096 }), before) : decoded;
    // the part's sound, after the head's frames (the first frames dropped)
    const audio = laid ? laid.sound(g, null, { head: svi ? SVI_HEAD : 0, frames: svi ? frames - SVI_DROPPED : frames }) : undefined;
    const made = finishFrames(g, ctx, colourMatched(g, ctx, own, openingStart(input), fps), input, { frame: { width, height }, rife: input.smooth, fps, ...(audio ? { audio } : {}) });
    const lorasOf = (turboLora: string | undefined, loras: LoraValue[]) => [...(turboLora ? [`loras/${turboLora}`] : []), ...loraLoads(loras)];
    const said = [
      rifeSkippedSaid(input.smooth, ctx),
      carry && !carry.svi ? carry.why : null,
      svi && !ctx.has("ColorTransfer") ? "Not colour-matched to the clip before: this ComfyUI has no ColorTransfer node (a newer ComfyUI has it)." : null,
    ].filter((x): x is string => Boolean(x));
    // its head, hidden on a timeline: the join fades over it with both clips moving; with RIFE, the clip starts on the frame
    // RIFE makes between the head's last and its own first, as a SCAIL-2 window's does (motionSaved)
    const headMs = svi ? Math.round(((rifeRuns(input.smooth, ctx) ? SVI_HEAD - 0.5 : SVI_HEAD) * 1000) / fps) : 0;
    return {
      ...(said.length ? { warnings: said } : {}),
      graph: g.graph,
      phases: g.phases,
      outputs: [
        { node: made.out, kind: "video", role: "result" },
        // the face along the take against its person's picture (the cast's, else the picture it opens on): drift along a run
        // of clips is flagged on the timeline, as on H3's
        ...faceScore(g, ctx, own, facePhotos(g, ctx, { facePhoto: input.facePhoto, opens: !input.previous && Boolean(input.start) })),
      ],
      totalSteps: steps,
      passes,
      // said: the rest of the batch (ImageFromBatch's 4096) is no frame count
      frames,
      ...(svi ? { overlap: { headMs, tailMs: 0, moving: true } } : carry && !carry.svi && carry.still ? { overlap: { headMs: 0, tailMs: 0, still: true } } : {}),
      loads: [
        ...made.loads,
        `diffusion_models/${picked.high}`, `diffusion_models/${picked.low}`, `text_encoders/${slots.clip}`, `vae/${slots.vae}`,
        ...(svi ? [`loras/${svi.high}`, `loras/${svi.low}`] : []),
        ...lorasOf(models.turboLoras?.high, input.loras), ...lorasOf(models.turboLoras?.low, input.lorasLow),
      ],
    };
  },


  variants: ((): Variant<WanVideo>[] => {
    const slots = { i2vHigh: "wan2.2_i2v_high_noise_14B.safetensors", i2vLow: "wan2.2_i2v_low_noise_14B.safetensors", clip: "umt5_xxl.safetensors", vae: "wan_2.1_vae.safetensors" };
    const all = {
      ...slots, t2vHigh: "wan2.2_t2v_high_noise_14B.safetensors", t2vLow: "wan2.2_t2v_low_noise_14B.safetensors",
      i2vTurboHigh: "i2v_lightx2v_high.safetensors", i2vTurboLow: "i2v_lightx2v_low.safetensors",
      t2vTurboHigh: "t2v_lightx2v_high.safetensors", t2vTurboLow: "t2v_lightx2v_low.safetensors", rife: "rife49.pth",
    };
    const picture = { width: 832, height: 1216 };
    return [
      { name: "opens on a picture, full steps, no turbo files", input: { prompt: "a", start: "p1", fast: false, smooth: false }, slots, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "opens on a picture, Turbo with its LoRAs, smooth", input: { prompt: "a", start: "p1" }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      {
        name: "from a first and a last picture, a LoRA in two files",
        input: { prompt: "a", start: "p1", end: "p2", loras: [{ file: "h.safetensors", weight: 0.9 }, { file: "off.safetensors", weight: 0 }], lorasLow: [{ file: "l.safetensors", weight: 0.9 }] },
        slots: all, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      { name: "ends on a picture only", input: { prompt: "a", end: "p2", fast: false }, slots: all, uploads: { end: "b.png" }, media: { end: picture } },
      { name: "SageAttention and torch.compile on both models", input: { prompt: "a", start: "p1", sage: true, compile: true }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "from words alone, Turbo", input: { prompt: "a", seconds: 3 }, slots: all },
      { name: "the face scored against the cast person's picture", input: { prompt: "a", start: "p1", facePhoto: "f1" }, slots: all, uploads: { start: "a.png", facePhoto: "face.png" }, media: { start: picture } },
      { name: "from words alone, full steps, wide", input: { prompt: "a", fast: false, steps: 30, split: 0.4, cfg: 4, shift: 12, shape: { width: 832, height: 480 }, negative: "blurry" }, slots: all },
      { name: "Turbo with NAG off", input: { prompt: "a", start: "p1", fast: true, nag: false }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "Turbo with the high-noise LoRA eased", input: { prompt: "a", start: "p1", fast: true, turboStrength: 0.7 }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "hybrid Turbo: the motion decided without the LoRA first", input: { prompt: "a", start: "p1", fast: true, turboHybrid: true, turboSteps: 6 }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      // 0.6.3's split, the default: Turbo's first step of 4 without the LoRA, one with it on the high-noise model, two on the low (card #105)
      { name: "hybrid Turbo on its 4 steps: 1 lead, 1 high, 2 low", input: { prompt: "a", start: "p1", fast: true, turboHybrid: true, turboSteps: 4 }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "a GGUF model, SeedVR2 upscale, ComfyUI's own video output", input: { prompt: "a", start: "p1", model: "wan2.2_i2v_high_noise_14B_Q5_K_M.gguf", modelLow: "wan2.2_i2v_low_noise_14B_Q5_K_M.gguf", upscale: "Video: SeedVR2 (restores)", smooth: false }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" }, uploads: { start: "a.png" }, media: { start: picture }, has: (n: string) => n !== "VHS_VideoCombine" },
      {
        // made for a few steps as it is: no turbo LoRA on top of it
        name: "a distilled fine-tune in two files, on a timeline's canvas",
        input: { prompt: "a", start: "p1", model: "High\\SomeoneWAN22I2V_lightningHigh.safetensors", modelLow: "Low\\SomeoneWAN22I2V_lightningLow.safetensors", scheduler: "linear_quadratic" },
        slots: all, uploads: { start: "a.png" }, media: { start: picture }, canvas: { width: 1024, height: 576 },
      },
      {
        name: "carries on from the clip before through SVI 2.0 Pro, Turbo, on a timeline's canvas",
        input: { prompt: "a", previous: { asset: "v0", at: 5000 } },
        slots: { ...all, sviHigh: "SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors", sviLow: "SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors" },
        uploads: { previous: "prev.mp4" }, media: { previous: { width: 480, height: 832, frames: 9, fps: 16 } }, canvas: { width: 480, height: 832 },
      },
      {
        // without SVI's LoRAs: a cut onto the clip before's last frame, as before SVI
        name: "carries on without SVI's LoRAs: opens on the clip before's last frame",
        input: { prompt: "a", previous: { asset: "v0" }, fast: false },
        slots: all, uploads: { previous: "prev.mp4" }, media: { previous: { width: 480, height: 832, frames: 9, fps: 16 } },
      },
      {
        // its part laid in as the take's sound (card #82)
        name: "under a recording it plays over",
        input: { prompt: "a", start: "p1", recording: "a1", fps: 24 },
        slots: all, uploads: { start: "a.png", recording: "rec.wav" }, media: { start: picture, recording: { width: 0, height: 0, seconds: 5.9, after: 4 } },
      },
      {
        name: "under a recording, carrying on through SVI: silence under its head",
        input: { prompt: "a", previous: { asset: "v0" }, recording: "a1" },
        slots: { ...all, sviHigh: "SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors", sviLow: "SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors" },
        uploads: { previous: "prev.mp4", recording: "rec.wav" }, media: { previous: { width: 480, height: 832, frames: 9, fps: 16 }, recording: { width: 0, height: 0, seconds: 7.3, after: 4 } },
      },
    ];
  })(),
});
