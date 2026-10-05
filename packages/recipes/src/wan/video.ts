import { defineRecipe, GraphBuilder, type LoraValue, type Ref, type SizeValue, type Variant } from "@afflatus/core";
import { WAN_FORM_PIXELS, WAN_FPS, wanCanvas, wanFrames } from "./family";
import { pixelUpscale, UPSCALE, UPSCALE_OPTIONAL, upscaleInputs, upscaleNodes } from "../video/upscale";
import { loadUnet, unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, saveVideo, VHS } from "../shared/out";

/**
 * Wan's own negative prompt, as its authors give it (in Chinese: washed-out colours, overexposure, a
 * still picture, blurred detail, subtitles, bad hands and faces, extra limbs, a cluttered background,
 * walking backwards). It only acts above CFG 1, so not with Turbo.
 */
export const WAN_NEGATIVE = "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

export interface WanVideo {
  model?: string;
  modelLow?: string;
  turboIn: string;
  prompt: string;
  negative: string;
  start?: string;
  end?: string;
  seconds: number;
  shape: SizeValue;
  short: number;
  fast: boolean;
  turboSteps: number;
  turboStrength: number;
  turboHybrid: boolean;
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
  fps: number;
  crf: number;
  loras: LoraValue[];
  lorasLow: LoraValue[];
  seed: number;
}

/** What a fine-tune is, as far as its file name says: merges made for a few steps are named for it, or are known ones. */
// DaSiWa's lines: "Lightspeed" is distilled, "TrueVision" is made for the full steps (20 to 30 at CFG 3.5), so his name alone says nothing
const namedTurbo = /turbo|distill|lightning|lightx2v|lightspeed|rapid|smoothmix|(^|[^a-z0-9])\d+[ _-]?steps?/i;

/** Which way the clip is made: from words alone (the words-to-video models), or opening / ending on a picture. */
const uses = (input: WanVideo) => ({ words: !input.start && !input.end, both: Boolean(input.end) });

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

