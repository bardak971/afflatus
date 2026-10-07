import { defineRecipe, GraphBuilder, type LoraValue, type Ref, type SizeValue, type Variant } from "@afflatus/core";
import { LTX_FPS, LTX_MAX_PIXELS, ltxCanvas, ltxFrames } from "./family";
import { pixelUpscale, UPSCALE, UPSCALE_OPTIONAL, upscaleInputs, upscaleNodes } from "../video/upscale";
import { faster, SPEED_INPUTS, speedNodes, type SpeedSettings } from "../shared/speed";
import { loadUnet, unetNodes } from "../shared/unet";
import { CORE_VIDEO_OUT, saveVideo, VHS } from "../shared/out";

const SMOOTH_AUTO = "Auto";
const SMOOTH_RIFE = "RIFE (pixels)";
const SMOOTH_LTX = "LTX temporal (latent)";

/** The schedule LTX's authors give for the distilled model: 8 steps, written out. */
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
export function refineSigmas(from: number, steps: number): string {
  const shares = steps === 3 ? REFINE_SHAPE : Array.from({ length: steps + 1 }, (_x, i) => 1 - (i / steps) ** 1.75);
  return shares.map((x, i) => (i === shares.length - 1 ? "0.0" : String(Number((from * x).toFixed(4))))).join(", ");
}
const OWN_SCHEDULE = "LTX's own (8 steps)";
const BY_STEPS = "By steps";

