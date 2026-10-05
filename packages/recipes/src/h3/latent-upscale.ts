import type { BuildContext, GraphBuilder, Ref } from "@afflatus/core";
import { UPSCALE } from "../video/upscale";
import type { H3Video } from "./inputs";
import { AUTO_SAMPLER } from "./model";

/**
 * The third-party MiniMax H3 node pack, which the "Latent: re-sampled" upscale runs on: the pass itself, the two
 * splits it works in, and the two ways of enlarging the latent (one of the two is used, by the upscaler's file).
 */
export const H3_LATENT_UPSCALE_NODES = ["MMH3UltimateUpscale", "MMH3SpatialSplitParams", "MMH3TemporalSplitParams"];
export const H3_LATENT_ENLARGE_NODES = ["MMH3LatentUpscaleWithModelParams", "MMH3LatentUpscaleParams"];
const NO_PACK = `The "Latent: re-sampled" upscale runs on DaSiWa's MiniMax H3 nodes (the ComfyUI-DaSiWa-Nodes pack), which this ComfyUI does not have. Install the pack, or pick another upscale route.`;

/**
 * The upscale pass: the finished latent enlarged, then re-sampled lightly, one stretch of frames and one
 * tile at a time (the node offloads the model between the two, so both fit where one does). The sound
 * is carried through untouched. The same model, sampler and conditioning as the clip. Without the latent
 * route picked, the sampled latent as it is.
 */
export function latentUpscalePass(g: GraphBuilder, ctx: BuildContext, input: H3Video, pass: { model: Ref; positive: Ref; sampled: string; turbo: boolean; width: number; height: number }): Ref {
  const { slots } = ctx;
  const { model, positive, sampled, turbo, width, height } = pass;
  if (input.upscale !== UPSCALE.latent) return [sampled, 0];
  // the queue refuses up front on nodes(); this is for a build that reaches here with the pack gone
  if (H3_LATENT_UPSCALE_NODES.some((n) => !ctx.has(n))) throw new Error(NO_PACK);
  const r32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);
  const big = { width: r32(width * input.upscaleBy), height: r32(height * input.upscaleBy) };
  const withModel = input.upscaleWith !== "Plain resize" && Boolean(slots.latentUpscaler) && ctx.has("MMH3LatentUpscaleWithModelParams");
  if (input.upscaleWith === "H3's latent upscaler" && !withModel) throw new Error("H3's latent upscaler was not found: put minimax_h3_latent_upscaler_3d_*.safetensors in ComfyUI's models/latent_upscale_models folder, or set the upscale pass to a plain resize.");
  if (!withModel && !ctx.has("MMH3LatentUpscaleParams")) throw new Error(NO_PACK);
  g.phase("upscaling");
  const enlarge = withModel
    ? g.out("MMH3LatentUpscaleWithModelParams", { model_name: slots.latentUpscaler, ...big, device: "cuda", precision: "fp16", offload_model: true })
    : g.out("MMH3LatentUpscaleParams", { method: "bicubic", ...big });
  const tiles = g.out("MMH3SpatialSplitParams", {
    upscale_width: big.width, upscale_height: big.height, tile_size_mode: "specific_size", tile_width: input.upscaleTile, tile_height: input.upscaleTile, grid_rows: 2, grid_cols: 2,
    spatial_w_overlap: input.upscaleOverlap, spatial_h_overlap: input.upscaleOverlap, fade_width: 64, fade_height: 64, min_tile_size: 256,
    overlap_mode: "later", overlap_blend: "linear", masked_area_noise: 0.05, brightness_match: true, dynamic_fade: "widening", dynamic_fade_min: 32,
  });
  const stretches = g.out("MMH3TemporalSplitParams", { chunk_length: input.upscaleChunk, temporal_overlap: 17, anchor_strength: 0.999 });
  g.phase("refining");
  return g.out("MMH3UltimateUpscale", {
    model, conditioning: positive, latent: [sampled, 0], noise: g.out("RandomNoise", { noise_seed: ctx.seed + 1 }),
    sampler: g.out("KSamplerSelect", { sampler_name: input.sampler !== AUTO_SAMPLER ? input.sampler : turbo ? "euler" : "res_multistep" }),
    sigmas: g.out("BasicScheduler", { model, scheduler: input.scheduler, steps: input.upscaleSteps, denoise: input.upscaleDenoise }),
    cfg: 1, latent_upscale_param: enlarge, temporal_split_param: stretches, spatial_split_param: tiles,
  });
}
