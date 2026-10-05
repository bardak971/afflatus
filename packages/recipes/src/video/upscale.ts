import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";
import { roundTo } from "../shared/round";
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
  latent: "Latent: re-sampled",
} as const;

/** The nodes that drive RTX VSR: NVIDIA's own pack, or DaSiWa's. Either does. */
export const RTX_NVIDIA = "RTXVideoSuperResolution";
export const RTX_NODE = "DaSiWa_RTX_UpscalerRefiner";
export const RTX_NODES = [RTX_NVIDIA, RTX_NODE];
/** SeedVR2 in ComfyUI's own nodes (0.37): a one-step video restoration model, sampled in temporal chunks. */
export const SEEDVR_NODES = ["ResizeImageMaskNode", "SeedVR2Preprocess", "VAEEncodeTiled", "SeedVR2Conditioning", "KSampler", "SeedVR2TemporalChunk", "SeedVR2TemporalMerge", "VAEDecodeTiled", "SeedVR2PostProcessing", "UNETLoader", "VAELoader"];
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

export interface UpscaleValues {
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
  upscaleColour?: string;
}

/** The inputs of the choice, for a form: the route, the factor, and the model file for the pixel route. */
export function upscaleInputs(opts: { latent?: boolean } = {}): InputSpec[] {
  const routes: string[] = [UPSCALE.off, UPSCALE.model, UPSCALE.rtx, UPSCALE.seedvr, ...(opts.latent ? [UPSCALE.latent] : [])];
  return [
    {
      id: "upscale", type: "choice", label: "Upscale", options: routes, default: UPSCALE.off, section: "out",
      note: `how the clip is made larger after it is generated. Pixel: upscale model — an ESRGAN-type model from models/upscale_models, frame by frame; sharp, fast, may flicker. Pixel: RTX — NVIDIA's RTX Video Super Resolution, video-aware, fast; needs a node that drives it (NVIDIA's own ${RTX_NVIDIA}, or ${RTX_NODE}), Windows and an RTX card. Video: SeedVR2 — a one-step restoration model that sees the whole clip: no flicker, and compression and softness are repaired too; minutes per clip, needs its two files (Settings → Models).${opts.latent ? " Latent: re-sampled — the latent enlarged and sampled again lightly in tiles: real new detail, consistent with the clip; about as long again as the clip." : ""}`,
    },
    {
      id: "upscaleColour", type: "choice", label: "SeedVR2 colour match", options: SEEDVR_COLOURS, default: "lab", section: "out", showWhen: { input: "upscale", in: [UPSCALE.seedvr] },
      note: "the restored frames matched in colour to the originals: lab (the most faithful), wavelet (keeps the new fine detail), adain (a global tint), none",
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
  ];
}

/** The nodes a pixel route needs, for a recipe's node list. RTX: either driver does, so neither is required here (see `UPSCALE_OPTIONAL`). */
export function upscaleNodes(input: UpscaleValues): string[] {
  if (input.upscale === UPSCALE.model) return ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale"];
  if (input.upscale === UPSCALE.seedvr) return SEEDVR_NODES;
  return [];
}
/** What a video recipe lists as optional for the routes: the RTX drivers, the chunking of the pixel route, the GGUF loader. */
export const UPSCALE_OPTIONAL = ["RebatchImages", ...RTX_NODES];

/**
 * The decoded frames, enlarged by the pixel route the form asks for (none for the other routes). `frame`
 * is the clip's own size; the frames come out at `upscaleBy` times it.
 */
export function pixelUpscale(g: GraphBuilder, images: Ref, input: UpscaleValues, frame: { width: number; height: number }, ctx: BuildContext): { images: Ref; loads: string[] } {
  if (input.upscale !== UPSCALE.model && input.upscale !== UPSCALE.rtx && input.upscale !== UPSCALE.seedvr) return { images, loads: [] };
  const big = { width: roundTo(frame.width * input.upscaleBy, 8, 64), height: roundTo(frame.height * input.upscaleBy, 8, 64) };
  g.phase("upscaling");
  if (input.upscale === UPSCALE.model) {
    const model = g.out("UpscaleModelLoader", { model_name: input.upscaleModel });
    // a few frames at a time: the model's own 4× output of a whole clip is tens of GB before it is brought down to size
    const chunked = ctx.has("RebatchImages");
    const batch = chunked ? g.out("RebatchImages", { images, batch_size: 8 }) : images;
    const grown = g.out("ImageUpscaleWithModel", { upscale_model: model, image: batch });
    // upscale models enlarge by their own factor (usually 4×): the frames are then brought to the factor asked for
    const sized = g.out("ImageScale", { image: grown, upscale_method: "lanczos", width: big.width, height: big.height, crop: "disabled" });
    return { images: chunked ? g.out("RebatchImages", { images: sized, batch_size: 4096 }) : sized, loads: [`upscale_models/${input.upscaleModel}`] };
  }
  if (input.upscale === UPSCALE.seedvr) return seedvrUpscale(g, images, input, ctx);
  // NVIDIA's own node first (a choice that brings its own inputs: "resize_type.scale"), else DaSiWa's
  if (ctx.has(RTX_NVIDIA)) {
    return { images: g.out(RTX_NVIDIA, { images, resize_type: "scale by multiplier", "resize_type.scale": Math.min(4, input.upscaleBy), quality: "ULTRA" }), loads: [] };
  }
  if (!ctx.has(RTX_NODE)) throw new Error(`RTX Video Super Resolution needs a node that drives it: NVIDIA's own ${RTX_NVIDIA} (the Nvidia_RTX_Nodes_ComfyUI pack) or ${RTX_NODE} (DaSiWa's "RTX Upscaler & Refiner" pack). Install one in ComfyUI, or pick another upscale route.`);
  return {
    images: g.out(RTX_NODE, {
      images, denoise: false, denoise_quality: "Ultra", deblur: false, deblur_quality: "Ultra", upscale: "VSR", upscale_quality: "Ultra",
      resize_type: "Scale", scale: Math.min(4, input.upscaleBy), megapixels: 2, width: big.width, height: big.height, divisible_by: "8", ratio_preset: "16:9", resize_method: "Center Crop (Fill)", device_id: 0,
    }),
    loads: [],
  };
}

/**
 * SeedVR2, as ComfyUI's own template runs it: the frames enlarged (lanczos) to the size asked for, padded
 * for the model, encoded in tiles, sampled in ONE step in temporal chunks sized to the memory there is,
 * merged, decoded in tiles, then aligned and colour-matched to the enlarged originals. The model restores
 * as it goes: compression, noise and softness come out too. Images go through the same road (one frame).
 */
export function seedvrUpscale(g: GraphBuilder, images: Ref, input: { upscaleBy: number; upscaleColour?: string }, ctx: BuildContext): { images: Ref; loads: string[] } {
  const { slots } = ctx;
  if (!slots.seedvr || !slots.seedvrVae) throw new Error("SeedVR2 needs its two files: a SeedVR2 model in ComfyUI's models/diffusion_models folder and its VAE in models/vae (both are one click in Settings → Models). Or pick another upscale route.");
  const resized = g.out("ResizeImageMaskNode", { input: images, resize_type: "scale by multiplier", "resize_type.multiplier": input.upscaleBy, scale_method: "lanczos" });
  const padded = g.out("SeedVR2Preprocess", { resized_images: resized });
  const vae = g.out("VAELoader", { vae_name: slots.seedvrVae });
  const model = loadUnet(g, ctx, slots.seedvr);
  const latent = g.out("VAEEncodeTiled", { pixels: padded, vae, tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 });
  // chunks as large as the free memory takes, no overlap (the template's setting); the merge is a plain join then
  const chunks = g.add("SeedVR2TemporalChunk", { latent, temporal_overlap: 0, chunking_mode: "auto" });
  const cond = g.add("SeedVR2Conditioning", { model, vae_conditioning: [chunks, 0] });
  g.phase("restoring");
  const sampled = g.out("KSampler", { model, positive: [cond, 0], negative: [cond, 1], latent_image: [chunks, 0], seed: ctx.seed, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 });
  const merged = g.out("SeedVR2TemporalMerge", { latents: sampled, temporal_overlap: [chunks, 1] });
  const decoded = g.out("VAEDecodeTiled", { samples: merged, vae, tile_size: 512, overlap: 128, temporal_size: 64, temporal_overlap: 8 });
  const out = g.out("SeedVR2PostProcessing", { images: decoded, original_resized_images: resized, color_correction_method: input.upscaleColour ?? "lab" });
  return { images: out, loads: [`diffusion_models/${slots.seedvr}`, `vae/${slots.seedvrVae}`] };
}