export interface LtxVideo {
  model?: string;
  turboIn: string;
  prompt: string;
  negative: string;
  start?: string;
  end?: string;
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
 * How the model is loaded. In separate files when a diffusion model is picked or found; otherwise from
 * the one checkpoint. Whether it is distilled decides if the distilled LoRA goes on top of it.
 */
const modelOf = (input: LtxVideo, slots: Record<string, string>) => {
  const unet = input.model ?? slots.unet;
  const file = unet ?? slots.checkpoint;
  const name = file?.split(/[\\/]/).pop() ?? "";
  return { unet, checkpoint: unet ? undefined : slots.checkpoint, distilled: input.turboIn === "Yes" || (input.turboIn !== "No" && namedDistilled.test(name)) };
};

/**
 * Which way the clip is made. In two passes when it can be: a first pass at half the size, enlarged in
 * latent space, then a short second pass that refines it. That needs the latent upscaler, and it is how
 * a clip is made from words or from an opening picture. A clip that ends on a picture is made in one
 * pass at full size, its pictures given as guides: the way ComfyUI's own first-and-last-frame template does it.
 */
const uses = (input: LtxVideo, slots: Record<string, string>) => ({ twoPass: input.twoPass && Boolean(slots.upscaler) && !input.end });

export const ltxVideo = defineRecipe<LtxVideo>({
  id: "ltx.video",
  family: "ltx",
  version: 1,
  title: "Video with audio",
  summary: "t2v, or i2v from a first frame or a first and last frame. Audio generated with it.",
  output: "video",
  traits: {
    startFrame: true, endFrame: true, midFrames: false, continues: "frame", endAnchor: false, sound: true,
    fps: LTX_FPS, frameGrid: { step: 8, offset: 1 },
  },
  inputs: [
    {
      id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["ltx.?2[._]?3", "ltx"],
      note: "a diffusion model in a file of its own (a fine-tune, usually). Left alone with none there, the one checkpoint is used",
    },
    {
      id: "prompt", type: "prompt", label: "Prompt", style: "sentences",
      placeholder: "A medium close-up. She turns to the camera and says quietly: \"What a view.\" Wind, and waves far below.",
    },
    { id: "start", type: "image", role: "start", label: "First frame", note: "the first frame", optional: true },
    { id: "end", type: "image", role: "end", label: "Last frame", note: "the last frame. With one, the clip is made in one pass at full size", optional: true },
    { id: "seconds", type: "number", label: "Duration", min: 1, max: 20, step: 0.5, default: 5, unit: " s" },
    {
      id: "shape", type: "size", label: "Aspect ratio", default: "wide", grid: 64, min: 256, max: 1920, ratioOnly: true,
      short: "short", maxPixels: LTX_MAX_PIXELS, decidedBy: ["start", "end"], scaledBy: { on: "upscale", by: "upscaleBy" },
      note: "a start image decides the shape instead",
      shapes: [
        { id: "tall", label: "Tall", width: 704, height: 1280 },
        { id: "square", label: "Square", width: 960, height: 960 },
        { id: "wide", label: "Wide", width: 1280, height: 704 },
      ],
    },
    { id: "short", type: "number", label: "Resolution", note: "the short side of the frame: 704 is about 720p, 1088 about 1080p. Larger is sharper and much slower", min: 384, max: 1088, step: 64, default: 704, unit: "p", picks: [512, 704, 832, 1088] },
    ...upscaleInputs(),
    {
      id: "twoPass", type: "toggle", label: "Two-pass (latent upscale)", default: true, advanced: true,
      note: "half the size first, enlarged with the latent upscaler, then 3 steps that refine: faster and sharper. Off, or without the upscaler, or with an end image: one pass at full size",
    },
    {
      id: "refineStrength", type: "number", label: "Refine denoise", min: 0.3, max: 1, step: 0.05, default: 0.85, showWhen: "twoPass", advanced: true,
      note: "where the refining pass starts: 0.85 is LTX's own. Lower keeps the enlarged clip closer to the first pass, higher lets it change more",
    },
    { id: "refineSteps", type: "number", label: "Refine steps", note: "3 is LTX's own", min: 1, max: 8, step: 1, default: 3, showWhen: "twoPass", advanced: true },
    {
      id: "turboIn", type: "choice", label: "Distilled model", options: ["Auto", "Yes", "No"], default: "Auto", advanced: true, perModel: true,
      note: "made for 8 steps as it is: no distilled LoRA is added. Auto reads it from the file name",
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
    { id: "cfg", type: "number", label: "CFG scale", note: "1 for a distilled model and LTX's own schedule; 3 to 4 with By steps on the dev model (ComfyUI's template: 4). Above 1 the negative prompt acts and every step takes twice as long", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
    {
      id: "negative", type: "prompt", label: "Negative prompt", style: "sentences", optional: true, advanced: true, perModel: true,
      default: "blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, pc game, console game, video game, cartoon, childish, ugly",
      note: "only acts with a CFG scale above 1",
    },
    { id: "startStrength", type: "number", label: "First frame strength", min: 0.1, max: 1, step: 0.05, default: 0.7, showWhen: "start", advanced: true, note: "lower lets the first frames move away from the picture sooner" },
    { id: "endStrength", type: "number", label: "Last frame strength", min: 0.1, max: 1, step: 0.05, default: 0.7, showWhen: "end", advanced: true },
    {
      id: "compression", type: "number", label: "Input image compression (CRF)", min: 0, max: 50, step: 1, default: 18, advanced: true,
      note: "the start and end pictures are compressed like a video frame before the model sees them: a picture that is too clean gives a clip that does not move. 0 leaves them as they are",
    },
    {
      id: "loraStrength", type: "number", label: "Distilled LoRA strength", min: 0, max: 1.5, step: 0.05, default: 0.5, advanced: true, perModel: true,
      note: "only for a model that is not distilled: how strongly the distilled LoRA is put on it. 0.5 is what ComfyUI's template uses with LTX's own schedule; with By steps the LoRA refines only, at 1 in the template",
    },
    { id: "tile", type: "number", label: "VAE decode tile size", note: "the clip is turned into pictures piece by piece: smaller pieces need less memory and take longer", min: 256, max: 2048, step: 32, default: 768, unit: " px", advanced: true },
    { id: "tileFrames", type: "number", label: "VAE decode temporal tile", note: "fewer needs less memory. 4096 is all of them at once", min: 16, max: 4096, step: 8, default: 4096, advanced: true },
    { id: "crf", type: "number", label: "CRF", note: "how hard the video file is compressed: lower is better and larger. 19 looks lossless, 23 is the usual quality of the web", min: 0, max: 40, step: 1, default: 19, advanced: true },
    {
      id: "livePreview", type: "toggle", label: "Live preview (animated)", default: true, advanced: true,
      note: "while it renders, a short clip of what is forming, each step, without its sound. Without it the preview is one still frame: the start image. A small cost per step. Needs the KJNodes pack",
    },
    ...SPEED_INPUTS,
    { id: "smooth", type: "toggle", label: "Frame interpolation (×2)", note: "from 25 to 50 frames a second: with LTX's own temporal upscaler in latent space when its file is there (motion-aware, then a short refine), else RIFE on the pixels", default: false, advanced: true },
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
      "RandomNoise", "KSamplerSelect", "CFGGuider", "SamplerCustomAdvanced", "VAEDecodeTiled", "LTXVAudioVAEDecode", ...speedNodes(input),
      ...(input.model ? unetNodes(input.model).filter((n) => n !== "UNETLoader") : []),
      ...(input.schedule === BY_STEPS ? ["LTXVScheduler"] : []),
      ...(input.start || input.end ? ["LoadImage", "ImageScale", "LTXVPreprocess"] : []),
    ];
  },
  // which loaders, and which way the clip is made, depend on the files this ComfyUI has
  optionalNodes: [...UPSCALE_OPTIONAL, VHS, ...CORE_VIDEO_OUT,
    "UNETLoader", "DualCLIPLoader", "VAELoader", "CheckpointLoaderSimple", "LTXVAudioVAELoader", "LTXAVTextEncoderLoader", "LoraLoaderModelOnly",
    "LatentUpscaleModelLoader", "LTXVLatentUpsampler", "LTXVImgToVideoInplace", "LTXVAddGuide", "LTXVCropGuides", "ManualSigmas",
    "FrameInterpolationModelLoader", "FrameInterpolate", "ModelPreviewOverrideKJ",
  ],

  build(input, ctx) {
    const { slots, uploads, media } = ctx;
    const picked = modelOf(input, slots);
    const how = uses(input, slots);
    if (!picked.unet && !picked.checkpoint) throw new Error("LTX 2.3 was not found: put its checkpoint in ComfyUI's models/checkpoints folder, or a diffusion model in models/diffusion_models with its two VAEs and its text projection.");
    if (picked.unet && (!slots.videoVae || !slots.audioVae || !slots.projection)) {
      throw new Error("A diffusion model in a file of its own needs LTX 2.3's other parts: the video VAE and the audio VAE in ComfyUI's models/vae folder, and the text projection in models/text_encoders.");
    }

    // the frame: a timeline's canvas, else the picture it opens or ends on, else the shape picked
    const like = input.start ? media.start : input.end ? media.end : undefined;
    const { width, height } = ctx.canvas
      ? ltxCanvas(ctx.canvas.width, ctx.canvas.height, Math.min(ctx.canvas.width, ctx.canvas.height))
      : like?.width
        ? ltxCanvas(like.width, like.height, input.short)
        : ltxCanvas(input.shape.width, input.shape.height, input.short);
    const frames = ltxFrames(input.seconds);

    const g = new GraphBuilder();
    let model: Ref;
    let clip: Ref;
    let vae: Ref;
    let audioVae: Ref;
    if (picked.unet) {
      model = loadUnet(g, ctx, picked.unet);
      clip = g.out("DualCLIPLoader", { clip_name1: slots.clip, clip_name2: slots.projection, type: "ltxv", device: "default" });
      vae = g.out("VAELoader", { vae_name: slots.videoVae });
      audioVae = g.out("VAELoader", { vae_name: slots.audioVae });
    } else {
      const loaded = g.add("CheckpointLoaderSimple", { ckpt_name: picked.checkpoint });
      model = [loaded, 0];
      vae = [loaded, 2];
      audioVae = g.out("LTXVAudioVAELoader", { ckpt_name: picked.checkpoint });
      clip = g.out("LTXAVTextEncoderLoader", { text_encoder: slots.clip, ckpt_name: picked.checkpoint, device: "default" });
    }
    for (const l of input.loras) if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    model = faster(g, model, input, ctx);
    const byHand = input.schedule !== BY_STEPS;
    // the live preview: each step, a few frames of the latent decoded small (with the tiny VAE when it is
    // there), sent as a short clip. ComfyUI's own preview is the first frame alone. No sound: the node
    // plays it for H3 alone (seen on a real render: an audio VAE given here is not used)
    const previewed = (m: Ref): Ref => (input.livePreview && ctx.has("ModelPreviewOverrideKJ")
      ? g.out("ModelPreviewOverrideKJ", { model: m, max_resolution: 512, jpeg_quality: 75, suppress_default_preview: true, preview_frames: 16, preview_fps: 12, tiny_vae: slots.tinyVae ?? "none" })
      : m);
    // the full model: with LTX's own 8 steps the distilled LoRA goes on the whole render at half strength, as
    // ComfyUI's template has it; with By steps the dev model samples on its own schedule and the LoRA refines only
    const lora = !picked.distilled && slots.turbo ? slots.turbo : undefined;
    // the model without the LoRA is only sampled with when there is no LoRA, or By steps is off (the first pass runs on it)
    const plain = lora && byHand ? null : previewed(model);
    const boosted = lora ? previewed(g.out("LoraLoaderModelOnly", { model, lora_name: lora, strength_model: input.loraStrength })) : plain!;
    const firstModel = byHand ? boosted : plain!;
    model = boosted;
    const steps = byHand ? LTX_SIGMAS.split(",").length - 1 : input.steps;
    // By steps: LTX's own scheduler, shifted by the size of the latent it is given
    const sigmas = (latent: Ref) => (byHand ? g.out("ManualSigmas", { sigmas: LTX_SIGMAS }) : g.out("LTXVScheduler", { steps, max_shift: input.maxShift, base_shift: input.baseShift, stretch: input.stretch, terminal: input.terminal, latent }));

    const cond = g.add("LTXVConditioning", {
      positive: g.out("CLIPTextEncode", { clip, text: input.prompt }),
      negative: g.out("CLIPTextEncode", { clip, text: input.negative }),
      frame_rate: LTX_FPS,
    });
    // a picture as the model likes it: at the clip's size, and roughened like a frame of video
    const frame = (upload: string | undefined, w: number, h: number): Ref => {
      const sized = g.out("ImageScale", { image: g.out("LoadImage", { image: upload }), upscale_method: "lanczos", width: w, height: h, crop: "center" });
      return g.out("LTXVPreprocess", { image: sized, img_compression: input.compression });
    };
    const sampler = g.out("KSamplerSelect", { sampler_name: input.sampler });
    const sound = g.out("LTXVEmptyLatentAudio", { frames_number: frames, frame_rate: LTX_FPS, batch_size: 1, audio_vae: audioVae });

    let video: Ref;
    let audio: Ref;
    const passes: Array<{ node: string; steps: number }> = [];
    if (how.twoPass) {
      // ---- first pass at half the size: the whole clip is decided here, picture and sound
      const w = width / 2;
      const h = height / 2;
      let latent: Ref = g.out("EmptyLTXVLatentVideo", { width: w, height: h, length: frames, batch_size: 1 });
      if (input.start) latent = g.out("LTXVImgToVideoInplace", { vae, image: frame(uploads.start, w, h), latent, strength: input.startStrength, bypass: false });
      g.phase("sampling");
      const first = g.add("SamplerCustomAdvanced", {
        noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
        guider: g.out("CFGGuider", { model: firstModel, positive: [cond, 0], negative: [cond, 1], cfg: input.cfg }),
        sampler, sigmas: sigmas(latent),
        latent_image: g.out("LTXVConcatAVLatent", { video_latent: latent, audio_latent: sound }),
      });
      passes.push({ node: first, steps });
      const made = g.add("LTXVSeparateAVLatent", { av_latent: [first, 0] });

      // ---- enlarged ×2 in latent space, then 3 steps that refine it; the sound of the first pass is kept
      g.phase("upscaling");
      let large: Ref = g.out("LTXVLatentUpsampler", { samples: [made, 0], upscale_model: g.out("LatentUpscaleModelLoader", { model_name: slots.upscaler }), vae });
      // the opening picture again, at full size and at full strength: the first frame is the picture itself
      if (input.start) large = g.out("LTXVImgToVideoInplace", { vae, image: frame(uploads.start, width, height), latent: large, strength: 1, bypass: false });
      g.phase("refining");
      const refine = input.refineSteps;
      const second = g.add("SamplerCustomAdvanced", {
        noise: g.out("RandomNoise", { noise_seed: ctx.seed + 1 }),
        guider: g.out("CFGGuider", { model, positive: [cond, 0], negative: [cond, 1], cfg: input.cfg }),
        sampler, sigmas: g.out("ManualSigmas", { sigmas: refineSigmas(input.refineStrength, refine) }),
        latent_image: g.out("LTXVConcatAVLatent", { video_latent: large, audio_latent: [made, 1] }),
      });
      passes.push({ node: second, steps: refine });
      const done = g.add("LTXVSeparateAVLatent", { av_latent: [second, 0] });
      video = [done, 0];
      audio = [done, 1];
    } else {
      // ---- one pass at full size, the pictures given as guides at the first and the last frame
      let positive: Ref = [cond, 0];
      let negative: Ref = [cond, 1];
      let latent: Ref = g.out("EmptyLTXVLatentVideo", { width, height, length: frames, batch_size: 1 });
      const guide = (upload: string | undefined, at: number, strength: number) => {
        const added = g.add("LTXVAddGuide", { positive, negative, vae, latent, image: frame(upload, width, height), frame_idx: at, strength });
        positive = [added, 0];
        negative = [added, 1];
        latent = [added, 2];
      };
      if (input.start) guide(uploads.start, 0, input.startStrength);
      if (input.end) guide(uploads.end, -1, input.endStrength);
      const guided = Boolean(input.start || input.end);
      g.phase("sampling");
      const only = g.add("SamplerCustomAdvanced", {
        noise: g.out("RandomNoise", { noise_seed: ctx.seed }),
        guider: g.out("CFGGuider", { model, positive, negative, cfg: input.cfg }),
        sampler, sigmas: sigmas(latent),
        latent_image: g.out("LTXVConcatAVLatent", { video_latent: latent, audio_latent: sound }),
      });
      passes.push({ node: only, steps });
      const done = g.add("LTXVSeparateAVLatent", { av_latent: [only, 0] });
      // the guides are frames added to the clip: they are taken out again before it is decoded
      video = guided ? [g.add("LTXVCropGuides", { positive, negative, latent: [done, 0] }), 2] : [done, 0];
      audio = [done, 1];
    }

    // twice the frames: LTX's temporal upscaler doubles the latent's frames (the sound is untouched), then a
    // short pass settles them; else RIFE on the decoded pictures
    const canTemporal = Boolean(slots.temporal) && ctx.has("LTXVLatentUpsampler") && ctx.has("LatentUpscaleModelLoader");
    if (input.smooth && input.smoothWith === SMOOTH_LTX && !canTemporal) throw new Error("LTX's temporal upscaler was not found: put ltx-2.3-temporal-upscaler-x2-*.safetensors in ComfyUI's models/latent_upscale_models folder (one click in Settings → Models), or interpolate with RIFE.");
    const temporal = input.smooth && input.smoothWith !== SMOOTH_RIFE && canTemporal;
    if (temporal) {
      g.phase("interpolating");
      const doubled = g.out("LTXVLatentUpsampler", { samples: video, upscale_model: g.out("LatentUpscaleModelLoader", { model_name: slots.temporal }), vae });
      const settled = g.add("SamplerCustomAdvanced", {
        noise: g.out("RandomNoise", { noise_seed: ctx.seed + 2 }),
        guider: g.out("CFGGuider", { model, positive: [cond, 0], negative: [cond, 1], cfg: input.cfg }),
        sampler, sigmas: g.out("ManualSigmas", { sigmas: refineSigmas(0.5, 2) }),
        latent_image: g.out("LTXVConcatAVLatent", { video_latent: doubled, audio_latent: audio }),
      });
      passes.push({ node: settled, steps: 2 });
      const apart = g.add("LTXVSeparateAVLatent", { av_latent: [settled, 0] });
      video = [apart, 0];
      audio = [apart, 1];
    }
    g.phase("decoding");
    let images = g.out("VAEDecodeTiled", { samples: video, vae, tile_size: input.tile, overlap: 64, temporal_size: input.tileFrames, temporal_overlap: 4 });
    const heard = g.out("LTXVAudioVAEDecode", { samples: audio, audio_vae: audioVae });
    // SeedVR2 goes before the frame interpolation (its cost grows with the frame count; RIFE's is small); the
    // other pixel routes after it, on the final frames
    const early = input.upscale === UPSCALE.seedvr;
    const pixel = early ? pixelUpscale(g, images, input, { width, height }, ctx) : null;
    if (pixel) images = pixel.images;
    const rife = input.smooth && !temporal && Boolean(slots.rife) && ctx.has("FrameInterpolate") && ctx.has("FrameInterpolationModelLoader");
    if (rife) {
      g.phase("interpolating");
      images = g.out("FrameInterpolate", { interp_model: g.out("FrameInterpolationModelLoader", { model_name: slots.rife }), images, multiplier: 2 });
    }
    const smooth = temporal || rife;
    const late = pixel ?? pixelUpscale(g, images, input, { width, height }, ctx);
    images = late.images;
    g.phase("encoding");
    const out = saveVideo(g, ctx, { images, audio: heard, fps: smooth ? LTX_FPS * 2 : LTX_FPS, crf: input.crf });

    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "video", role: "result" }],
      totalSteps: passes.reduce((n, p) => n + p.steps, 0),
      passes,
      loads: [
        ...late.loads,
        ...(picked.unet
          ? [`diffusion_models/${picked.unet}`, `text_encoders/${slots.clip}`, `text_encoders/${slots.projection}`, `vae/${slots.videoVae}`, `vae/${slots.audioVae}`]
          : [`checkpoints/${picked.checkpoint}`, `text_encoders/${slots.clip}`]),
        ...(how.twoPass ? [`latent_upscale_models/${slots.upscaler}`] : []),
        ...(temporal ? [`latent_upscale_models/${slots.temporal}`] : []),
        ...(lora ? [`loras/${lora}`] : []),
        ...input.loras.filter((l) => l.weight !== 0).map((l) => `loras/${l.file}`),
      ],
    };
  },


