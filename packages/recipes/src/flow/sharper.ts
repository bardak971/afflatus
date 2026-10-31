import { defineRecipe, GraphBuilder, roundTo, type Recipe, type Ref } from "@afflatus/core";
import { FACTOR_INPUT, REFINE_COLOUR_MATCH_INPUT, refineColourMatched, UPSCALER_PREFER, type RefineColourMatch, type UpscaleSettings } from "../sdxl/common";
import { redrawInTiles, tileInputs, tilePass, tilesOf, inTiles, type TileSettings } from "../shared/tiles";
import { rowsWhile } from "../shared/addedRows";
import { PASS_NOISE, PASS_NOISE_INPUT, type PassNoise } from "../shared/passNoise";
import { photo, SAME_PICTURE, type FlowBase, type FlowKit, type FlowSpec } from "./kit";

export interface FlowSharper extends FlowBase, UpscaleSettings, TileSettings, RefineColourMatch { source: string; prompt: string; upscaler: string; refine: boolean; strength: number; passNoise?: PassNoise }

/** Past this many pixels, Auto makes the light pass in tiles: a picture that large is past what the model draws whole. */
const REFINE_WHOLE_PIXELS = 3.2e6;

/**
 * Upscale 2x: the picture enlarged by an upscale model, then a light img2img pass so it does not look smeared,
 * over the whole picture or (asked, or Auto past REFINE_WHOLE_PIXELS) in tiles. Never skipped for its size: a
 * ComfyUI without the tile nodes says so (TILES_NEEDED), and a picture asked whole is gone over whole.
 */
export function flowSharper(spec: FlowSpec, kit: FlowKit): Recipe<FlowSharper> {
  const { inputs, SECOND_PASS, load, cond, sample, tuned, noiseWords, secondPass } = kit;
  const files = spec.files;
  // the "?" of its denoise: the real noise 0.25 starts from at the pass's default steps, on the largest picture gone over whole
  // (a 768×1024 enlarged to 1536×2048) and in tiles of 1024 (card #146)
  const lightSteps = (steps: number) => Math.max(3, Math.round(Math.min(30, steps) * 0.5));
  const strengthNoise = noiseWords(0.25, lightSteps(spec.sampling.steps), [
    { size: { width: 1536, height: 2048 }, where: "on a 1536×2048 gone over whole" },
    { size: { width: 1024, height: 1024 }, where: "in tiles" },
  ]);
  return defineRecipe<FlowSharper>({
    id: `${spec.family}.sharper`,
    family: spec.family,
    version: 1,
    title: "Upscale 2x",
    summary: "Upscales an image to twice its size with an upscale model, then a low-denoise img2img pass so it does not look smeared.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image", note: "the picture it works on" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "what is in the picture: it helps the img2img pass", style: "sentences", optional: true, default: "" },
      { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "4x-UltraSharp.pth", prefer: UPSCALER_PREFER, section: "out" },
      FACTOR_INPUT,
      { id: "refine", type: "toggle", label: "img2img pass after upscale", note: "a light pass with the model; past about 3 megapixels it is made in tiles", default: true, section: "out" },
      { id: "strength", type: "number", label: "Denoising strength", ...(strengthNoise ? { note: strengthNoise } : {}), min: 0.05, max: 0.6, step: 0.01, default: 0.25, showWhen: "refine", advanced: true, section: "out" },
      REFINE_COLOUR_MATCH_INPUT,
      ...tileInputs("refine"),
      PASS_NOISE_INPUT,
      // (Turbo's LoRA is put on only with the img2img pass: without it no model is loaded)
      ...rowsWhile(inputs, { input: "refine", is: true }),
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: () => ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "PreviewImage"],
    // the second pass: only when it is asked for. All are ComfyUI's own nodes.
    optionalNodes: [...SECOND_PASS, "ColorTransfer"],
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
      const light = { steps: lightSteps(k.steps) };
      let pass: { node: string; steps: number; pixels?: number } = { node: "", steps: light.steps };
      let picture: Ref;
      if (tiled) {
        // each tile is a picture its own size to the model: the shift for that size
        const { tile } = tilesOf(size, input);
        const at = secondPass(g, k.model, input, { width: tile, height: tile }, light.steps, input.strength);
        picture = redrawInTiles(g, ctx, sized, k.vae, size, input, (l) => {
          const done = sample(g, k, input, at.model, c, l, ctx.seed, { ...light, denoise: at.denoise });
          pass = tilePass(done.pass, size, input);
          return done.latent;
        });
      } else {
        const at = secondPass(g, k.model, input, size, light.steps, input.strength);
        const done = sample(g, k, input, at.model, c, g.out("VAEEncode", { pixels: sized, vae: k.vae }), ctx.seed, { ...light, denoise: at.denoise });
        pass = done.pass;
        g.phase("decoding");
        picture = g.out("VAEDecode", { samples: done.latent, vae: k.vae });
      }
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: refineColourMatched(g, ctx, picture, sized, input) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...loads, ...k.loads] };
    },
    variants: [
      { name: "enlarged and gone over", input: { source: "p", upscaler: "u.pth" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "only enlarged", input: { source: "p", upscaler: "u.pth", refine: false } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "gone over, no colour match", input: { source: "p", upscaler: "u.pth", colourMatch: false } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "too large to go over whole: in tiles", input: { source: "p", upscaler: "u.pth" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "too large, asked whole: gone over whole", input: { source: "p", upscaler: "u.pth", tiles: "Whole picture" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "a fine-tune with its shift, a prompt and a LoRA", input: { source: "p", upscaler: "u.pth", prompt: "a", ...tuned } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      // card #146's two other readings of the denoise, for side-by-sides
      { name: "the light pass at the 1 MP shift", input: { source: "p", upscaler: "u.pth", passNoise: PASS_NOISE.oneMp } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "the light pass from the real σ, in tiles", input: { source: "p", upscaler: "u.pth", passNoise: PASS_NOISE.real } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      // Turbo's branch: the LoRA put on, its steps at CFG 1 (the operations' other variants have no turbo file)
      ...(kit.turboFiles ? [{ name: "Turbo with its LoRA", input: { source: "p", upscaler: "u.pth", fast: true, turboSteps: 6 } as Partial<FlowSharper>, slots: kit.turboFiles, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } }] : []),
    ],
  });
}
