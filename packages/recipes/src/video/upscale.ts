import { LATENT_RESAMPLE, roundTo, wanted, type BuildContext, type GraphBuilder, type InputSpec, type Ref } from "@afflatus/core";
import { loadUnet } from "../shared/unet";

/**
 * The upscale routes a video form offers, as one choice: none; a pixel upscale model (ESRGAN and the
 * like, frame by frame) on the decoded frames; NVIDIA's RTX Video Super Resolution, video-aware, through
 * a node that drives it; and, where the model has one, a latent pass of its own (H3's re-sampling, kept
 * in the recipe). The pixel routes run after the frames are decoded and interpolated, so the upscaler
 * sees the final frames.
 */

export const UPSCALE = {
  off: "Off",
  model: "Pixel: upscale model",
  rtx: "Pixel: RTX Video Super Resolution",
  seedvr: "Video: SeedVR2 (restores)",
  latent: LATENT_RESAMPLE,
} as const;

/** The nodes that drive RTX VSR: NVIDIA's own pack, or the RTX Upscaler & Refiner pack. Either does. */
const RTX_NVIDIA = "RTXVideoSuperResolution";
const RTX_NODE = "DaSiWa_RTX_UpscalerRefiner";
export const RTX_NODES = [RTX_NVIDIA, RTX_NODE];
/** The routes that enlarge the decoded frames, after which the RCAS sharpen can run. */
const PIXEL_ROUTES: string[] = [UPSCALE.model, UPSCALE.rtx, UPSCALE.seedvr];
/** KJNodes' sharpen, whose RCAS method is the one offered. */
export const SHARPEN_NODE = "ImageSharpenKJ";
/** SeedVR2 in ComfyUI's own nodes (0.37): a one-step video restoration model, sampled in temporal chunks. */
/**
 * Frames SeedVR2 restores together (4n + 1). Its own "auto" asked the free memory and, at 1.7 Mpx a frame (a 576 × 736 clip
 * doubled), with 10 GB free, chose ONE: every frame a pass of its own (the model set up again each time, a 5 s clip still
 * not done after 13 minutes) and no frame seeing its neighbours, which is what keeps a video steady. Measured 2026-10-08 on
 * a 12 GB card, 3B int8, a 141-frame clip doubled to 1152 × 1472: 9 frames 257 s, 13 frames 318 s, 21 frames ran out of video
 * memory (the card spilled into system memory at a third of its power).
 */
const SEEDVR_CHUNK = 9;
/** The frame size SEEDVR_CHUNK was measured at (576 × 736 doubled), in megapixels: larger frames take proportionally fewer. */
const SEEDVR_CHUNK_AT_MPX = 1.7;
/**
 * How many frames SeedVR2 restores together: as many as asked (rounded to 4n + 1), else SEEDVR_CHUNK scaled down for larger
 * frames (memory goes with frames × pixels; at 3× or 4×, nine frames would spill out of video memory and crawl) and up to it
 * for smaller ones. Measured on one card (12 GB): the setting is there for any other.
 */
export function seedvrChunk(megapixels: number, asked = 0): number {
  const fourN1 = (n: number) => Math.max(1, Math.floor((n - 1) / 4) * 4 + 1);
  // a number asked for goes to the nearest of 1, 5, 9 … (a tie to the fewer frames, the lighter on memory): the 4, 8 … 48
  // the form's arrows once gave, still in older drafts, then run 5, 9 … 49, not one frame at a time for 4
  if (asked > 0) return Math.max(1, Math.ceil((Math.round(asked) - 1) / 4 - 0.5) * 4 + 1);
  return fourN1(Math.min(SEEDVR_CHUNK, (SEEDVR_CHUNK * SEEDVR_CHUNK_AT_MPX) / Math.max(0.1, megapixels)));
}
/**
 * SeedVR2 7B's window, the owner's pick from card #148's test (2026-10-28, an A40, 124 frames doubled to 2048 × 1152): 49
 * frames (13 latent) with 2 latent frames shared by neighbouring passes, which ComfyUI's merge crossfades. Three passes
 * instead of 25 of 5 frames, the model step the same 27 s, no bump at the joins, and cleaner to his eye.
 */
const SEEDVR_7B_FRAMES = 49;
const SEEDVR_7B_OVERLAP = 2;
/** The narrowest 7B window: two latent frames, so that each still sees a neighbour. */
const SEEDVR_7B_FLOOR = 5;
/**
 * ComfyUI's own law for its "auto" chunk (comfy/ldm/seedvr/constants.py, fitted on the 3B in fp16): the sampler takes 0.55
 * GiB per latent frame and megapixel, beside 8.5 GiB for the model and torch and four times a 0.55 GiB spread.
 */