  variants: ((): Variant<LtxVideo>[] => {
    const one = { checkpoint: "ltx-2.3-22b-distilled-fp8.safetensors", clip: "gemma_3_12B_it.safetensors" };
    const parts = { unet: "SomeoneLTX23_v4.safetensors", videoVae: "LTX23_video_vae.safetensors", audioVae: "LTX23_audio_vae.safetensors", projection: "ltx-2.3_text_projection.safetensors", clip: "gemma_3_12B_it.safetensors" };
    const extras = { upscaler: "ltx-2.3-spatial-upscaler-x2.safetensors", turbo: "ltx_2.3_distilled_lora.safetensors", rife: "rife49.pth" };
    const temporal = { ...extras, temporal: "ltx-2.3-temporal-upscaler-x2-1.0.safetensors" };
    const picture = { width: 832, height: 1216 };
    return [
      { name: "from words, the one checkpoint, one pass (no upscaler)", input: { prompt: "a" }, slots: one },
      { name: "from words, the one checkpoint, two passes", input: { prompt: "a", seconds: 3 }, slots: { ...one, ...extras } },
      { name: "opens on a picture, in separate files, two passes, smooth", input: { prompt: "a", start: "p1", smooth: true }, slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture } },
      {
        name: "from a first to a last picture: one pass, a LoRA",
        input: { prompt: "a", start: "p1", end: "p2", loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }] },
        slots: { ...parts, ...extras }, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      { name: "ends on a picture only", input: { prompt: "a", end: "p2", endStrength: 0.9 }, slots: one, uploads: { end: "b.png" }, media: { end: picture } },
      { name: "SageAttention, an fp8 kernel", input: { prompt: "a", sage: true, sageKernel: "sageattn_qk_int8_pv_fp8_cuda" }, slots: { ...one, ...extras } },
      {
        // the full model: the distilled LoRA goes on it; a schedule of the user's own
        name: "the full model with the distilled LoRA, by steps with a shift, on a timeline's canvas",
        input: { prompt: "a", start: "p1", model: "ltx-2.3-22b-dev.safetensors", schedule: "By steps", steps: 10, maxShift: 2.5, terminal: 0.05, cfg: 3, negative: "blurry" },
        slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture }, canvas: { width: 1024, height: 576 },
      },
      { name: "opens on a picture, one pass asked for, by steps unstretched", input: { prompt: "a", start: "p1", twoPass: false, schedule: "By steps", stretch: false }, slots: { ...one, ...extras }, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "twice the frames with LTX's temporal upscaler, two passes", input: { prompt: "a", start: "p1", smooth: true }, slots: { ...parts, ...temporal }, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "twice the frames with LTX's temporal upscaler, one pass with a last picture", input: { prompt: "a", end: "p2", smooth: true, smoothWith: "LTX temporal (latent)" }, slots: { ...one, ...temporal }, uploads: { end: "b.png" }, media: { end: picture } },
      { name: "RIFE asked for although the temporal upscaler is there", input: { prompt: "a", smooth: true, smoothWith: "RIFE (pixels)" }, slots: { ...one, ...temporal } },
      { name: "a GGUF diffusion model, ComfyUI's own video output", input: { prompt: "a", model: "ltx-2.3-22b-dev-Q4_K_M.gguf" }, slots: { ...parts, ...extras }, has: (n: string) => n !== "VHS_VideoCombine" },
    ];
  })(),
});
