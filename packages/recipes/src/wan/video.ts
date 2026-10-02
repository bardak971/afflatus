import { defineRecipe, GraphBuilder, type LoraValue, type Ref, type SizeValue, type Variant } from "@studai/core";
import { WAN_FPS, wanCanvas, wanFrames } from "./family";

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
  steps: number;
  split: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  shift: number;
  smooth: boolean;
  loras: LoraValue[];
  lorasLow: LoraValue[];
  seed: number;
}

/** What a fine-tune is, as far as its file name says: merges made for a few steps are named for it, or are known ones. */
const namedTurbo = /turbo|distill|lightning|lightx2v|lightspeed|rapid|smoothmix|dasiwa|(^|[^a-z0-9])\d+[ _-]?steps?/i;

/** Which way the clip is made: from words alone (the words-to-video models), or opening / ending on a picture. */
const uses = (input: WanVideo) => ({ words: !input.start && !input.end, both: Boolean(input.end) });

/**
 * The two models the clip is made with, and whether they are made for a few steps as they are. Left
 * alone, they are the usual files of the way the clip is made; a model picked on the form is used for
 * both ways (a fine-tune is made for one of them: its author says which).
 */
const modelsOf = (input: WanVideo, slots: Record<string, string>) => {
  const words = uses(input).words;
  const high = input.model ?? (words ? slots.t2vHigh : slots.i2vHigh);
  const low = input.modelLow ?? (words ? slots.t2vLow : slots.i2vLow);
  const name = high?.split(/[\\/]/).pop() ?? "";
  const distilled = input.turboIn === "Yes" || (input.turboIn !== "No" && namedTurbo.test(name));
  return { high, low, distilled, turboHigh: words ? slots.t2vTurboHigh : slots.i2vTurboHigh, turboLow: words ? slots.t2vTurboLow : slots.i2vTurboLow };
};