const SEEDVR_GIB_PER_MPX_LATENT = 0.55;
const SEEDVR_RESERVED_GIB = 8.5 + 4 * 0.55;

/** Whether a SeedVR2 model file is the 7B (plain or sharp, any precision): Comfy-Org's and numz's names both say "7b". */
export const isSeedvr7b = (file: string | undefined): boolean => /(^|[^0-9])7b/i.test(file ?? "");

/**
 * The window SeedVR2 restores in, and the latent frames neighbouring passes share. The 3B: seedvrChunk, no overlap, as
 * before card #148 (its window was never tried wider). The 7B: the frames asked for, else SEEDVR_7B_FRAMES where the card
 * holds them by ComfyUI's law on its whole memory (`vram`, GiB), else the widest 4n + 1 it holds, never under
 * SEEDVR_7B_FLOOR; a card not known, the 12 GB rule (seedvrChunk) with the same floor. ComfyUI's own "auto" asks what is
 * free when the chunk is cut, and on a 12 GB card chose one frame a pass. The overlap from 13 frames up, where each pass
 * still moves on two latent frames or more; below, it would run every frame twice or more.
 */
export function seedvrWindow(megapixels: number, opts: { asked?: number; big?: boolean; vram?: number } = {}): { frames: number; overlap: number } {
  const asked = opts.asked ?? 0;
  if (!opts.big) return { frames: seedvrChunk(megapixels, asked), overlap: 0 };
  const frames = asked > 0 ? seedvrChunk(megapixels, asked) : seedvr7bFits(megapixels, opts.vram);
  return { frames, overlap: frames >= 13 ? SEEDVR_7B_OVERLAP : 0 };
}

function seedvr7bFits(megapixels: number, vram: number | undefined): number {
  if (!vram) return Math.max(SEEDVR_7B_FLOOR, seedvrChunk(megapixels));
  const latents = Math.floor((vram - SEEDVR_RESERVED_GIB) / (SEEDVR_GIB_PER_MPX_LATENT * Math.max(0.1, megapixels)));
  return Math.max(SEEDVR_7B_FLOOR, Math.min(SEEDVR_7B_FRAMES, 4 * (latents - 1) + 1));
}
export const SEEDVR_NODES = ["ResizeImageMaskNode", "SeedVR2Preprocess", "VAEEncode", "SeedVR2Conditioning", "KSampler", "SeedVR2TemporalChunk", "SeedVR2TemporalMerge", "VAEDecode", "SeedVR2PostProcessing", "UNETLoader", "VAELoader"];
/** What every video family (and the image tools) declare to hold SeedVR2's two files. */
export const SEEDVR_SLOTS = [
  {
    id: "seedvr", label: "SeedVR2 model (video upscale)", folder: "diffusion_models", detect: ["seedvr2.*3b", "seedvr2"], optional: true,
    hint: "Optional, 3.4 GB: with a SeedVR2 model in ComfyUI's models/diffusion_models folder, the \"Video: SeedVR2\" upscale route restores and enlarges clips with the whole clip in view (no flicker). The 3B model; the 7B one (8 GB) is sharper and slower.",
    get: { file: "seedvr2_3b_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors" },
  },
  {
    id: "seedvrVae", label: "SeedVR2 VAE", folder: "vae", detect: ["seedvr2.*vae"], optional: true,
    hint: "The VAE that goes with the SeedVR2 model: seedvr2_ema_vae_fp16.safetensors in ComfyUI's models/vae folder.",
    get: { file: "seedvr2_ema_vae_fp16.safetensors", url: "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors" },
  },
];
export const SEEDVR_COLOURS = ["lab", "wavelet", "adain", "none"];

/**
 * SeedVR2's two files for a render that upscales with it (Recipe.needsWith): a pod is sent them for that job only. Not
 * asked, a fresh pod was given the job with the plain form's files, and its build refused it once boot and fetch were paid.
 */
export const upscaleNeeds = (input: { upscale?: string }): string[] => (input.upscale === UPSCALE.seedvr ? SEEDVR_SLOTS.map((s) => s.id) : []);

