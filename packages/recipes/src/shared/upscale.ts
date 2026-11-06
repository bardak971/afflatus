import type { BuildContext, BuiltGraph, GraphBuilder, InputSpec, Ref } from "@afflatus/core";
import { UPSCALER_DEFAULT, UPSCALER_PREFER } from "./hires";
import type { PictureSampler } from "./passes";
import { inTiles, redrawInTiles, tilePass, type TileSettings } from "./tiles";

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

/** What every Upscale 2x reads of its form besides its family's own pass settings. */
export interface Upscale2xSettings extends TileSettings, RefineColourMatch {
  upscaler: string;
  refine: boolean;
}

/**
 * Upscale 2x, written once (card #289): the source enlarged by an upscale model and scaled to `size`, then, with `refine`, a
 * light img2img pass over it, whole or (past four times `area`, or asked) in tiles, colour matched back after. The family's
 * sampler is made while loading, told whether the pass goes in tiles (what only the whole pass reads is made there, Klein's
 * texts with the source), with the files it loads; its `encode` is made there too (SDXL's). `alpha`: the model decodes an alpha
 * too, which ColorTransfer does not take.
 */
export function upscale2x(
  g: GraphBuilder, ctx: BuildContext, input: Upscale2xSettings, size: { width: number; height: number }, area: number,
  sampler: (tiled: boolean, source: Ref) => Omit<PictureSampler, "area"> & { loads: string[] }, o: { alpha?: boolean } = {},
): Pick<BuiltGraph, "graph" | "phases" | "outputs" | "totalSteps" | "passes" | "loads"> {
  const source = g.out("LoadImage", { image: ctx.uploads.source });
  g.phase("upscaling");
  const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.upscaler }), image: source });
  // upscale models enlarge by their own factor (usually 4×): scaled to exactly the size asked
  const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
  const loads = [`upscale_models/${input.upscaler}`];
  if (!input.refine) {
    const out = g.add("PreviewImage", { images: sized });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads };
  }
  const tiled = inTiles(input, size, area);
  g.phase("loading");
  const s = sampler(tiled, source);
  let pass: { node: string; steps: number; pixels?: number } = { node: "", steps: 0 };
  let picture: Ref;
  if (tiled) {
    g.phase("refining");
    const sample = s.tiles(size);
    picture = redrawInTiles(g, ctx, sized, s.vae, size, input, (latent, tiles, tile) => {
      const done = sample(latent, tiles, tile);
      // the pass runs once for each tile, at a tile's size
      pass = tilePass(done.pass, size, input);
      return done.latent;
    });
  } else {
    const start = s.encode ? s.encode(sized) : sized;
    g.phase("refining");
    const done = s.whole(start, size, sized);
    pass = done.pass;
    if (done.image) picture = done.image;
    else {
      g.phase("decoding");
      picture = g.out("VAEDecode", { samples: done.latent!, vae: s.vae });
    }
  }
  g.phase("decoding");
  // ColorTransfer takes the colours only: a decode with an alpha gives them alone (the picture is opaque, its source too)
  if (o.alpha && input.colourMatch && ctx.has("ColorTransfer")) picture = g.out("SplitImageWithAlpha", { image: picture });
  const out = g.add("PreviewImage", { images: refineColourMatched(g, ctx, picture, sized, input) });
  return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...loads, ...s.loads] };
}
