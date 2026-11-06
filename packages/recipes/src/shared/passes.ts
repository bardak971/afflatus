import type { BuildContext, BuiltGraph, GraphBuilder, Ref } from "@afflatus/core";
import { adetail, sized, type AdetailSettings, type DetailWith } from "./adetail";
import { inTiles, redrawInTiles, tilePass, type TileSettings } from "./tiles";

/**
 * The passes every txt2img makes after its first (card #289): the hires fix, whole or in tiles, then Detail, the passes'
 * accounting and the output. Each family's first pass stays its own (SDXL's IP-Adapter and regions, Klein's references,
 * Krea 2's patch and regional pack): it hands its result here with its PictureSampler, the seam that says how that family
 * samples a second pass. The hooks are called where the hand-written copies made their nodes, so that a graph is built in
 * the same order and the golden dump of 0.10.0 still matches it.
 */

type Size = { width: number; height: number };
/** A pass of the job's progress (BuiltGraph.passes). */
type Pass = { node: string; steps: number; pixels?: number };
/** What a pass gives: a latent, or a picture where the family's sampler decodes its own (Klein's) or the tiles were merged. */
export interface Drawn {
  latent?: Ref;
  image?: Ref;
  pass: Pass;
}

/**
 * How a family samples a second pass over an enlarged picture: the hires fix's, and Upscale 2x's light pass (upscale2x). Its
 * texts, model, shift and step rule (flow's Turbo cap, Klein's schedule cut at the strength) are in its closures, each
 * family's as it was: a rule folded here would move some family's steps.
 */
export interface PictureSampler {
  vae: Ref;
  /** The pixels the model draws at: Auto redraws the hires pass in tiles past four times them (2× each side). */
  area: number;
  /** Its passes give pictures and set their own phases (Klein's sampler decodes): the output is not put in "decoding". */
  decodes?: boolean;
  /** The enlarged picture as the pass starts from it, encoded before the "refining" phase (SDXL's); else `whole` encodes it. */
  encode?: (pixels: Ref) => Ref;
  /**
   * The second pass over the whole enlarged picture at `large`: from `start`, what `encode` made of its `pixels` (else they;
   * no pixels for a picture enlarged in latent space, SDXL's).
   */
  whole: (start: Ref, large: Size, pixels?: Ref) => Drawn;
  /**
   * The second pass in tiles: made once before the picture is cut (what every tile shares, a model shifted for a tile or the
   * prompt read alone, is made there), it samples the tiles' latents, `tiles` their pixels, each `tile` px square.
   */
  tiles: (large: Size) => (latent: Ref, tiles: Ref, tile: number) => { latent: Ref; pass: Pass };
}

/** The picture after the hires fix (a latent, or the tiles merged), its passes so far, and the upscale model it loads. */
export type Hired = Omit<Drawn, "pass"> & { passes: Pass[]; loads: string[] };

/** What the hires fix reads of the form besides the family's own pass settings. */
export interface HiresFixSettings extends TileSettings {
  hires: boolean;
  hiresUpscaler: string;
}

/**
 * The hires fix: the first pass's picture enlarged with an upscale model and scaled to `large`, then a second pass over it,
 * whole or (past four times the sampler's area, or asked) in tiles. `latent` enlarges in latent space instead, SDXL's
 * "latent" upscaler: no model, and in tiles the picture is only scaled. The passes come back in their order, the first with
 * its own size when the second is a tile's; `loads` the upscale model. With the hires fix off, the first pass as it is.
 */
export function hiresFix(g: GraphBuilder, ctx: BuildContext, input: HiresFixSettings, s: PictureSampler, first: Drawn, size: Size, large: Size, o: { latent?: boolean } = {}): Hired {
  if (!input.hires) return { latent: first.latent, image: first.image, passes: [first.pass], loads: [] };
  const tiled = inTiles(input, large, s.area);
  g.phase("upscaling");
  if (o.latent && !tiled) {
    const enlarged = g.out("LatentUpscale", { samples: first.latent!, upscale_method: "bilinear", width: large.width, height: large.height, crop: "disabled" });
    g.phase("refining");
    const second = s.whole(enlarged, large);
    return { latent: second.latent, image: second.image, passes: [first.pass, second.pass], loads: [] };
  }
  // upscale models enlarge by their own factor (usually 4×): the result is scaled to the size asked for
  const pixels = first.image ?? g.out("VAEDecode", { samples: first.latent!, vae: s.vae });
  const big = o.latent ? pixels : g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
  const scaled = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: large.width, height: large.height, crop: "disabled" });
  const loads = o.latent ? [] : [`upscale_models/${input.hiresUpscaler}`];
  if (!tiled) {
    const start = s.encode ? s.encode(scaled) : scaled;
    g.phase("refining");
    const second = s.whole(start, large, scaled);
    return { latent: second.latent, image: second.image, passes: [first.pass, second.pass], loads };
  }
  g.phase("refining");
  const sample = s.tiles(large);
  let pass: Pass = { node: "", steps: 0 };
  const image = redrawInTiles(g, ctx, scaled, s.vae, large, input, (latent, tiles, tile) => {
    const done = sample(latent, tiles, tile);
    pass = tilePass(done.pass, large, input);
    return done.latent;
  });
  // each pass at its own size: the first at the picture's first, the tiles at a tile's
  return { image, passes: [{ ...first.pass, pixels: size.width * size.height }, pass], loads };
}

/** A pass a family makes after Detail (Krea 2's person face): the picture, its passes and files, what the job says. */
type After = (image: Ref) => { image: Ref; passes: Pass[]; loads: string[]; warnings: string[] };

/**
 * The end of every txt2img, after the hires fix (`hired`, its loads the caller's to list): the picture decoded, the Detail rows gone over it (`detail`: the family's model and texts, at the
 * hires fix's scale), a pass of the family's own after them (`after`), and the output with its passes (each at its size,
 * `size` then `large`, once a Detail pass says its own), steps, files (`loads`, the after pass's, then the detectors) and
 * warnings.
 */
export function pictureOut(
  g: GraphBuilder, ctx: BuildContext, input: AdetailSettings & { hires: boolean; hiresScale: number }, s: Pick<PictureSampler, "vae" | "decodes">,
  hired: Hired, at: { size: Size; large: Size }, detail: Omit<DetailWith, "scale">, loads: string[], after?: After,
): Pick<BuiltGraph, "graph" | "phases" | "outputs" | "totalSteps" | "passes" | "loads" | "warnings"> {
  if (!s.decodes) g.phase("decoding");
  const { passes } = hired;
  const image = hired.image ?? g.out("VAEDecode", { samples: hired.latent!, vae: s.vae });
  const d = adetail(g, ctx, input, image, { ...detail, scale: input.hires ? input.hiresScale : 1 });
  const then = after?.(d.image) ?? { image: d.image, passes: [], loads: [], warnings: [] };
  const added = [...d.passes, ...then.passes];
  const all = added.length ? [...sized(passes, [at.size.width * at.size.height, at.large.width * at.large.height]), ...added] : passes;
  const warnings = [...d.warnings, ...then.warnings];
  // PreviewImage writes to ComfyUI's temp folder, which ComfyUI clears itself: nothing piles up in output/
  const out = g.add("PreviewImage", { images: then.image });
  return {
    graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: all.reduce((n, p) => n + p.steps, 0), passes: all, loads: [...loads, ...then.loads, ...d.loads],
    ...(warnings.length ? { warnings } : {}),
  };
}