export interface UpscaleValues {
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
  /** SeedVR2: frames restored together; 0 = the model's own (see seedvrWindow). */
  seedvrFrames?: number;
  /** RCAS after a pixel route, 0 to 1; 0 (the default) = off (see `sharpened`). */
  upscaleSharpen?: number;
}

/** The inputs of the choice, for a form: the route, the factor, and the model file for the pixel route. */
export function upscaleInputs(opts: { latent?: boolean } = {}): InputSpec[] {
  const routes: string[] = [UPSCALE.off, UPSCALE.model, UPSCALE.rtx, UPSCALE.seedvr, ...(opts.latent ? [UPSCALE.latent] : [])];
  return [
    {
      id: "upscale", type: "choice", label: "Upscale", options: routes, default: UPSCALE.off, section: "out",
      note: `how the clip is made larger after it is generated. Pixel: upscale model — an ESRGAN-type model from models/upscale_models, frame by frame; sharp, fast, may flicker. Pixel: RTX — NVIDIA's RTX Video Super Resolution, video-aware, fast; needs an NVIDIA RTX card and a node that drives it (NVIDIA's own ${RTX_NVIDIA}, or DaSiWa's ${RTX_NODE}, installed on first use); without them it upscales with an upscale model, else a plain resize. Video: SeedVR2 — a one-step restoration model that sees the whole clip: no flicker, and compression and softness are repaired too; minutes per clip, needs its two files (Settings → Models).${opts.latent ? " Latent: re-sampled — the latent enlarged and sampled again lightly in tiles: real new detail, consistent with the clip; about as long again as the clip." : ""}`,
    },
    {
      id: "upscaleColour", type: "choice", label: "SeedVR2 colour match", options: SEEDVR_COLOURS, default: "lab", section: "out", showWhen: { input: "upscale", in: [UPSCALE.seedvr] },
      note: "the restored frames matched in colour to the originals: lab (the most faithful), wavelet (keeps the new fine detail), adain (a global tint), none",
    },
    {
      id: "seedvrFrames", type: "number", label: "SeedVR2 frames together", min: 1, max: 49, step: 4, default: 0, auto: "auto", section: "out", advanced: true, showWhen: { input: "upscale", in: [UPSCALE.seedvr] },
      note: "SeedVR2's window: how many frames it restores together in one pass (1, 5, 9, 13…), each seeing the others. Wider is steadier from frame to frame and has fewer joins. Auto (the left end): the 7B takes 49, with 2 latent frames crossfaded between passes, or the widest the card holds, never under 5; the 3B goes by the frame's size (9 at about 1.7 megapixels, fewer for larger frames). More frames need more video memory; past what the card holds it spills into system memory and slows to a crawl, and fewer is then faster",
    },
    {
      id: "upscaleBy", type: "number", label: "Upscale factor", min: 1.25, max: 3, step: 0.25, default: 2, unit: " ×", section: "out",
      showWhen: { input: "upscale", in: routes.filter((r) => r !== UPSCALE.off) },
      note: "the final frame is said under the aspect ratio",
    },
    {
      // a 2× model first: the usual 2× asked for needs no 4×-then-down round trip, which costs time and softens
      id: "upscaleModel", type: "choice", label: "Upscale model", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "2xNomosUni_span_multijpg.pth", prefer: ["^2x.*nomos", "^2x|_x2", "nomosuni.*span", "nomos8ksc", "nomos", "ultrasharp", "realesrgan", "esrgan", "animesharp", "nmkd", "."], section: "out",
      showWhen: { input: "upscale", in: [UPSCALE.model] },
      note: "from models/upscale_models. The model enlarges by its own factor, then the frames are resized to the factor asked for: a 2× model (2xNomosUni_span_multijpg, RealESRGAN_x2plus) is the direct road for ×2. NomosUni_span is fast, steady from frame to frame and forgiving of compression; Nomos8kSC is sharper on clean footage; UltraSharp and ESRGAN tend to flicker",
    },
    {
      id: "upscaleSharpen", type: "number", label: "RCAS sharpen", min: 0, max: 1, step: 0.05, default: 0, section: "out",
      showWhen: { input: "upscale", in: PIXEL_ROUTES },
      note: `RCAS (AMD FSR's robust contrast-adaptive sharpen) on the upscaled frames: crisps the edges an upscale leaves soft, without the halos of a plain sharpen or unsharp mask. 0.3 is a usual amount; 0 = off. Needs KJNodes (${SHARPEN_NODE})`,
    },
  ];
}

