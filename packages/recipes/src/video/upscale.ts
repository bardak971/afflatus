import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

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
  latent: "Latent: re-sampled",
} as const;
export type UpscaleRoute = (typeof UPSCALE)[keyof typeof UPSCALE];

/** The node that drives RTX VSR. Any node that does it would do; this is the one known. */
export const RTX_NODE = "DaSiWa_RTX_UpscalerRefiner";

export interface UpscaleValues {
  upscale: string;
  upscaleBy: number;
  upscaleModel: string;
}

/** The inputs of the choice, for a form: the route, the factor, and the model file for the pixel route. */
export function upscaleInputs(opts: { latent?: boolean } = {}): InputSpec[] {
  const routes: string[] = [UPSCALE.off, UPSCALE.model, UPSCALE.rtx, ...(opts.latent ? [UPSCALE.latent] : [])];
  return [
    {
      id: "upscale", type: "choice", label: "Upscale", options: routes, default: UPSCALE.off, section: "out",
      note: `how the clip is made larger after it is generated. Pixel: upscale model — an ESRGAN-type model from models/upscale_models, frame by frame; sharp, fast, may flicker. Pixel: RTX — NVIDIA's RTX Video Super Resolution, video-aware, fast; needs a node that drives it (${RTX_NODE} is one), Windows and an RTX card.${opts.latent ? " Latent: re-sampled — the latent enlarged and sampled again lightly in tiles: real new detail, consistent with the clip; about as long again as the clip." : ""}`,
    },
    {
      id: "upscaleBy", type: "number", label: "Upscale factor", min: 1.25, max: 3, step: 0.25, default: 2, unit: " ×", section: "out",
      showWhen: { input: "upscale", in: routes.filter((r) => r !== UPSCALE.off) },
      note: "the final frame is said under the aspect ratio",
    },
    {
      id: "upscaleModel", type: "choice", label: "Upscale model", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "4xNomosUni_span_multijpg.pth", prefer: ["nomosuni.*span", "nomos8ksc", "nomos", "ultrasharp", "realesrgan", "esrgan", "animesharp", "nmkd", "."], section: "out",
      showWhen: { input: "upscale", in: [UPSCALE.model] },
      note: "from models/upscale_models. The model enlarges by its own factor (usually 4×), then the frames are resized to the factor asked for. For video: 4xNomosUni_span (fast, steady from frame to frame, forgiving of compression) or 4xNomos8kSC (sharper on clean footage); UltraSharp and ESRGAN tend to flicker",
    },
  ];
}

/** The nodes a pixel route needs, for a recipe's node list. */
export function upscaleNodes(input: UpscaleValues): string[] {
  if (input.upscale === UPSCALE.model) return ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale"];
  if (input.upscale === UPSCALE.rtx) return [RTX_NODE];
  return [];
}

/** A frame on a grid of 8, as encoders want it. */
const r8 = (n: number) => Math.max(64, Math.round(n / 8) * 8);

/**
 * The decoded frames, enlarged by the pixel route the form asks for (none for the other routes). `frame`
 * is the clip's own size; the frames come out at `upscaleBy` times it.
 */
export function pixelUpscale(g: GraphBuilder, images: Ref, input: UpscaleValues, frame: { width: number; height: number }, ctx: BuildContext): { images: Ref; loads: string[] } {
  if (input.upscale !== UPSCALE.model && input.upscale !== UPSCALE.rtx) return { images, loads: [] };
  const big = { width: r8(frame.width * input.upscaleBy), height: r8(frame.height * input.upscaleBy) };
  g.phase("upscaling");
  if (input.upscale === UPSCALE.model) {
    const model = g.out("UpscaleModelLoader", { model_name: input.upscaleModel });
    const grown = g.out("ImageUpscaleWithModel", { upscale_model: model, image: images });
    // upscale models enlarge by their own factor (usually 4×): the frames are then brought to the factor asked for
    return { images: g.out("ImageScale", { image: grown, upscale_method: "lanczos", width: big.width, height: big.height, crop: "disabled" }), loads: [`upscale_models/${input.upscaleModel}`] };
  }
  if (!ctx.has(RTX_NODE)) throw new Error(`RTX Video Super Resolution needs a node that drives it: ${RTX_NODE} (DaSiWa's "RTX Upscaler & Refiner" pack) is one. Install it in ComfyUI, or pick another upscale route.`);
  return {
    images: g.out(RTX_NODE, {
      images, denoise: false, denoise_quality: "Ultra", deblur: false, deblur_quality: "Ultra", upscale: "VSR", upscale_quality: "Ultra",
      resize_type: "Scale", scale: Math.min(4, input.upscaleBy), megapixels: 2, width: big.width, height: big.height, divisible_by: "8", ratio_preset: "16:9", resize_method: "Center Crop (Fill)", device_id: 0,
    }),
    loads: [],
  };
}
