import { defineRecipe, GraphBuilder, roundTo, type LoraValue, type Ref, type SizeValue } from "@afflatus/core";
import { pictureForm } from "../shared/pictureForm";
import { HIRES_PASS_INPUTS, hiresPass, isVPred, loadSdxl, modelInputs, PREDICTION_NODES, samplingInputs, SDXL_DROPS, SDXL_PRESETS, UPSCALER_DEFAULT, UPSCALER_PREFER } from "./common";
import { SDXL_GUIDE } from "./family";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, kSample, withoutDaemon, type DetailSettings } from "../shared/detail";
import { applyGuide, FOLLOW_MAP, guideInputs, guideNeeds, guideNodes, type GuideSettings } from "../shared/guide";
import { IP_ADAPTER_INPUTS, IP_FILES, IP_REFUSES, ipAdapterNeeds, ipAdapterNodes, withIpAdapter, type ReferenceSettings } from "../shared/references";
import { redrawInTiles, tileInputs, tileNodes, TILES_ON, tilePass, inTiles, type TileSettings } from "../shared/tiles";
import { SDXL_AREA } from "./common";
import { adetail, ADETAIL_OPTIONAL, adetailInputs, adetailNeeds, ALL_DETAIL, DETECTOR_FILES, SDXL_FACE_DENOISE, sized, type AdetailSettings } from "../shared/adetail";

