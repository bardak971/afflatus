import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";
import { UPSCALER_DEFAULT, UPSCALER_PREFER } from "./hires";

/** How much "Upscale" enlarges. */
export interface UpscaleSettings {
  factor: number;
}
export const FACTOR_INPUT: InputSpec = { id: "factor", type: "number", label: "Upscale by", note: "2 doubles each edge. The light pass after it is made in tiles when the result is large", min: 1.5, max: 4, step: 0.5, default: 2, unit: "×", section: "out" };

/** Whether Upscale's light pass is colour matched back to the enlarged picture it started from. */
export interface RefineColourMatch {
  colourMatch: boolean;
}
export const REFINE_COLOUR_MATCH_INPUT: InputSpec = {
  id: "colourMatch", type: "toggle", label: "Colour match after the pass", default: true, showWhen: "refine", section: "out",
  note: "the img2img pass can shift the colours slightly: this pulls them back to the upscaled source's (ComfyUI's ColorTransfer, Reinhard in Lab)",
};
/**
 * The light pass's result with its colours matched back to the enlarged picture before the pass: that one has
 * the original's colours at the same size, so only the drift the pass made is taken out, not the detail it
 * added. Nothing when it is off or this ComfyUI has no ColorTransfer (an optional node of every Upscale 2x).
 */
export function refineColourMatched(g: GraphBuilder, ctx: BuildContext, refined: Ref, enlarged: Ref, input: Partial<RefineColourMatch>): Ref {
  if (!input.colourMatch || !ctx.has("ColorTransfer")) return refined;
  return g.out("ColorTransfer", { image_target: refined, image_ref: enlarged, method: "reinhard_lab", source_stats: "uniform", strength: 1 });
}

/** The Upscaler row of every Upscale 2x (SDXL, FLUX and its kin, Klein): one row, one default. */
export const UPSCALER_INPUT: InputSpec = { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: UPSCALER_DEFAULT, prefer: UPSCALER_PREFER, section: "out" };
