import { defineRecipe, GraphBuilder, roundTo, type LoraValue, type Ref, type SizeValue } from "@afflatus/core";
import { HIRES_PASS_INPUTS, hiresPass, isVPred, loadSdxl, PREDICTION_INPUTS, PREDICTION_NODES, SDXL_PRESETS, UPSCALER_PREFER } from "./common";
import { DEFAULT_NEGATIVE, SDXL_UNION } from "./family";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, kSample, withoutDaemon, type DetailSettings } from "../shared/detail";
import { applyGuide, guideInputs, guideNodes, type GuideSettings } from "../shared/guide";
import { redrawInTiles, tileInputs, tileNodes, TILES_ON, tilesOf, inTiles, type TileSettings } from "../shared/tiles";
import { SDXL_AREA } from "./common";

export interface SdxlTextToPicture extends DetailSettings, GuideSettings, TileSettings {
  prompt: string;
  /** Tags put in front of the prompt on every render with this model. */
  quality: string;
  negative: string;
  checkpoint: string;
  loras: LoraValue[];
  size: SizeValue;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  prediction: string;
  rescale: number;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
  hiresSampler: string;
  hiresScheduler: string;
  seed: number;
}

/** The hi-res pass can enlarge in latent space (no extra model) or through an upscale model. */
const LATENT_UPSCALE = "latent";

