import { defineRecipe, GraphBuilder, roundTo, type ReferenceValue, type Ref, type SizeValue } from "@afflatus/core";
import { HIRES_PASS_INPUTS, hiresPass, UPSCALER_PREFER, type HiresPass } from "../sdxl/common";
import type { FlowBase } from "../flow/kit";
import { flowFixFace } from "../flow/fix-face";
import { flowPaintOver } from "../flow/paint-over";
import { flowRedraw } from "../flow/redraw";
import { flowSharper } from "../flow/sharper";
import { DETAIL_INPUTS, DETAIL_OPTIONAL, detailNodes, fullPassNodes, withoutDaemon, type DetailSettings } from "../shared/detail";
import { redrawInTiles, tileInputs, tileNodes, tilePass, inTiles, type TileSettings } from "../shared/tiles";
import { krea2Kit, krea2Spec } from "./common";

const files = krea2Spec.files;
const withStyle = { ...files, styleRef: "krea2_style_reference.safetensors" };
/** About the area Krea 2 draws at, and the size a hires pass enlarges to. */
const KREA2_AREA = 1.1 * 1024 * 1024;
const krea2Large = (input: { size: SizeValue; hiresScale: number }) => ({ width: roundTo(roundTo(input.size.width, 16) * input.hiresScale, 16), height: roundTo(roundTo(input.size.height, 16) * input.hiresScale, 16) });

// ---------------------------------------------------------------- txt2img

interface Krea2Picture extends FlowBase, HiresPass, DetailSettings, TileSettings {
  prompt: string;
  references: ReferenceValue[];
  referenceStrength: number;
  size: SizeValue;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
}

/** The style-reference LoRA was trained on one or two pictures: how many reference images the text encoder is shown. */
const STYLE_IMAGES = 2;

/**
 * A picture from a prompt, the way ComfyUI's own Krea 2 Turbo template makes it. With reference images
 * it follows their style: the images are read next to the prompt and the style-reference LoRA is put
 * on the model (ComfyUI's "image style reference" template). Hires fix is the usual upscale and second
 * pass, at the model's own shift (see krea2Spec).
 */
