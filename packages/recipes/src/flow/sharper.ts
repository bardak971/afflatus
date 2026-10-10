import { defineRecipe, GraphBuilder, roundTo, type Recipe, type Ref } from "@afflatus/core";
import { FACTOR_INPUT, UPSCALER_PREFER, type UpscaleSettings } from "../sdxl/common";
import { redrawInTiles, tileInputs, tilesOf, inTiles, type TileSettings } from "../shared/tiles";
import { photo, SAME_PICTURE, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

export interface FlowSharper extends FlowBase, UpscaleSettings, TileSettings { source: string; prompt: string; upscaler: string; refine: boolean; strength: number }

/** Past this many pixels, Auto makes the light pass in tiles: a picture that large is past what the model draws whole. */
export const REFINE_WHOLE_PIXELS = 3.2e6;

/**
 * Upscale 2x: the picture enlarged by an upscale model, then a light img2img pass so it does not look smeared,
 * over the whole picture or (asked, or Auto past REFINE_WHOLE_PIXELS) in tiles. Never skipped for its size: a
 * ComfyUI without the tile nodes says so (TILES_NEEDED), and a picture asked whole is gone over whole.
 */
export function flowSharper(spec: FlowSpec, kit: FlowKit): Recipe<FlowSharper> {
  const { inputs, SECOND_PASS, load, shiftedAt, cond, sample, tuned } = kit;
  const files = spec.files;
  return defineRecipe<FlowSharper>({
    id: `${spec.family}.sharper`,
    family: spec.family,
    version: 1,
    title: "Upscale 2x",
    summary: "Upscales an image to twice its size with an upscale model, then a low-denoise img2img pass so it does not look smeared.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "what is in the picture: it helps the img2img pass", style: "sentences", optional: true, default: "" },
      { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "4x-UltraSharp.pth", prefer: UPSCALER_PREFER, section: "out" },
      FACTOR_INPUT,
      { id: "refine", type: "toggle", label: "img2img pass after upscale", note: "a light pass with the model; past about 3 megapixels it is made in tiles", default: true, section: "out" },
      { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 0.6, step: 0.01, default: 0.25, showWhen: "refine", advanced: true, section: "out" },
      ...tileInputs("refine"),
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: () => ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "PreviewImage"],
    // the second pass: only when it is asked for. All are ComfyUI's own nodes.
    optionalNodes: SECOND_PASS,
    build(input, ctx) {
      const g = new GraphBuilder();
      const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
      const size = { width: roundTo(from.width * input.factor, 16), height: roundTo(from.height * input.factor, 16) };
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      g.phase("upscaling");
      const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.upscaler }), image: source });
      // upscale models enlarge by their own factor (usually 4x): scaled to exactly twice the picture
      const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      const loads = [`upscale_models/${input.upscaler}`];
      if (!input.refine) {
        const out = g.add("PreviewImage", { images: sized });
        return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads };
      }
      const tiled = inTiles(input, size, REFINE_WHOLE_PIXELS / 4);
      g.phase("loading");
      const k = load(g, input, ctx);
      const c = cond(g, k, input, input.prompt.trim() || SAME_PICTURE);
      g.phase("refining");
      const light = { steps: Math.max(3, Math.round(Math.min(30, k.steps) * 0.5)), denoise: input.strength };
      let pass = { node: "", steps: light.steps };
      let picture: Ref;
      if (tiled) {
        // each tile is a picture its own size to the model: the shift for that size
        const { tile, count } = tilesOf(size, input);
        const model = shiftedAt(g, k.model, input, { width: tile, height: tile });
        picture = redrawInTiles(g, ctx, sized, k.vae, size, input, (l) => {
          const done = sample(g, k, input, model, c, l, ctx.seed, light);
          pass = { ...done.pass, steps: done.pass.steps * count };
          return done.latent;
        });
      } else {
        const done = sample(g, k, input, shiftedAt(g, k.model, input, size), c, g.out("VAEEncode", { pixels: sized, vae: k.vae }), ctx.seed, light);
        pass = done.pass;
        g.phase("decoding");
        picture = g.out("VAEDecode", { samples: done.latent, vae: k.vae });
      }
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: picture });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...loads, ...k.loads] };
    },
    variants: [
      { name: "enlarged and gone over", input: { source: "p", upscaler: "u.pth" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "only enlarged", input: { source: "p", upscaler: "u.pth", refine: false } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "too large to go over whole: in tiles", input: { source: "p", upscaler: "u.pth" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "too large, asked whole: gone over whole", input: { source: "p", upscaler: "u.pth", tiles: "Whole picture" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "a fine-tune with its shift, a prompt and a LoRA", input: { source: "p", upscaler: "u.pth", prompt: "a", ...tuned } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
    ],
  });
}