export const sdxlTextToPicture = defineRecipe<SdxlTextToPicture>({
  id: "sdxl.text-to-picture",
  family: "sdxl",
  version: 1,
  title: "txt2img",
  summary: "Text to image: an image from a tag prompt, with optional hires fix.",
  output: "image",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt", style: "tags", placeholder: "terrace at sunset, woman holding a cup, warm light" },
    { id: "negative", type: "prompt", label: "Negative prompt", style: "tags", optional: true, default: DEFAULT_NEGATIVE, perModel: true },
    { id: "checkpoint", type: "model", label: "Checkpoint", folder: "checkpoints" },
    { id: "loras", type: "loras", label: "LoRAs", max: 8 },
    {
      id: "size", type: "size", label: "Size", default: "tall", grid: 8, min: 256, max: 2048, perModel: true,
      shapes: [
        { id: "tall", label: "Portrait", width: 832, height: 1216 },
        { id: "square", label: "Square", width: 1024, height: 1024 },
        { id: "wide", label: "Landscape", width: 1216, height: 832 },
        { id: "tall-9-16", label: "Portrait 9:16", width: 768, height: 1344 },
        { id: "wide-16-9", label: "Landscape 16:9", width: 1344, height: 768 },
      ],
    },
    ...DETAIL_INPUTS,
    ...guideInputs(SDXL_UNION),
    // checkpoints differ in the quality tags they were trained with ("masterpiece, best quality", "score_9, …")
    { id: "quality", type: "prompt", label: "Quality tags", note: "put in front of the prompt on every render with this checkpoint", style: "tags", optional: true, default: "", advanced: true, perModel: true },
    { id: "steps", type: "number", label: "Steps", min: 1, max: 100, step: 1, default: 28, advanced: true, perModel: true },
    { id: "cfg", type: "number", label: "CFG scale", note: "how closely it follows the prompt", min: 1, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler_ancestral", advanced: true, perModel: true },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "normal", advanced: true, perModel: true },
    { id: "clipSkip", type: "number", label: "Clip skip", note: "1 = SDXL's own, which is already the second-last layer: what Civitai calls \"clip skip 2\" (Pony, Illustrious). Only raise it when a checkpoint's card asks for more than that", min: 1, max: 4, step: 1, default: 1, advanced: true, perModel: true },
    ...PREDICTION_INPUTS,
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", note: "past 2×, the second pass is redrawn in tiles (see Redraw)", min: 1.1, max: 4, step: 0.05, default: 1.5, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      // an upscale model when there is one: the enlarged latent is noisy and asks for a denoise that redraws the picture
      options: { node: "UpscaleModelLoader", input: "model_name" }, extra: [LATENT_UPSCALE], default: "4xNomos8kSC.pth", prefer: UPSCALER_PREFER,
    },
    {
      id: "hiresDenoise", type: "number", label: "Denoising strength", min: 0.05, max: 0.9, step: 0.05, default: 0.45, showWhen: "hires", advanced: true, perModel: true,
      note: "how much the second pass may redraw. With an upscale model 0.3 to 0.45 keeps the picture and sharpens it; enlarging in latent space needs 0.5 or more, or it stays soft",
    },
    { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: 15, showWhen: "hires", advanced: true, perModel: true },
    ...HIRES_PASS_INPUTS,
    ...tileInputs("hires"),
    { id: "seed", type: "seed", label: "Seed" },
  ],
  presets: SDXL_PRESETS,
  optionalNodes: DETAIL_OPTIONAL,

  nodes(input) {
    const W2 = roundTo(roundTo(input.size.width, 8, 64) * input.hiresScale, 8, 64);
    const H2 = roundTo(roundTo(input.size.height, 8, 64) * input.hiresScale, 8, 64);
    const tiled = input.hires && inTiles(input, { width: W2, height: H2 }, SDXL_AREA);
    return [
      ...detailNodes(input),
      ...guideNodes(input),
      ...tileNodes(tiled),
      "CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "VAEDecode", "PreviewImage",
      ...fullPassNodes(input, input.steps), ...(input.hires ? ["KSampler"] : []),
      ...(input.loras.length ? ["LoraLoader"] : []),
      ...(input.clipSkip > 1 ? ["CLIPSetLastLayer"] : []),
      ...(isVPred(input) ? (input.rescale > 0 ? PREDICTION_NODES : ["ModelSamplingDiscrete"]) : []),
      ...(!input.hires
        ? []
        : input.hiresUpscaler === LATENT_UPSCALE
          ? (tiled ? ["ImageScale"] : ["LatentUpscale"])
          : ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"]),
    ];
  },

  build(input, ctx) {
    const g = new GraphBuilder();
    const loaded = loadSdxl(g, input, input.prompt);
    const { model, vae } = loaded;
    const W = roundTo(input.size.width, 8, 64);
    const H = roundTo(input.size.height, 8, 64);
    const empty = g.out("EmptyLatentImage", { width: W, height: H, batch_size: 1 });
    // a guide picture holds the shapes of the picture drawn whole; tiles are pieces, redrawn from the text alone
    const guided = applyGuide(g, ctx, { positive: loaded.positive, negative: loaded.negative }, vae, { width: W, height: H }, input);

    g.phase("sampling");
    const sampler = { model, ...guided, seed: ctx.seed, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler };
    let latent = kSample(g, { ...sampler, latent_image: empty, steps: input.steps, denoise: 1 }, input, ctx);
    let totalSteps = input.steps;
    const passes = [{ node: latent[0], steps: input.steps }];

    const W2 = roundTo(W * input.hiresScale, 8, 64);
    const H2 = roundTo(H * input.hiresScale, 8, 64);
    let image: Ref | null = null;
    if (input.hires && inTiles(input, { width: W2, height: H2 }, SDXL_AREA)) {
      g.phase("upscaling");
      const pixels = g.out("VAEDecode", { samples: latent, vae });
      const big = input.hiresUpscaler === LATENT_UPSCALE ? pixels : g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
      const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W2, height: H2, crop: "disabled" });
      g.phase("refining");
      const pass = { ...sampler, positive: loaded.positive, negative: loaded.negative, ...hiresPass(input), steps: input.hiresSteps, denoise: input.hiresDenoise };
      let tileSampler = "";
      image = redrawInTiles(g, ctx, sized, vae, { width: W2, height: H2 }, input, (l) => {
        const out = kSample(g, { ...pass, latent_image: l }, input, ctx);
        tileSampler = out[0];
        return out;
      });
      // the pass runs once for each tile
      const rounds = input.hiresSteps * tilesOf({ width: W2, height: H2 }, input).count;
      totalSteps += rounds;
      passes.push({ node: tileSampler, steps: rounds });
    } else if (input.hires) {
      g.phase("upscaling");
      let enlarged: Ref;
      if (input.hiresUpscaler === LATENT_UPSCALE) {
        enlarged = g.out("LatentUpscale", { samples: latent, upscale_method: "bilinear", width: W2, height: H2, crop: "disabled" });
      } else {
        // upscale models enlarge by their own factor (usually 4×): scale the result to the size asked for
        const pixels = g.out("VAEDecode", { samples: latent, vae });
        const up = g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler });
        const big = g.out("ImageUpscaleWithModel", { upscale_model: up, image: pixels });
        const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W2, height: H2, crop: "disabled" });
        enlarged = g.out("VAEEncode", { pixels: sized, vae });
      }
      g.phase("refining");
      latent = kSample(g, { ...sampler, ...hiresPass(input), latent_image: enlarged, steps: input.hiresSteps, denoise: input.hiresDenoise }, input, ctx);
      totalSteps += input.hiresSteps;
      passes.push({ node: latent[0], steps: input.hiresSteps });
    }

    g.phase("decoding");
    image ??= g.out("VAEDecode", { samples: latent, vae });
    // PreviewImage writes to ComfyUI's temp folder, which ComfyUI clears itself: nothing piles up in output/
    const out = g.add("PreviewImage", { images: image });
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps,
      passes,
      loads: [`checkpoints/${input.checkpoint}`],
    };
  },

  variants: [
    { name: "plain", input: { prompt: "a", checkpoint: "x.safetensors" } },
    {
      name: "LoRAs, clip skip, wide",
      input: {
        prompt: "a", checkpoint: "x.safetensors", clipSkip: 2, size: { width: 1216, height: 832 },
        loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }],
      },
    },
    { name: "hi-res fix, latent", input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresUpscaler: LATENT_UPSCALE } },
    { name: "a v-prediction checkpoint, read from its name", input: { prompt: "a", checkpoint: "noobaiXL_vPred10.safetensors" } },
    { name: "said to be v-prediction, without the CFG rescale", input: { prompt: "a", checkpoint: "mystery.safetensors", prediction: "v-prediction (zsnr)", rescale: 0 } },
    { name: "detail boost (built-in sharpen)", input: { prompt: "a", checkpoint: "x.safetensors", detail: true }, has: withoutDaemon },
    { name: "a guide picture's edges", input: { prompt: "a", checkpoint: "x.safetensors", guide: "g.png", guideModel: "union.safetensors" }, uploads: { guide: "g.png" } },
    { name: "a guide picture that is a depth map already", input: { prompt: "a", checkpoint: "x.safetensors", guide: "g.png", guideFollows: "Already a guide map", guideModel: "union.safetensors" }, uploads: { guide: "g.png" } },
    { name: "hires fix 3× in tiles, upscale model", input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresScale: 3, hiresUpscaler: "u.pth" } },
    { name: "hires fix in tiles asked for, latent", input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresUpscaler: LATENT_UPSCALE, tiles: TILES_ON, detail: true }, has: withoutDaemon },
    {
      name: "hi-res fix, upscale model",
      input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresUpscaler: "u.pth", hiresScale: 2, sampler: "dpmpp_2m", scheduler: "karras" },
    },
  ],
});