/**
 * The upscaled frames through RCAS at the strength asked for, or as they are: when no pixel route ran (the
 * latent route samples real detail and is left alone), the strength is 0, or this ComfyUI has no KJNodes.
 */
export function sharpened(g: GraphBuilder, ctx: BuildContext, images: Ref, input: { upscale: string; upscaleSharpen?: number }): Ref {
  const strength = input.upscaleSharpen ?? 0;
  if (strength <= 0 || !PIXEL_ROUTES.includes(input.upscale) || !wanted(ctx, { input: "upscaleSharpen", nodes: [SHARPEN_NODE], without: "RCAS sharpen" })) return images;
  // a choice that brings its own inputs, as RTX's "resize_type.scale": the strength belongs to the method picked
  return g.out(SHARPEN_NODE, { image: images, method: "rcas", "method.strength": Math.min(1, strength) });
}

/** The nodes a pixel route needs, for a recipe's node list. RTX: either driver does, so neither is required here (see `UPSCALE_OPTIONAL`). */
export function upscaleNodes(input: Pick<UpscaleValues, "upscale">): string[] {
  if (input.upscale === UPSCALE.model) return ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale"];
  if (input.upscale === UPSCALE.seedvr) return SEEDVR_NODES;
  return [];
}
/** What a video recipe lists as optional for the routes: the RTX drivers, the chunking of the pixel route, the RCAS sharpen. */
export const UPSCALE_OPTIONAL = ["RebatchImages", ...RTX_NODES, SHARPEN_NODE];

/**
 * The decoded frames, enlarged by the pixel route the form asks for (none for the other routes). `frame`
 * is the clip's own size; the frames come out at `upscaleBy` times it.
 */
export function pixelUpscale(g: GraphBuilder, images: Ref, input: UpscaleValues, frame: { width: number; height: number }, ctx: BuildContext): { images: Ref; loads: string[] } {
  if (input.upscale !== UPSCALE.model && input.upscale !== UPSCALE.rtx && input.upscale !== UPSCALE.seedvr) return { images, loads: [] };
  const big = { width: roundTo(frame.width * input.upscaleBy, 8, 64), height: roundTo(frame.height * input.upscaleBy, 8, 64) };
  g.phase("upscaling");
  // RTX VSR without a node that drives it (its pack not there, not wanted, or a card that cannot run it): the upscale model
  // the form names when this ComfyUI has it, else its first one, else a plain resize. The job says which (ctx.wants)
  const fallback = input.upscale === UPSCALE.rtx ? rtxFallback(ctx, input.upscaleModel) : null;
  const driver = input.upscale === UPSCALE.rtx ? wanted(ctx, { input: "upscale", nodes: RTX_NODES, without: "RTX VSR", instead: fallback ? `upscaled with ${fallback} instead` : "a plain resize instead" }) : null;
  if (input.upscale === UPSCALE.rtx && !driver && !fallback) {
    return { images: g.out("ImageScale", { image: images, upscale_method: "lanczos", width: big.width, height: big.height, crop: "disabled" }), loads: [] };
  }
  if (input.upscale === UPSCALE.model || (input.upscale === UPSCALE.rtx && !driver)) {
    const file = input.upscale === UPSCALE.model ? input.upscaleModel : fallback!;
    const model = g.out("UpscaleModelLoader", { model_name: file });
    // a few frames at a time: the model's own 4× output of a whole clip is tens of GB before it is brought down to size
    const chunked = ctx.has("RebatchImages");
    const batch = chunked ? g.out("RebatchImages", { images, batch_size: 8 }) : images;
    const grown = g.out("ImageUpscaleWithModel", { upscale_model: model, image: batch });
    // upscale models enlarge by their own factor (usually 4×): the frames are then brought to the factor asked for
    const sized = g.out("ImageScale", { image: grown, upscale_method: "lanczos", width: big.width, height: big.height, crop: "disabled" });
    return { images: chunked ? g.out("RebatchImages", { images: sized, batch_size: 4096 }) : sized, loads: [`upscale_models/${file}`] };
  }
  if (input.upscale === UPSCALE.seedvr) return seedvrUpscale(g, images, input, ctx, big);
  // NVIDIA's own node first (a choice that brings its own inputs: "resize_type.scale"), else the other pack's
  if (driver === RTX_NVIDIA) {
    return { images: g.out(RTX_NVIDIA, { images, resize_type: "scale by multiplier", "resize_type.scale": Math.min(4, input.upscaleBy), quality: "ULTRA" }), loads: [] };
  }
  return {
    images: g.out(RTX_NODE, {
      images, denoise: false, denoise_quality: "Ultra", deblur: false, deblur_quality: "Ultra", upscale: "VSR", upscale_quality: "Ultra",
      resize_type: "Scale", scale: Math.min(4, input.upscaleBy), megapixels: 2, width: big.width, height: big.height, divisible_by: "8", ratio_preset: "16:9", resize_method: "Center Crop (Fill)", device_id: 0,
    }),
    loads: [],
  };
}

