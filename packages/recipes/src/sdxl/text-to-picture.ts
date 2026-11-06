import { defineRecipe, GraphBuilder, roundTo, withQuality, type LoraValue, type Ref, type RegionValue, type SizeValue } from "@afflatus/core";
import { pictureForm } from "../shared/pictureForm";
import { isVPred, loadSdxl, modelInputs, PREDICTION_NODES, samplingInputs, SDXL_DROPS, SDXL_PRESETS } from "./common";
import { hiresInputs, hiresPass, UPSCALER_DEFAULT } from "../shared/hires";
import { SDXL_GUIDE } from "./family";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, kSample, withoutDaemon, type DetailSettings } from "../shared/detail";
import { applyGuide, FOLLOW_MAP, guideInputs, guideNeeds, guideNodes, type GuideSettings } from "../shared/guide";
import { IP_ADAPTER_INPUTS, IP_FILES, IP_OPTIONAL, IP_REFUSES, ipAdapterNeeds, ipAdapterNodes, withIpAdapter, type ReferenceSettings } from "../shared/references";
import { tileNodes, TILES_ON, inTiles, type TileSettings } from "../shared/tiles";
import { SDXL_AREA } from "./common";
import { ADETAIL_OPTIONAL, adetailInputs, adetailNeeds, ALL_DETAIL, DETECTOR_FILES, SDXL_FACE_DENOISE, type AdetailSettings } from "../shared/adetail";
import { hiresFix, pictureOut, type PictureSampler } from "../shared/passes";
import { regionLoads, regionsInput, sdxlRegionNodes, sdxlRegions } from "../shared/regions";

export interface SdxlTextToPicture extends DetailSettings, GuideSettings, TileSettings, AdetailSettings, ReferenceSettings {
  prompt: string;
  /** Tags put in front of the prompt on every render with this model. */
  quality: string;
  negative: string;
  checkpoint: string;
  loras: LoraValue[];
  size: SizeValue;
  regions: RegionValue[];
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
    regionsInput({ lora: "scoped", how: "Masked conditioning: each box's tags inside it, beside the prompt's; hires tiles redraw from the prompt alone." }),
    ...adetailInputs("tags", "", SDXL_FACE_DENOISE),
    ...DETAIL_INPUTS,
    // the checkpoint, its LoRAs and how it samples: the rows of the SDXL tools, which the skeleton lays out (pictureForm)
    ...modelInputs,
    // the seed among them, which pictureForm puts last
    ...samplingInputs(28),
    ...hiresInputs({
      scale: 1.5, denoise: 0.45, steps: 15,
      denoiseNote: "how much the second pass may redraw. With an upscale model 0.3 to 0.45 keeps the picture and sharpens it; enlarging in latent space needs 0.5 or more, or it stays soft",
      // an upscale model when there is one: the enlarged latent is noisy and asks for a denoise that redraws the picture
      upscaler: { default: UPSCALER_DEFAULT, extra: [LATENT_UPSCALE] },
    }),
  ],
  presets: SDXL_PRESETS,
  // a person's reference image with another is refused before it is queued, and said by the form (card #280)
  refuses: IP_REFUSES,
  optionalNodes: [...DETAIL_OPTIONAL, ...ADETAIL_OPTIONAL, ...IP_OPTIONAL],
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
      ...sdxlRegionNodes(input.regions),
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
    // each region's tags over its box (its LoRA held to it), beside the prompt's everywhere
    const positive = sdxlRegions(g, { clip: loaded.clip, positive: loaded.positive, quality: input.quality, size: { width: W, height: H } }, input.regions);
    // a guide picture holds the shapes of the picture drawn whole; tiles are pieces, redrawn from the text alone
    const guided = applyGuide(g, ctx, SDXL_GUIDE, { model, positive, negative: loaded.negative }, vae, { width: W, height: H }, input);

    g.phase("sampling");
    const sampler = { model, positive: guided.positive, negative: guided.negative, seed: ctx.seed, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler };
    const latent = kSample(g, { ...sampler, latent_image: empty, steps: input.steps, denoise: 1 }, input, ctx);
    const first = { latent, pass: { node: latent[0], steps: input.steps } };
    const second = { ...hiresPass(input), steps: input.hiresSteps, denoise: input.hiresDenoise };
    const passed = (out: Ref) => ({ latent: out, pass: { node: out[0], steps: input.hiresSteps } });
    const sdxl: PictureSampler = {
      vae, area: SDXL_AREA,
      encode: (pixels) => g.out("VAEEncode", { pixels, vae }),
      whole: (start) => passed(kSample(g, { ...sampler, ...second, latent_image: start }, input, ctx)),
      // the tiles from the prompt alone: the regions' and the guide picture's conditioning are the whole picture's
      tiles: () => (l) => passed(kSample(g, { ...sampler, positive: loaded.positive, negative: loaded.negative, ...second, latent_image: l }, input, ctx)),
    };
    const large = { width: roundTo(W * input.hiresScale, 8, 64), height: roundTo(H * input.hiresScale, 8, 64) };
    // (SDXL's loads have not listed its upscale model, as 0.10.0 built them: its hired.loads are left out)
    const hired = hiresFix(g, ctx, input, sdxl, first, { width: W, height: H }, large, { latent: input.hiresUpscaler === LATENT_UPSCALE });
    // the Detail rows: faces, hands, people redrawn by the checkpoint (its LoRAs on, the guide picture's shapes not: they are
    // the whole picture's), each crop at the size it draws best; a prompt of its own after the checkpoint's quality tags
    return pictureOut(g, ctx, input, sdxl, hired, { size: { width: W, height: H }, large }, {
      model: () => model, clip: loaded.clip, vae,
      cond: (text) => (text ? { positive: g.out("CLIPTextEncode", { text: withQuality(input.quality, text), clip: loaded.clip }), negative: loaded.negative } : { positive: loaded.positive, negative: loaded.negative }),
      steps: input.steps, cfg: input.cfg, sampler: input.sampler, scheduler: input.scheduler, seed: ctx.seed,
    }, [`checkpoints/${input.checkpoint}`, ...regionLoads(input.regions), ...referenced.loads, ...guided.loads]);
  },

  variants: [
    { name: "plain", input: { prompt: "a", checkpoint: "x.safetensors" } },
    {
      name: "two regions, left and right",
      input: { prompt: "a", checkpoint: "x.safetensors", regions: [{ id: "r1", box: { x: 0, y: 0.1, w: 0.5, h: 0.9 }, prompt: "red coat" }, { id: "r2", box: { x: 0.5, y: 0.1, w: 0.5, h: 0.9 }, prompt: "blue coat" }] },
    },
    {
      name: "two cast people in two regions, their LoRAs scoped, a region LoRA, Detail: face, hires fix",
      input: {
        prompt: "a", checkpoint: "x.safetensors", detailFace: true, hires: true, hiresUpscaler: "u.pth", loras: [{ file: "l.safetensors", weight: 0.8 }],
        regions: [
          { id: "r1", box: { x: 0, y: 0, w: 0.5, h: 1 }, prompt: "1girl, red coat", cast: "p1", castLora: { file: "mira.safetensors", weight: 0.8 }, lora: { file: "coat.safetensors", weight: 0.6 } },
          { id: "r2", box: { x: 0.5, y: 0, w: 0.5, h: 1 }, prompt: "1boy, blue coat", cast: "p2", castLora: { file: "nico.safetensors", weight: 0.9 } },
          { id: "r3", box: { x: 0.3, y: 0, w: 0.4, h: 0.3 }, prompt: "full moon" },
        ],
      },
      slots: DETECTOR_FILES,
    },
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