export interface SdxlTextToPicture extends DetailSettings, GuideSettings, TileSettings, AdetailSettings, ReferenceSettings {
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

export const sdxlTextToPicture = pictureForm("txt2img", defineRecipe<SdxlTextToPicture>({
  id: "sdxl.text-to-picture",
  family: "sdxl",
  version: 1,
  title: "txt2img",
  summary: "Text to image: an image from a tag prompt, with optional hires fix.",
  output: "image",
  inputs: [
    { id: "prompt", type: "prompt", label: "Prompt", style: "tags", placeholder: "terrace at sunset, woman holding a cup, warm light" },
    ...IP_ADAPTER_INPUTS,
    ...guideInputs(SDXL_GUIDE),
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
    ...adetailInputs("tags", "", SDXL_FACE_DENOISE),
    ...DETAIL_INPUTS,
    // the checkpoint, its LoRAs and how it samples: the rows of the SDXL tools, which the skeleton lays out (pictureForm)
    ...modelInputs,
    ...samplingInputs(28).filter((i) => i.id !== "seed"),
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", note: "past 2×, the second pass is redrawn in tiles (see Redraw)", min: 1.1, max: 4, step: 0.05, default: 1.5, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      // an upscale model when there is one: the enlarged latent is noisy and asks for a denoise that redraws the picture
      options: { node: "UpscaleModelLoader", input: "model_name" }, extra: [LATENT_UPSCALE], default: UPSCALER_DEFAULT, prefer: UPSCALER_PREFER,
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
  // a person's reference image with another is refused before it is queued, and said by the form (card #280)
  refuses: IP_REFUSES,
  optionalNodes: [...DETAIL_OPTIONAL, ...ADETAIL_OPTIONAL],
  // the Detail rows ask for their detectors, reference images for IP-Adapter's files, a guide picture for its ControlNet
  needsWith: (input, slots, where) => [...adetailNeeds(input, slots, where), ...ipAdapterNeeds(input), ...guideNeeds(input, SDXL_GUIDE)],

  nodes(input) {
    const W2 = roundTo(roundTo(input.size.width, 8, 64) * input.hiresScale, 8, 64);
    const H2 = roundTo(roundTo(input.size.height, 8, 64) * input.hiresScale, 8, 64);
    const tiled = input.hires && inTiles(input, { width: W2, height: H2 }, SDXL_AREA);
    return [
      ...detailNodes(input),
      ...guideNodes(input, SDXL_GUIDE),
      ...ipAdapterNodes(input),
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
    const { vae } = loaded;
    // reference images put on the checkpoint by IP-Adapter: every pass of the picture draws with them, the Detail rows too
    const referenced = withIpAdapter(g, ctx, loaded.model, input);
    const model = referenced.model;
    const W = roundTo(input.size.width, 8, 64);
    const H = roundTo(input.size.height, 8, 64);
    const empty = g.out("EmptyLatentImage", { width: W, height: H, batch_size: 1 });
    // a guide picture holds the shapes of the picture drawn whole; tiles are pieces, redrawn from the text alone
    const guided = applyGuide(g, ctx, SDXL_GUIDE, { model, positive: loaded.positive, negative: loaded.negative }, vae, { width: W, height: H }, input);

    g.phase("sampling");
    const sampler = { model, positive: guided.positive, negative: guided.negative, seed: ctx.seed, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler };
    let latent = kSample(g, { ...sampler, latent_image: empty, steps: input.steps, denoise: 1 }, input, ctx);
    let totalSteps = input.steps;
    const passes: Array<{ node: string; steps: number; pixels?: number }> = [{ node: latent[0], steps: input.steps }];

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
      // the pass runs once for each tile, at a tile's size; the first at the picture's first size
      const rounds = tilePass({ node: tileSampler, steps: input.hiresSteps }, { width: W2, height: H2 }, input);
      totalSteps += rounds.steps;
      passes[0] = { ...passes[0]!, pixels: W * H };
      passes.push(rounds);
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
    // the Detail rows: faces, hands, people redrawn by the checkpoint (its LoRAs on, the guide picture's shapes not: they are
    // the whole picture's), each crop at the size it draws best; a prompt of its own after the checkpoint's quality tags
    const d = adetail(g, ctx, input, image, {
      model: () => model, clip: loaded.clip, vae,
      cond: (text) => (text ? { positive: g.out("CLIPTextEncode", { text: [input.quality.trim().replace(/,\s*$/, ""), text].filter(Boolean).join(", "), clip: loaded.clip }), negative: loaded.negative } : { positive: loaded.positive, negative: loaded.negative }),
      steps: input.steps, cfg: input.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: ctx.seed, scale: input.hires ? input.hiresScale : 1,
    });
    // PreviewImage writes to ComfyUI's temp folder, which ComfyUI clears itself: nothing piles up in output/
    const out = g.add("PreviewImage", { images: d.image });
    const all = d.passes.length ? [...sized(passes, [W * H, W2 * H2]), ...d.passes] : passes;
    return {
      graph: g.graph,
      phases: g.phases,
      outputs: [{ node: out, kind: "image", role: "result" }],
      totalSteps: totalSteps + d.passes.reduce((n, p) => n + p.steps, 0),
      passes: all,
      loads: [`checkpoints/${input.checkpoint}`, ...referenced.loads, ...guided.loads, ...d.loads],
      ...(d.warnings.length ? { warnings: d.warnings } : {}),
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
    { name: "Detail: face, hands and person", input: { prompt: "a", checkpoint: "x.safetensors", ...ALL_DETAIL }, slots: DETECTOR_FILES },
    { name: "Detail: hands after a hires fix, with a LoRA", input: { prompt: "a", checkpoint: "x.safetensors", detailHands: true, hires: true, hiresUpscaler: "u.pth", loras: [{ file: "l.safetensors", weight: 0.8 }] }, slots: DETECTOR_FILES },
    { name: "a v-prediction checkpoint, read from its name", input: { prompt: "a", checkpoint: "noobaiXL_vPred10.safetensors" } },
    { name: "said to be v-prediction, without the CFG rescale", input: { prompt: "a", checkpoint: "mystery.safetensors", prediction: "v-prediction (zsnr)", rescale: 0 } },
    { name: "detail boost (built-in sharpen)", input: { prompt: "a", checkpoint: "x.safetensors", detail: true }, has: withoutDaemon },
    { name: "a guide picture's edges", input: { prompt: "a", checkpoint: "x.safetensors", guide: "g.png", guideModel: "union.safetensors" }, uploads: { guide: "g.png" } },
    { name: "a guide picture that is a depth map already", input: { prompt: "a", checkpoint: "x.safetensors", guide: "g.png", guideFollows: FOLLOW_MAP, guideModel: "union.safetensors" }, uploads: { guide: "g.png" } },
    { name: "a guide picture's pose, on the family's ControlNet", input: { prompt: "a", checkpoint: "x.safetensors", guide: "g.png", guideFollows: "Pose" }, slots: { controlnet: SDXL_GUIDE.file }, uploads: { guide: "g.png" } },
    {
      name: "reference images: a style and a place (IP-Adapter Plus), with hires fix",
      input: { prompt: "a", checkpoint: "x.safetensors", references: [{ asset: "a", role: "style" }, { asset: "b", role: "place" }], hires: true, hiresUpscaler: "u.pth" },
      slots: IP_FILES, uploads: { "references.0": "a.png", "references.1": "b.png" },
    },
    {
      name: "a person's reference image (FaceID), with hires fix",
      input: { prompt: "a", checkpoint: "x.safetensors", references: [{ asset: "a", role: "person" }], hires: true, hiresUpscaler: "u.pth" },
      slots: IP_FILES, uploads: { "references.0": "a.png" },
    },
    { name: "hires fix 3× in tiles, upscale model", input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresScale: 3, hiresUpscaler: "u.pth" } },
    { name: "hires fix in tiles asked for, latent", input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresUpscaler: LATENT_UPSCALE, tiles: TILES_ON, detail: true }, has: withoutDaemon },
    {
      name: "hi-res fix, upscale model",
      input: { prompt: "a", checkpoint: "x.safetensors", hires: true, hiresUpscaler: "u.pth", hiresScale: 2, sampler: "dpmpp_2m", scheduler: "karras" },
    },
  ],
}), SDXL_DROPS);