/**
 * The upscale model RTX VSR falls back on where no node drives it: the one the form names when this ComfyUI has it, else the
 * first it has; null when it has none or cannot say (a plain resize then).
 */
function rtxFallback(ctx: BuildContext, named: string): string | null {
  const there = ctx.options?.("UpscaleModelLoader", "model_name") ?? [];
  return there.includes(named) ? named : (there[0] ?? null);
}

/**
 * SeedVR2, as ComfyUI's own template runs it: the frames enlarged (lanczos) to the size asked for, padded
 * for the model, encoded, sampled in ONE step in temporal chunks sized to the memory there is, merged,
 * decoded, then aligned and colour-matched to the enlarged originals. The model restores as it goes:
 * compression, noise and softness come out too. Images go through the same road (one frame).
 *
 * The encode and decode are ComfyUI's plain ones, not the template's tiled nodes: its SeedVR2 VAE runs
 * time in slices of its own (the tiled nodes' temporal sizes are ignored) and sizes the frame itself, from
 * a fitted estimate of what a decode needs against the card's free memory: whole when it fits, else in
 * the largest tiles that do. The template's fixed 512 px tiles with 128 of overlap encoded and decoded
 * the frame about 1.7 times over, a pass each with its own temporal caches. On an A40, 124 frames doubled
 * to 2048 × 1152 (card #137): 824 s with them, 491 s without (encode 200 → 114 s, decode 561 → 303 s),
 * the same frames and colour; the model itself takes under 30 s either way, the rest is the VAE.
 */
export function seedvrUpscale(g: GraphBuilder, images: Ref, input: { upscaleBy: number; upscaleColour?: string; seedvrFrames?: number }, ctx: BuildContext, size?: { width: number; height: number }): { images: Ref; loads: string[] } {
  const { slots } = ctx;
  if (!slots.seedvr || !slots.seedvrVae) throw new Error("SeedVR2 needs its two files: a SeedVR2 model in ComfyUI's models/diffusion_models folder and its VAE in models/vae (both are one click in Settings → Models). Or pick another upscale route.");
  // (the picture tool calls this directly: its preparation and encode are the upscale, not a model load)
  g.phase("upscaling");
  const resized = g.out("ResizeImageMaskNode", { input: images, resize_type: "scale by multiplier", "resize_type.multiplier": input.upscaleBy, scale_method: "lanczos" });
  const padded = g.out("SeedVR2Preprocess", { resized_images: resized });
  const vae = g.out("VAELoader", { vae_name: slots.seedvrVae });
  const model = loadUnet(g, ctx, slots.seedvr);
  const latent = g.out("VAEEncode", { pixels: padded, vae });
  // a fixed window (see seedvrWindow), counted in pixel frames; the overlap is in latent frames, crossfaded by the merge
  const { frames, overlap } = seedvrWindow(size ? (size.width * size.height) / 1e6 : SEEDVR_CHUNK_AT_MPX, { asked: input.seedvrFrames ?? 0, big: isSeedvr7b(slots.seedvr), vram: ctx.vram });
  const chunks = g.add("SeedVR2TemporalChunk", { latent, temporal_overlap: overlap, chunking_mode: "manual", "chunking_mode.frames_per_chunk": frames });
  const cond = g.add("SeedVR2Conditioning", { model, vae_conditioning: [chunks, 0] });
  g.phase("restoring");
  const sampled = g.out("KSampler", { model, positive: [cond, 0], negative: [cond, 1], latent_image: [chunks, 0], seed: ctx.seed, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 });
  const merged = g.out("SeedVR2TemporalMerge", { latents: sampled, temporal_overlap: [chunks, 1] });
  const decoded = g.out("VAEDecode", { samples: merged, vae });
  const out = g.out("SeedVR2PostProcessing", { images: decoded, original_resized_images: resized, color_correction_method: input.upscaleColour ?? "lab" });
  return { images: out, loads: [`diffusion_models/${slots.seedvr}`, `vae/${slots.seedvrVae}`] };
}