export const wanVideo = defineRecipe<WanVideo>({
  id: "wan.video",
  family: "wan",
  version: 1,
  title: "Video",
  summary: "From a picture, from a first and a last picture, or from words alone. No sound.",
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
      id: "prompt", type: "prompt", label: "What happens", style: "sentences",
      placeholder: "She turns to the camera and smiles, her hair moving in the wind. The camera pushes in slowly.",
    },
    { id: "start", type: "image", role: "start", label: "Start image", note: "the first frame. Without one, the clip is made from the words alone, with the words-to-video models", optional: true },
    { id: "end", type: "image", role: "end", label: "End image", note: "the last frame", optional: true },
    { id: "seconds", type: "number", label: "Length", min: 1, max: 10, step: 0.5, default: 5, unit: " s", note: "the model is made for about 5 seconds: longer clips drift" },
    {
      id: "shape", type: "size", label: "Aspect ratio", default: "tall", grid: 16, min: 256, max: 1280, ratioOnly: true,
      note: "a start image decides the shape instead",
      shapes: [
        { id: "tall", label: "Tall", width: 480, height: 832 },
        { id: "square", label: "Square", width: 640, height: 640 },
        { id: "wide", label: "Wide", width: 832, height: 480 },
      ],
    },
    { id: "short", type: "number", label: "Resolution", note: "the short side: 480p (the usual one) to 720p. Larger is sharper and much slower", min: 320, max: 720, step: 16, default: 480, unit: "p" },
    { id: "fast", type: "toggle", label: "Turbo", note: "4 steps at CFG 1: with the lightx2v LoRAs, or as it is with a model made for it", default: true, advanced: true, perModel: true },
    {
      id: "turboIn", type: "choice", label: "Turbo model (distilled)", options: ["Auto", "Yes", "No"], default: "Auto", advanced: true, perModel: true,
      note: "made for a few steps: no turbo LoRA is added. Auto reads it from the file name",
    },
    { id: "turboSteps", type: "number", label: "Turbo steps", note: "4 is what the turbo LoRAs are made for; some fine-tunes ask for 6 or 8", min: 2, max: 12, step: 1, default: 4, showWhen: "fast", advanced: true, perModel: true },
    { id: "steps", type: "number", label: "Steps", min: 2, max: 50, step: 1, default: 20, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true },
    {
      id: "split", type: "number", label: "Steps on the high-noise model", min: 0.1, max: 0.9, step: 0.05, default: 0.5, advanced: true, perModel: true,
      note: "the share of the steps the first model makes before the second takes over: 0.5 is half",
    },
    {
      id: "cfg", type: "number", label: "CFG scale", min: 1, max: 10, step: 0.5, default: 3.5, showWhen: { input: "fast", in: [false] }, advanced: true, perModel: true,
      note: "with Turbo it is 1. Above 1 the negative prompt acts and every step takes twice as long",
    },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerAdvanced", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSamplerAdvanced", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
    {
      id: "shift", type: "number", label: "Shift", min: 0.5, max: 20, step: 0.5, default: 5, advanced: true, perModel: true,
      note: "higher gives the first steps more weight (the whole picture and the motion), lower the last ones (detail). Some fine-tunes ask for 8",
    },
    {
      id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, default: WAN_NEGATIVE, advanced: true, perModel: true,
      note: "only acts with a CFG scale above 1, so not with Turbo. The starting text is Wan's own, in Chinese",
    },
    { id: "smooth", type: "toggle", label: "Smooth: 32 fps", note: "frames interpolated with RIFE, from 16 to 32 a second", default: true, advanced: true },
    { id: "loras", type: "loras", label: "LoRAs (high noise)", max: 6, note: "Wan LoRAs come in two files: the HIGH one here" },
    { id: "lorasLow", type: "loras", label: "LoRAs (low noise)", max: 6, note: "and the LOW one here. A LoRA in one file goes in both" },
    { id: "seed", type: "seed", label: "Seed" },
  ],

  nodes(input) {
    const how = uses(input);
    const picked = modelsOf(input, {});
    const any = (list: LoraValue[]) => list.some((l) => l.weight !== 0);
    return [
      "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ModelSamplingSD3", "KSamplerAdvanced", "VAEDecode", "VHS_VideoCombine",
      how.words ? "EmptyHunyuanLatentVideo" : how.both ? "WanFirstLastFrameToVideo" : "WanImageToVideo",
      ...(how.words ? [] : ["LoadImage"]),
      ...((input.fast && !picked.distilled) || any(input.loras) || any(input.lorasLow) ? ["LoraLoaderModelOnly"] : []),
    ];
  },
  optionalNodes: ["FrameInterpolationModelLoader", "FrameInterpolate"],

  build(input, ctx) {
    const { slots, uploads, media } = ctx;
    const how = uses(input);
    const picked = modelsOf(input, slots);
    if (!picked.high || !picked.low) {
      throw new Error(how.words
        ? "A clip made from words alone needs Wan 2.2's words-to-video models (wan2.2_t2v_high_noise and wan2.2_t2v_low_noise in ComfyUI's models/diffusion_models folder). Or give it a start image."
        : "Wan 2.2 comes as two models: the high-noise and the low-noise file are both needed.");
    }

    // the frame: a timeline's canvas, else the picture it opens or ends on, else the shape picked
    const like = input.start ? media.start : input.end ? media.end : undefined;
    const { width, height } = ctx.canvas
      ? wanCanvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height, 720))
      : like?.width
        ? wanCanvas(like.width, like.height, input.short)
        : wanCanvas(input.shape.width, input.shape.height, input.short);
    const frames = wanFrames(input.seconds);

    const g = new GraphBuilder();
    const clip = g.out("CLIPLoader", { clip_name: slots.clip, type: "wan", device: "default" });
    const vae = g.out("VAELoader", { vae_name: slots.vae });

    // Turbo: the two lightx2v LoRAs, unless the model is made for a few steps as it is. Without their
    // files (and with a model that is not distilled) there is no Turbo: the clip takes the full steps.
    const turboLoras = input.fast && !picked.distilled && picked.turboHigh && picked.turboLow ? { high: picked.turboHigh, low: picked.turboLow } : null;
    const turbo = input.fast && (picked.distilled || Boolean(turboLoras));
    const load = (file: string, turboLora: string | undefined, loras: LoraValue[]) => {
      let model: Ref = g.out("UNETLoader", { unet_name: file, weight_dtype: "default" });
      if (turboLora) model = g.out("LoraLoaderModelOnly", { model, lora_name: turboLora, strength_model: 1 });
      for (const l of loras) if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
      return g.out("ModelSamplingSD3", { model, shift: input.shift });
    };
    const high = load(picked.high, turboLoras?.high, input.loras);
    const low = load(picked.low, turboLoras?.low, input.lorasLow);

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
    g.phase("sampling");
    const first = g.add("KSamplerAdvanced", {
      model: high, positive, negative, latent_image: latent, add_noise: "enable", noise_seed: ctx.seed, steps, cfg,
      sampler_name: input.sampler, scheduler: input.scheduler, start_at_step: 0, end_at_step: handover, return_with_leftover_noise: "enable",
    });
    g.phase("refining");
    const second = g.add("KSamplerAdvanced", {
      model: low, positive, negative, latent_image: [first, 0], add_noise: "disable", noise_seed: 0, steps, cfg,
      sampler_name: input.sampler, scheduler: input.scheduler, start_at_step: handover, end_at_step: 10000, return_with_leftover_noise: "disable",
    });

    g.phase("decoding");
    let images = g.out("VAEDecode", { samples: [second, 0], vae });
    const smooth = input.smooth && Boolean(slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");
    if (smooth) {
      g.phase("interpolating");
      images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
    }
    g.phase("encoding");
    // into ComfyUI's temp folder, which it clears itself: nothing piles up in output/
    const out = g.add("VHS_VideoCombine", {
      images, frame_rate: smooth ? WAN_FPS * 2 : WAN_FPS, loop_count: 0, filename_prefix: "studai/video", format: "video/h264-mp4",
      pingpong: false, save_output: false, pix_fmt: "yuv420p", crf: 19, save_metadata: false, trim_to_audio: false,
    });

    const lorasOf = (turboLora: string | undefined, loras: LoraValue[]) => [...(turboLora ? [turboLora] : []), ...loras.filter((l) => l.weight !== 0).map((l) => l.file)].map((f) => `loras/${f}`);
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "video", role: "result" }],
      totalSteps: steps,
      passes: [{ node: first, steps: handover }, { node: second, steps: steps - handover }],
      loads: [
        `diffusion_models/${picked.high}`, `diffusion_models/${picked.low}`, `text_encoders/${slots.clip}`, `vae/${slots.vae}`,
        ...lorasOf(turboLoras?.high, input.loras), ...lorasOf(turboLoras?.low, input.lorasLow),
      ],
    };
  },

  advice(input, card) {
    const out = [];
    const small = card.vramGb <= 13;
    const gb = Math.round(card.vramGb);
    if (input.short > 480 && small) out.push({ input: "short", level: input.short >= 640 ? ("heavy" as const) : ("slow" as const), text: `${input.short >= 640 ? "probably too big for" : "slow on"} a ${gb} GB card` });
    if (input.seconds > 5 && small) out.push({ input: "seconds", level: "slow" as const, text: `long clips slow down a lot on a ${gb} GB card` });
    if (!input.fast) out.push({ input: "fast", level: "slow" as const, text: "five times the steps, each twice as long" });
    return out;
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
      { name: "from words alone, full steps, wide", input: { prompt: "a", fast: false, steps: 30, split: 0.4, cfg: 4, shift: 8, shape: { width: 832, height: 480 }, negative: "blurry" }, slots: all },
      {
        // made for a few steps as it is: no turbo LoRA on top of it
        name: "a distilled fine-tune in two files, on a timeline's canvas",
        input: { prompt: "a", start: "p1", model: "High\\SomeoneWAN22I2V_lightningHigh.safetensors", modelLow: "Low\\SomeoneWAN22I2V_lightningLow.safetensors", scheduler: "linear_quadratic" },
        slots: all, uploads: { start: "a.png" }, media: { start: picture }, canvas: { width: 1024, height: 576 },
      },
    ];
  })(),
});
