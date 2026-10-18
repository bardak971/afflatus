import { latentUpscaleSize, type BuildContext, type GraphBuilder, type Ref } from "@afflatus/core";
import { UPSCALE } from "../video/upscale";
import type { H3Video } from "./inputs";
import { AUTO_SAMPLER } from "./model";

/**
 * The third-party MiniMax H3 node pack (Comfyui-MMH3-UltimateUpscale) the "Latent: re-sampled" upscale runs on: the pass itself, the two
 * splits it works in, and the two ways of enlarging the latent (one of the two is used, by the upscaler's file).
 */
export const H3_LATENT_UPSCALE_NODES = ["MMH3UltimateUpscale", "MMH3SpatialSplitParams", "MMH3TemporalSplitParams"];
export const H3_LATENT_ENLARGE_NODES = ["MMH3LatentUpscaleWithModelParams", "MMH3LatentUpscaleParams"];
const NO_PACK = `The "Latent: re-sampled" upscale runs on the MiniMax H3 upscale nodes of the Comfyui-MMH3-UltimateUpscale pack (bbaudio-2025), which this ComfyUI does not have. Install the pack, or pick another upscale route.`;

/**
 * How many pieces the re-sample samples one after another, each with its own steps: the stretches of frames
 * (upscaleChunk long, overlapping by 17) times the tiles of the enlarged frame (upscaleTile wide, overlapping by
 * upscaleOverlap). The node reports each piece's steps from 1 again: this is what the progress bar counts them
 * against. Worked out the way the node's settings say to split; a piece more or less only moves when the bar ends.
 */
export function latentUpscaleRounds(input: Pick<H3Video, "upscaleBy" | "upscaleTile" | "upscaleOverlap" | "upscaleChunk">, frame: { width: number; height: number }, frames: number): number {
  const big = latentUpscaleSize(frame, input.upscaleBy);
  const along = (n: number) => Math.max(1, Math.ceil((n - input.upscaleOverlap) / Math.max(1, input.upscaleTile - input.upscaleOverlap)));
  const stretches = Math.max(1, Math.ceil((frames - 17) / Math.max(1, input.upscaleChunk - 17)));
  return along(big.width) * along(big.height) * stretches;
}

/**
 * H3's latent upscaler when the form enlarges with it (Recipe.needsWith): a pod is sent it for that job only, never for a
 * plain one. Optional and asked by nobody, it was never fetched: Timeline 19's finishes on a pod fell back to a plain
 * resize, and came out blurred over the whole clip (2026-10-18).
 */
export const latentUpscaleNeeds = (input: Pick<H3Video, "upscale" | "upscaleWith">): string[] => (input.upscale === UPSCALE.latent && input.upscaleWith !== "Plain resize" ? ["latentUpscaler"] : []);

/** What a render enlarged by a plain resize where H3's latent upscaler was asked for says on its job; null otherwise. */
export function plainResizeSaid(input: Pick<H3Video, "upscale" | "upscaleWith">, ctx: BuildContext): string | null {
  if (!latentUpscaleNeeds(input).length || (ctx.slots.latentUpscaler && ctx.has("MMH3LatentUpscaleWithModelParams"))) return null;
  return ctx.slots.latentUpscaler
    ? "Enlarged by a plain resize: this ComfyUI's Afflatus node pack has no latent upscaler node."
    : "Enlarged by a plain resize: H3's latent upscaler is not on this ComfyUI (Settings › Models has it).";
}

/**
 * The upscale pass: the finished latent enlarged, then re-sampled lightly, one stretch of frames and one
 * tile at a time (the node offloads the model between the two, so both fit where one does). The sound
 * is carried through untouched. The same model, sampler and conditioning as the clip. Without the latent
 * route picked, the latent as it is. `latent`: the sampled latent (a continuation's with the clip before's own tokens in its overlap).
 */
export function latentUpscalePass(g: GraphBuilder, ctx: BuildContext, input: H3Video, pass: { model: Ref; positive: Ref; latent: Ref; turbo: boolean; width: number; height: number }): Ref {
  const { slots } = ctx;
  const { model, positive, latent, turbo, width, height } = pass;
  if (input.upscale !== UPSCALE.latent) return latent;
  // the queue refuses up front on nodes(); this is for a build that reaches here with the pack gone
  if (H3_LATENT_UPSCALE_NODES.some((n) => !ctx.has(n))) throw new Error(NO_PACK);
  const big = latentUpscaleSize({ width, height }, input.upscaleBy);
  // H3's own upscaler while its file is there, else a plain resize, as the form's note says
  const withModel = input.upscaleWith !== "Plain resize" && Boolean(slots.latentUpscaler) && ctx.has("MMH3LatentUpscaleWithModelParams");
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
    model, conditioning: positive, latent, noise: g.out("RandomNoise", { noise_seed: ctx.seed + 1 }),
    sampler: g.out("KSamplerSelect", { sampler_name: input.sampler !== AUTO_SAMPLER ? input.sampler : turbo ? "euler" : "res_multistep" }),
    sigmas: g.out("BasicScheduler", { model, scheduler: input.scheduler, steps: input.upscaleSteps, denoise: input.upscaleDenoise }),
    cfg: 1, latent_upscale_param: enlarge, temporal_split_param: stretches, spatial_split_param: tiles,
  });
}