export const krea2Picture = defineRecipe<Krea2Picture>({
  id: "krea2.text-to-picture",
  family: "krea2",
  version: 1,
  title: "txt2img",
  summary: "Text to image, from a natural-language prompt, with optional hires fix. With reference images, it follows their style.",
  output: "image",
  inputs: [
    krea2Spec.model,
    { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: krea2Spec.placeholder },
    {
      id: "references", type: "references", label: "Style reference images", max: STYLE_IMAGES, roles: ["style"],
      note: "the look to follow (a drawing style, a colour mood, a kind of photo), not who is in it. Needs the style-reference LoRA.",
    },
    { id: "referenceStrength", type: "number", label: "Style strength", note: "the weight of the style-reference LoRA", min: 0.1, max: 1.5, step: 0.05, default: 1, showWhen: "references", advanced: true },
    { id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048, shapes: krea2Spec.shapes },
    ...DETAIL_INPUTS,
    ...krea2Kit.inputs.slice(0, -1),
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", note: "past 2×, the second pass is redrawn in tiles (see Redraw)", min: 1.1, max: 4, step: 0.05, default: krea2Spec.hires!.scale!, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      options: { node: "UpscaleModelLoader", input: "model_name" }, default: "RealESRGAN_x4plus.pth", prefer: UPSCALER_PREFER,
    },
    { id: "hiresDenoise", type: "number", label: "Denoising strength", note: "how much the second pass may redraw", min: 0.05, max: 0.9, step: 0.05, default: krea2Spec.hires!.denoise!, showWhen: "hires", advanced: true, perModel: true },
    { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: krea2Spec.hires!.steps!, showWhen: "hires", advanced: true, perModel: true },
    ...HIRES_PASS_INPUTS,
    ...tileInputs("hires"),
    krea2Kit.inputs.at(-1)!,
  ],
  presets: krea2Spec.presets!,
  optionalNodes: DETAIL_OPTIONAL,
  nodes: (input) => [
    ...detailNodes(input),
    ...fullPassNodes(input, input.steps), ...(input.hires ? ["KSampler"] : []),
    ...tileNodes(input.hires && inTiles(input, krea2Large(input), KREA2_AREA)),
    ...krea2Kit.loadNodes(input).filter((n) => n !== "KSampler" && (n !== "CLIPTextEncode" || !input.references.length || input.negative.trim())), "EmptyLatentImage",
    ...(input.references.length ? ["LoadImage", "TextEncodeQwenImageEditPlus", "FluxKontextMultiReferenceLatentMethod", "LoraLoaderModelOnly", ...(input.shift > 0 ? [] : ["ModelSamplingFlux"])] : []),
    ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"] : []),
  ],
  build(input, ctx) {
    const { load, shifted, condFrom, sample } = krea2Kit;
    const g = new GraphBuilder();
    const k = load(g, input, ctx);
    const W = roundTo(input.size.width, 16);
    const H = roundTo(input.size.height, 16);
    const styled = input.references.length > 0;
    if (styled && !ctx.slots.styleRef) {
      throw new Error("Style reference images need Krea 2's style-reference LoRA: put krea2_style_reference.safetensors in ComfyUI's models/loras folder (it can be downloaded from Settings).");
    }
    let model = k.model;
    if (styled) model = g.out("LoraLoaderModelOnly", { model, lora_name: ctx.slots.styleRef, strength_model: input.referenceStrength });
    // the shift typed in, else the model's own; with reference images, the one that follows the size, as ComfyUI's
    // style-reference template sets it
    const styledAt = (m: Ref, width: number, height: number) =>
      input.shift > 0 ? shifted(g, m, input, { width, height }) : g.out("ModelSamplingFlux", { model: m, max_shift: 1.15, base_shift: 0.5, width, height });
    let positive: Ref;
    if (styled) {
      const images = Object.fromEntries(input.references.slice(0, STYLE_IMAGES).map((_, i) => [`image${i + 1}`, g.out("LoadImage", { image: ctx.uploads[`references.${i}`] })]));
      const read = g.out("TextEncodeQwenImageEditPlus", { clip: k.clip, vae: k.vae, prompt: input.prompt, ...images });
      positive = g.out("FluxKontextMultiReferenceLatentMethod", { conditioning: read, reference_latents_method: "index_timestep_zero" });
    } else {
      positive = g.out("CLIPTextEncode", { text: input.prompt, clip: k.clip });
    }
    const cond = condFrom(g, k, input, positive);
    const empty = g.out("EmptyLatentImage", { width: W, height: H, batch_size: 1 });

    g.phase("sampling");
    const detail = { input, ctx };
    const first = sample(g, k, input, styled ? styledAt(model, W, H) : shifted(g, model, input, { width: W, height: H }), cond, empty, ctx.seed, {}, detail);
    let latent = first.latent;
    const passes: Array<typeof first.pass & { pixels?: number }> = [first.pass];
    const loads = [...k.loads, ...(styled ? [`loras/${ctx.slots.styleRef}`] : [])];

    let image: Ref | null = null;
    if (input.hires) {
      const { width: W2, height: H2 } = krea2Large(input);
      g.phase("upscaling");
      // upscale models enlarge by their own factor (usually 4×): the result is scaled to the size asked for
      const pixels = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
      const scaled = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: W2, height: H2, crop: "disabled" });
      g.phase("refining");
      const pass = { steps: input.hiresSteps, denoise: input.hiresDenoise, ...hiresPass(input) };
      if (inTiles(input, { width: W2, height: H2 }, KREA2_AREA)) {
        image = redrawInTiles(g, ctx, scaled, k.vae, { width: W2, height: H2 }, input, (l, _tiles, tile) => {
          const second = sample(g, k, input, shifted(g, model, input, { width: tile, height: tile }), cond, l, ctx.seed, pass, detail);
          passes.push(tilePass(second.pass, { width: W2, height: H2 }, input));
          return second.latent;
        });
        // each pass at its own size: the first at the picture's first, the tiles at a tile's
        passes[0] = { ...passes[0]!, pixels: W * H };
      } else {
        const second = sample(g, k, input, shifted(g, model, input, { width: W2, height: H2 }), cond, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), ctx.seed, pass, detail);
        latent = second.latent;
        passes.push(second.pass);
      }
      loads.push(`upscale_models/${input.hiresUpscaler}`);
    }

    g.phase("decoding");
    const out = g.add("PreviewImage", { images: image ?? g.out("VAEDecode", { samples: latent, vae: k.vae }) });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: passes.reduce((n, p) => n + p.steps, 0), passes, loads };
  },
  variants: [
    { name: "from words, as ComfyUI's template", input: { prompt: "a" }, slots: files },
    {
      name: "a fine-tune with its own shift, a LoRA, a negative prompt and hires fix",
      input: { prompt: "a", model: "Krea2\\someone_krea2_v1.safetensors", shift: 4, cfg: 3, steps: 25, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }], hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } },
      slots: files,
    },
    { name: "hires fix at the model's own shift", input: { prompt: "a", hires: true, hiresUpscaler: "u.pth" }, slots: files },
    { name: "detail boost, hires fix 3× in tiles", input: { prompt: "a", detail: true, hires: true, hiresScale: 3, hiresUpscaler: "u.pth" }, slots: files, has: withoutDaemon },
    {
      name: "the style of two reference images",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }, { asset: "b", role: "style" }] },
      slots: withStyle, uploads: { "references.0": "a.png", "references.1": "b.png" },
    },
    {
      name: "a style reference with a negative prompt, a shift and hires fix",
      input: { prompt: "a", references: [{ asset: "a", role: "style" }], negative: "blurry", cfg: 2, shift: 3, hires: true, hiresUpscaler: "u.pth", referenceStrength: 0.8 },
      slots: withStyle, uploads: { "references.0": "a.png" },
    },
  ],
});

// ---------------------------------------------------------------- img2img, inpaint, upscale 2x, face detailer: the picture models' own

export const krea2Redraw = flowRedraw(krea2Spec, krea2Kit);
export const krea2PaintOver = flowPaintOver(krea2Spec, krea2Kit);
export const krea2Sharper = flowSharper(krea2Spec, krea2Kit);
export const krea2FixFace = flowFixFace(krea2Spec, krea2Kit);