export const wanVideo = defineRecipe<WanVideo>({
  id: "wan.video",
  family: "wan",
  version: 1,
  title: "Video",
  summary: "i2v from a first frame, from a first and last frame, or t2v. No audio.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: false, continues: "frame", endAnchor: false, sound: false,
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
      id: "short", type: "number", label: "Resolution", min: 320, max: 1080, step: 16, default: 480, unit: "p", picks: [480, 576, 720, 1080],
      note: "the short side of the frame. Wan is made for 480p and 720p. Past 720p it is beyond what it was trained for: much slower, and it may drift",
    },
    ...upscaleInputs(),
    { id: "fast", type: "toggle", label: "Turbo", note: "4 steps at CFG 1, for drafts: with the lightx2v LoRAs (one click in Settings → Models), or as it is with a model made for it. Quicker, with less motion than the full steps", default: false, advanced: true, perModel: true },
    {
      id: "turboIn", type: "choice", label: "Distilled model", options: ["Auto", "Yes", "No"], default: "Auto", advanced: true, perModel: true,
      note: "made for a few steps: no turbo LoRA is added. Auto reads it from the file name",
    },
    { id: "turboSteps", type: "number", label: "Turbo steps", note: "4 is what the turbo LoRAs are made for; some fine-tunes ask for 6 or 8", min: 2, max: 12, step: 1, default: 4, showWhen: "fast", advanced: true, perModel: true },
    {
      id: "turboStrength", type: "number", label: "Turbo LoRA strength (high noise)", min: 0.2, max: 1.2, step: 0.05, default: 1, showWhen: "fast", advanced: true, perModel: true,
      note: "1 is the LoRAs' own. 0.6 to 0.8 on the high-noise half brings back motion the 4-step LoRA flattens; the low-noise half stays at 1",
    },
    {
      id: "turboHybrid", type: "toggle", label: "Hybrid turbo (motion first)", default: false, showWhen: "fast", advanced: true, perModel: true,
      note: "the first step or two run on the high-noise model WITHOUT the turbo LoRA at the full CFG scale (the motion is decided there), then the LoRAs take over at CFG 1: a draft that moves like a full render, a little slower. Only with the turbo LoRAs, not with a distilled model",
    },
    { id: "steps", type: "number", label: "Steps", min: 2, max: 50, step: 1, default: 20, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true },
    {
      id: "split", type: "number", label: "High-noise steps (share)", min: 0.1, max: 0.9, step: 0.05, default: 0.5, advanced: true, perModel: true,
      note: "the share of the steps the first model makes before the second takes over: 0.5 is half",
    },
    {
      id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 3.5, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true,
      note: "with Turbo it is 1. Above 1 the negative prompt acts and every step takes twice as long",
    },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerAdvanced", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSamplerAdvanced", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
    {
      id: "shift", type: "number", label: "Shift", min: 0, max: 20, step: 0.5, default: 0, advanced: true, perModel: true,
      note: "0 picks it: 8 at full steps (ComfyUI's template: with it the half-way handover meets the noise level the two models were split at), 5 with Turbo (what the lightx2v LoRAs are made for). Higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail)",
    },
    {
      id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, default: WAN_NEGATIVE, advanced: true, perModel: true,
      note: "only acts with a CFG scale above 1, so not with Turbo. The starting text is Wan's own, in Chinese",
    },
    { id: "smooth", type: "toggle", label: "Frame interpolation (RIFE ×2)", note: "frames interpolated with RIFE: 32 a second in place of 16", default: true, advanced: true },
    {
      id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
      note: "while it renders, a short clip of what is forming, each step. Without it the preview is one still frame: the start image. A small cost per step. Needs the KJNodes pack",
    },
    {
      id: "fps", type: "number", label: "Frame rate (fps)", min: 8, max: 60, step: 1, default: WAN_FPS, advanced: true,
      note: "Wan makes 16 pictures for a second of motion. Another figure plays the same pictures faster or slower: 24 makes the motion quicker and the clip shorter. Doubled when Smooth is on",
    },
    { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
    { id: "loras", type: "loras", label: "LoRAs (high noise)", max: 6, note: "Wan LoRAs come in two files: the HIGH one here" },
    { id: "lorasLow", type: "loras", label: "LoRAs (low noise)", max: 6, note: "and the LOW one here. A LoRA in one file goes in both" },
    { id: "seed", type: "seed", label: "Seed" },
  ],

  nodes(input) {
    const routeNodes = upscaleNodes(input);
    const how = uses(input);
    const picked = modelsOf(input, {});
    const any = (list: LoraValue[]) => list.some((l) => l.weight !== 0);
    return [
      ...routeNodes,
      ...unetNodes(input.model), "CLIPLoader", "VAELoader", "CLIPTextEncode", "ModelSamplingSD3", "KSamplerAdvanced", "VAEDecode",
      how.words ? "EmptyHunyuanLatentVideo" : how.both ? "WanFirstLastFrameToVideo" : "WanImageToVideo",
      ...(how.words ? [] : ["LoadImage"]),
      ...((input.fast && !picked.distilled) || any(input.loras) || any(input.lorasLow) ? ["LoraLoaderModelOnly"] : []),
    ];
  },
  // the video is written by VideoHelperSuite when it is there, else by ComfyUI's own two nodes
  optionalNodes: [...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT, "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ"],

  build(input, ctx) {
    const { slots, uploads, media } = ctx;
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

    // the frame: a timeline's canvas, else the picture it opens or ends on, else the shape picked
    const like = input.start ? media.start : input.end ? media.end : undefined;
    const { width, height } = ctx.canvas
      ? wanCanvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height, 720))
      : like?.width
        ? wanCanvas(like.width, like.height, input.short, WAN_FORM_PIXELS)
        : wanCanvas(input.shape.width, input.shape.height, input.short, WAN_FORM_PIXELS);
    const frames = wanFrames(input.seconds);

    const g = new GraphBuilder();
    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "wan", device: "default" });
    const vae = g.out("VAELoader", { vae_name: slots.vae });

    // Turbo: the two lightx2v LoRAs, unless the model is made for a few steps as it is. Without their
    // files (and with a model that is not distilled) there is no Turbo: the clip takes the full steps.
    const turboLoras = input.fast && !picked.distilled && picked.turboHigh && picked.turboLow ? { high: picked.turboHigh, low: picked.turboLow } : null;
    const turbo = input.fast && (picked.distilled || Boolean(turboLoras));
    // the shift typed in, else the one that suits the steps: 8 at full steps (the template's), 5 for the turbo LoRAs
    const shift = input.shift > 0 ? input.shift : turbo ? 5 : 8;
    // the live preview: each step, a few frames of the latent decoded small (with the tiny VAE when it is
    // there), sent as a short clip. ComfyUI's own preview is the first frame alone: the start image, still
    const finish = (model: Ref): Ref => {
      model = g.out("ModelSamplingSD3", { model, shift });
      return input.livePreview && ctx.has("ModelPreviewOverrideKJ")
        ? g.out("ModelPreviewOverrideKJ", { model, max_resolution: 512, jpeg_quality: 75, suppress_default_preview: true, preview_frames: 16, preview_fps: 12, tiny_vae: slots.tinyVae ?? "none" })
        : model;
    };
    /** The model with its LoRAs, and the same model with the user's LoRAs but without the turbo one (for the hybrid pass). */
    const load = (file: string, turboLora: string | undefined, strength: number, loras: LoraValue[]) => {
      const base = loadUnet(g, ctx, file);
      const own = (m: Ref) => { for (const l of loras) if (l.weight !== 0) m = g.out("LoraLoaderModelOnly", { model: m, lora_name: l.file, strength_model: l.weight }); return m; };
      const boosted = own(turboLora ? g.out("LoraLoaderModelOnly", { model: base, lora_name: turboLora, strength_model: strength }) : base);
      return { model: finish(boosted), plain: turboLora && input.turboHybrid ? finish(own(base)) : null };
    };
    const highBoth = load(picked.high, turboLoras?.high, input.turboStrength, input.loras);
    const high = highBoth.model;
    const low = load(picked.low, turboLoras?.low, 1, input.lorasLow).model;

    let positive: Ref = g.out("CLIPTextEncode", { clip, text: input.prompt });
    let negative: Ref = g.out("CLIPTextEncode", { clip, text: input.negative });
    let latent: Ref;
    if (how.words) {
      latent = g.out("EmptyHunyuanLatentVideo", { width, height, length: frames, batch_size: 1 });
    } else {
      // the pictures become the first and the last frame: the node resizes them to the canvas itself
      const node = g.add(how.both ? "WanFirstLastFrameToVideo" : "WanImageToVideo", {
        positive, negative, vae, width, height, length: frames, batch_size: 1,
        ...(input.start ? { start_image: g.out("LoadImage", { image: uploads.start }) } : {}),
        ...(input.end ? { end_image: g.out("LoadImage", { image: uploads.end }) } : {}),
      });
      positive = [node, 0];
      negative = [node, 1];
      latent = [node, 2];
    }

    // Two passes over one schedule: the high-noise model makes the first steps and hands its latent,
    // still noisy, to the low-noise model, which finishes it.
    const steps = turbo ? input.turboSteps : input.steps;
    const cfg = turbo ? 1 : input.cfg;
    const handover = Math.max(1, Math.min(steps - 1, Math.round(steps * input.split)));
    // the hybrid turbo pass: the first step or two on the high-noise model without its turbo LoRA, at the
    // full CFG scale, where the motion is decided; then the LoRAs at CFG 1 as usual
    const lead = turbo && input.turboHybrid && highBoth.plain ? Math.min(handover - 1, steps >= 6 ? 2 : 1) : 0;
    const passes: Array<{ node: string; steps: number }> = [];
    g.phase("sampling");
    let latentSoFar = latent;
    if (lead > 0) {
      const motion = g.add("KSamplerAdvanced", {
        model: highBoth.plain!, positive, negative, latent_image: latentSoFar, add_noise: "enable", noise_seed: ctx.seed, steps, cfg: input.cfg,
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

    g.phase("decoding");
    let images = g.out("VAEDecode", { samples: [second, 0], vae });
    // SeedVR2 goes before the frame interpolation (its cost grows with the frame count; RIFE's is small); the
    // other pixel routes after it, on the final frames
    const early = input.upscale === UPSCALE.seedvr;
    const pixel = early ? pixelUpscale(g, images, input, { width, height }, ctx) : null;
    if (pixel) images = pixel.images;
    const smooth = input.smooth && Boolean(slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");
    if (smooth) {
      g.phase("interpolating");
      images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
    }
    const late = pixel ?? pixelUpscale(g, images, input, { width, height }, ctx);
    images = late.images;
    g.phase("encoding");
    const out = saveVideo(g, ctx, { images, fps: smooth ? input.fps * 2 : input.fps, crf: input.crf });

    const lorasOf = (turboLora: string | undefined, loras: LoraValue[]) => [...(turboLora ? [turboLora] : []), ...loras.filter((l) => l.weight !== 0).map((l) => l.file)].map((f) => `loras/${f}`);
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "video", role: "result" }],
      totalSteps: steps,
      passes,
      loads: [
        ...late.loads,
        `diffusion_models/${picked.high}`, `diffusion_models/${picked.low}`, `text_encoders/${slots.clip}`, `vae/${slots.vae}`,
        ...lorasOf(turboLoras?.high, input.loras), ...lorasOf(turboLoras?.low, input.lorasLow),
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
      { name: "from words alone, Turbo", input: { prompt: "a", seconds: 3 }, slots: all },
      { name: "from words alone, full steps, wide", input: { prompt: "a", fast: false, steps: 30, split: 0.4, cfg: 4, shift: 12, shape: { width: 832, height: 480 }, negative: "blurry" }, slots: all },
      { name: "Turbo with the high-noise LoRA eased", input: { prompt: "a", start: "p1", fast: true, turboStrength: 0.7 }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "hybrid Turbo: the motion decided without the LoRA first", input: { prompt: "a", start: "p1", fast: true, turboHybrid: true, turboSteps: 6 }, slots: all, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "a GGUF model, SeedVR2 upscale, ComfyUI's own video output", input: { prompt: "a", start: "p1", model: "wan2.2_i2v_high_noise_14B_Q5_K_M.gguf", modelLow: "wan2.2_i2v_low_noise_14B_Q5_K_M.gguf", upscale: "Video: SeedVR2 (restores)", smooth: false }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" }, uploads: { start: "a.png" }, media: { start: picture }, has: (n: string) => n !== "VHS_VideoCombine" },
      {
        // made for a few steps as it is: no turbo LoRA on top of it
        name: "a distilled fine-tune in two files, on a timeline's canvas",
        input: { prompt: "a", start: "p1", model: "High\\SomeoneWAN22I2V_lightningHigh.safetensors", modelLow: "Low\\SomeoneWAN22I2V_lightningLow.safetensors", scheduler: "linear_quadratic" },
        slots: all, uploads: { start: "a.png" }, media: { start: picture }, canvas: { width: 1024, height: 576 },
      },
    ];
  })(),
});
