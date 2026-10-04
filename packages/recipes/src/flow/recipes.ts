import { defineRecipe, GraphBuilder, type BuildContext, type InputSpec, type LoraValue, type Preset, type Recipe, type Ref, type SizeValue } from "@afflatus/core";
import {
  boxOf, FACE_DETECTOR_PREFER, FACE_INPUTS, FACTOR_INPUT, HIRES_PASS_INPUTS, hiresPass, MASK_INPUTS, MASK_NODES, maskParts, UPSCALER_PREFER,
  type FaceSettings, type HiresPass, type MaskSettings, type UpscaleSettings,
} from "../sdxl/common";

/**
 * The picture models that are built the same way in ComfyUI (a diffusion model in a file of its own, one
 * or two text encoders, a VAE, a plain KSampler): Flux and Qwen Image. What differs between them is
 * said once, in a `FlowSpec`; the five operations every picture model has here are made from it:
 * txt2img (with hires fix), img2img, inpaint, upscale 2x and the face detailer.
 */
export interface FlowSpec {
  /** The family's id: recipes are named "<family>.text-to-picture", "<family>.redraw", … */
  family: string;
  /** The "model" input: which diffusion model, starting on the family's usual one. */
  model: InputSpec;
  /** The text encoder(s): the loader node(s) they need, how they are loaded, and their files. */
  encoder: { nodes: string[]; load(g: GraphBuilder, slots: Record<string, string>): Ref; files(slots: Record<string, string>): string[] };
  /** The node that sets the shift, when one is typed. Flux's follows the size of the picture. */
  shift: { node: "ModelSamplingFlux" | "ModelSamplingAuraFlow"; default: number; note: string };
  /** Flux's guidance: a number the model was taught to follow, not the CFG scale. */
  guidance?: { default: number; note: string };
  /** A LoRA that makes the model work in a few steps at CFG 1, when the family has one. */
  turbo?: { slot: string; steps: number; note: string; stepsNote: string; named: RegExp };
  /** The negative prompt: where it starts, and what stands for it when it is empty. */
  negative: { default: string; note: string; empty: "zero" | "encode" };
  sampling: { steps: number; stepsNote: string; cfg: number; cfgNote: string; sampler: string; scheduler: string };
  /** The sizes offered for a new picture, and about how many megapixels a picture is redrawn at. */
  shapes: Array<{ id: string; label: string; width: number; height: number }>;
  megapixels: number;
  /** The most pixels a new picture may have, when the model has a ceiling (FLUX.1: 2 MP). */
  maxPixels?: number;
  /** What a model file starts on the first time it is used, by its name. */
  presets?: Preset[];
  placeholder: string;
  /** For the graph checker: the family's files under their usual names, and what a fine-tune could be called. */
  files: Record<string, string>;
  fineTune: string;
}

export interface FlowBase {
  model?: string;
  /** How the diffusion model's weights are held in memory (UNETLoader's weight_dtype). */
  precision?: string;
  negative: string;
  loras: LoraValue[];
  fast?: boolean;
  turboSteps?: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  shift: number;
  guidance?: number;
  seed: number;
}
export interface FlowPicture extends FlowBase, HiresPass {
  prompt: string;
  size: SizeValue;
  hires: boolean;
  hiresScale: number;
  hiresUpscaler: string;
  hiresDenoise: number;
  hiresSteps: number;
}
export interface FlowRedraw extends FlowBase { source: string; prompt: string; strength: number }
export interface FlowPaintOver extends FlowBase, MaskSettings { source: string; mask: string; prompt: string; strength: number }
export interface FlowSharper extends FlowBase, UpscaleSettings { source: string; prompt: string; upscaler: string; refine: boolean; strength: number }
export interface FlowFixFace extends FlowBase, FaceSettings { source: string; prompt: string; detector: string; strength: number }

export const r16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);
/** Past this many pixels an upscaled picture is only enlarged: a pass that large does not fit a common card. */
const REFINE_MAX_PIXELS = 3.2e6;
const SAME_PICTURE = "The same picture in high quality, with sharp, natural detail.";
const A_FACE = "A detailed, natural face with sharp eyes and realistic skin.";
const photo = { width: 1536, height: 2048 };

/** What the recipes of one family share: its inputs, how its model is loaded, how it samples. */
export function flowKit(spec: FlowSpec) {
  /** How it samples: the values of ComfyUI's own template to begin with, each kept per model once saved. */
  const inputs: InputSpec[] = [
    { id: "loras", type: "loras", label: "LoRAs", max: 6 },
    { id: "negative", type: "prompt", label: "Negative prompt", note: spec.negative.note, style: "sentences", optional: true, default: spec.negative.default, advanced: true, perModel: true },
    ...(spec.turbo
      ? ([
        { id: "fast", type: "toggle", label: "Turbo", note: spec.turbo.note, default: false, advanced: true, perModel: true },
        { id: "turboSteps", type: "number", label: "Turbo steps", note: spec.turbo.stepsNote, min: 1, max: 16, step: 1, default: spec.turbo.steps, showWhen: "fast", advanced: true, perModel: true },
      ] satisfies InputSpec[])
      : []),
    { id: "steps", type: "number", label: "Steps", note: spec.sampling.stepsNote, min: 1, max: 80, step: 1, default: spec.sampling.steps, advanced: true, perModel: true },
    { id: "cfg", type: "number", label: "CFG scale", note: spec.sampling.cfgNote, min: 1, max: 12, step: 0.5, default: spec.sampling.cfg, advanced: true, perModel: true },
    ...(spec.guidance ? ([{ id: "guidance", type: "number", label: "Guidance (distilled CFG)", note: spec.guidance.note, min: 0, max: 10, step: 0.1, default: spec.guidance.default, advanced: true, perModel: true }] satisfies InputSpec[]) : []),
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: spec.sampling.sampler, advanced: true, perModel: true },
    { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: spec.sampling.scheduler, advanced: true, perModel: true },
    { id: "shift", type: "number", label: "Shift", note: spec.shift.note, min: 0, max: 12, step: 0.05, default: spec.shift.default, advanced: true, perModel: true },
    {
      id: "precision", type: "choice", label: "Weight precision", options: { node: "UNETLoader", input: "weight_dtype" }, default: "default", advanced: true, perModel: true,
      note: "how the model's weights are held in memory: default keeps the file's own. fp8 halves the memory of a bf16 file (a 22 GB FLUX.1 dev fits a 12 GB card) at a slight cost in quality; a file that is fp8 already gains nothing",
    },
    { id: "seed", type: "seed", label: "Seed" },
  ];

  /** The nodes every recipe that samples uses. The ones that depend on a setting or on a file are among `SOMETIMES`. */
  const LOAD_NODES = ["UNETLoader", ...spec.encoder.nodes, "VAELoader", "CLIPTextEncode", "KSampler", "VAEDecode", "PreviewImage"];
  /** Nodes of ComfyUI itself that a setting, or a file that is there or not, brings in. */
  const SOMETIMES = ["LoraLoaderModelOnly", "ConditioningZeroOut", spec.shift.node, ...(spec.guidance ? ["FluxGuidance"] : [])];

  /** The model with its LoRAs (and the turbo LoRA when Turbo is on and the model needs it), the text encoder and the VAE. */
  function load(g: GraphBuilder, input: FlowBase, ctx: BuildContext) {
    const unet = input.model ?? ctx.slots.unet;
    let model: Ref = g.out("UNETLoader", { unet_name: unet, weight_dtype: input.precision || "default" });
    const made = spec.turbo ? spec.turbo.named.test(unet?.split(/[\\/]/).pop() ?? "") : false;
    const turboLora = spec.turbo && input.fast && !made ? ctx.slots[spec.turbo.slot] : undefined;
    // a model made for a few steps runs at them whether Turbo is on or not (40 steps at CFG 4 on a Lightning
    // merge comes out burnt). Turbo with a model that is not made for it and no LoRA to make it so: the full steps
    const turbo = Boolean(spec.turbo && (made || (input.fast && turboLora)));
    if (turboLora) model = g.out("LoraLoaderModelOnly", { model, lora_name: turboLora, strength_model: 1 });
    for (const l of input.loras) if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
    return {
      model,
      clip: spec.encoder.load(g, ctx.slots),
      vae: g.out("VAELoader", { vae_name: ctx.slots.vae }),
      steps: turbo ? input.turboSteps ?? spec.turbo!.steps : input.steps,
      cfg: turbo ? 1 : input.cfg,
      loads: [
        `diffusion_models/${unet}`, ...spec.encoder.files(ctx.slots), `vae/${ctx.slots.vae}`,
        ...(turboLora ? [`loras/${turboLora}`] : []), ...input.loras.filter((l) => l.weight !== 0).map((l) => `loras/${l.file}`),
      ],
    };
  }
  type Loaded = ReturnType<typeof load>;

  /**
   * The model as it is sampled with. Flux's shift follows the size of the picture (its own 1.15 is for one
   * megapixel: a hires pass at 1.5 MP wants more), so the node is always set, with the shift typed in as
   * the largest when there is one. The others take the shift typed, or the model's own when it is 0.
   */
  const shifted = (g: GraphBuilder, model: Ref, input: FlowBase, size: { width: number; height: number }): Ref => {
    if (spec.shift.node === "ModelSamplingFlux") return g.out("ModelSamplingFlux", { model, max_shift: input.shift > 0 ? input.shift : 1.15, base_shift: 0.5, width: size.width, height: size.height });
    if (!(input.shift > 0)) return model;
    return g.out("ModelSamplingAuraFlow", { model, shift: input.shift });
  };

  /** The two texts. Without a negative prompt, the negative side is the positive one emptied, or an empty text, as the family's template has it. */
  function cond(g: GraphBuilder, k: Loaded, input: FlowBase, text: string) {
    const said = g.out("CLIPTextEncode", { text, clip: k.clip });
    const positive = spec.guidance ? g.out("FluxGuidance", { conditioning: said, guidance: input.guidance ?? spec.guidance.default }) : said;
    const negative = input.negative.trim() || spec.negative.empty === "encode" ? g.out("CLIPTextEncode", { text: input.negative, clip: k.clip }) : g.out("ConditioningZeroOut", { conditioning: said });
    return { positive, negative };
  }

  /** One pass of sampling. */
  function sample(g: GraphBuilder, k: Loaded, input: FlowBase, model: Ref, c: { positive: Ref; negative: Ref }, latent: Ref, seed: number, opts: { steps?: number; denoise?: number; sampler_name?: string; scheduler?: string } = {}) {
    const steps = opts.steps ?? k.steps;
    const sampled = g.out("KSampler", {
      model, positive: c.positive, negative: c.negative, latent_image: latent, seed,
      steps, cfg: k.cfg, sampler_name: opts.sampler_name ?? input.sampler, scheduler: opts.scheduler ?? input.scheduler, denoise: opts.denoise ?? 1,
    });
    return { latent: sampled, pass: { node: sampled[0], steps } };
  }

  /** The size a picture (or a part of one) is worked on at: its own shape, both edges multiples of 16, at most about `megapixels`. */
  function sizeOf(of: { width: number; height: number } | undefined, megapixels = spec.megapixels, least = 0.6) {
    if (!of?.width || !of.height) return { width: 1024, height: 1024 };
    const mp = (of.width * of.height) / (1024 * 1024);
    // large pictures are brought down to what the model draws well; small parts are brought up to where it has room to draw
    const k = mp > megapixels ? Math.sqrt(megapixels / mp) : mp < least ? Math.sqrt(least / mp) : 1;
    return { width: r16(of.width * k), height: r16(of.height * k) };
  }

  return { inputs, LOAD_NODES, SOMETIMES, load, shifted, cond, sample, sizeOf };
}

/** The five operations of a picture model, from what is said about it once. */
export function flowRecipes(spec: FlowSpec): { picture: Recipe<FlowPicture>; redraw: Recipe<FlowRedraw>; paintOver: Recipe<FlowPaintOver>; sharper: Recipe<FlowSharper>; fixFace: Recipe<FlowFixFace> } {
  const kit = flowKit(spec);
  const { inputs, LOAD_NODES, SOMETIMES, load, shifted, cond, sample, sizeOf } = kit;
  const files = spec.files;
  const tuned = { model: spec.fineTune, shift: 4, cfg: 3, steps: 25, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }] };

  // ---------------------------------------------------------------- txt2img
  const picture = defineRecipe<FlowPicture>({
    id: `${spec.family}.text-to-picture`,
    family: spec.family,
    version: 1,
    title: "txt2img",
    summary: "Text to image, from a natural-language prompt, with optional hires fix.",
    output: "image",
    inputs: [
      spec.model,
      { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: spec.placeholder },
      { id: "size", type: "size", label: "Size", default: "tall", grid: 16, min: 256, max: 2048, shapes: spec.shapes, ...(spec.maxPixels ? { maxPixels: spec.maxPixels } : {}) },
      ...inputs.slice(0, -1),
      { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
      { id: "hiresScale", type: "number", label: "Upscale by", min: 1.1, max: 2, step: 0.05, default: 1.25, unit: "×", showWhen: "hires", advanced: true, perModel: true },
      {
        id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
        options: { node: "UpscaleModelLoader", input: "model_name" }, default: "RealESRGAN_x4plus.pth", prefer: UPSCALER_PREFER,
      },
      { id: "hiresDenoise", type: "number", label: "Denoising strength", note: "how much the second pass may redraw", min: 0.05, max: 0.9, step: 0.05, default: 0.4, showWhen: "hires", advanced: true, perModel: true },
      { id: "hiresSteps", type: "number", label: "Hires steps", min: 1, max: 60, step: 1, default: Math.max(4, Math.round(spec.sampling.steps / 2)), showWhen: "hires", advanced: true, perModel: true },
      ...HIRES_PASS_INPUTS,
      inputs.at(-1)!,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: (input) => [...LOAD_NODES, "EmptySD3LatentImage", ...(input.hires ? ["UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "VAEEncode"] : [])],
    optionalNodes: SOMETIMES,
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = { width: r16(input.size.width), height: r16(input.size.height) };
      const c = cond(g, k, input, input.prompt);
      const empty = g.out("EmptySD3LatentImage", { width: size.width, height: size.height, batch_size: 1 });
      g.phase("sampling");
      const first = sample(g, k, input, shifted(g, k.model, input, size), c, empty, ctx.seed);
      let latent = first.latent;
      const passes = [first.pass];
      const loads = [...k.loads];
      if (input.hires) {
        const large = { width: r16(size.width * input.hiresScale), height: r16(size.height * input.hiresScale) };
        g.phase("upscaling");
        // upscale models enlarge by their own factor (usually 4×): the result is scaled to the size asked for
        const pixels = g.out("VAEDecode", { samples: latent, vae: k.vae });
        const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.hiresUpscaler }), image: pixels });
        const scaled = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: large.width, height: large.height, crop: "disabled" });
        g.phase("refining");
        const second = sample(g, k, input, shifted(g, k.model, input, large), c, g.out("VAEEncode", { pixels: scaled, vae: k.vae }), ctx.seed, { steps: input.hiresSteps, denoise: input.hiresDenoise, ...hiresPass(input) });
        latent = second.latent;
        passes.push(second.pass);
        loads.push(`upscale_models/${input.hiresUpscaler}`);
      }
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: passes.reduce((n, p) => n + p.steps, 0), passes, loads };
    },
    variants: [
      { name: "from words, as ComfyUI's template", input: { prompt: "a" } as Partial<FlowPicture>, slots: files },
      { name: "a fine-tune with a shift, a LoRA, a negative prompt and hires fix", input: { prompt: "a", ...tuned, hires: true, hiresUpscaler: "u.pth", size: { width: 1152, height: 1536 } } as Partial<FlowPicture>, slots: files },
      ...(spec.turbo
        ? [
          { name: "Turbo with its LoRA", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: { ...files, [spec.turbo.slot]: "turbo.safetensors" } },
          { name: "Turbo without its LoRA: the full steps", input: { prompt: "a", fast: true } as Partial<FlowPicture>, slots: files },
        ]
        : []),
    ],
  });

  // ---------------------------------------------------------------- img2img
  const redraw = defineRecipe<FlowRedraw>({
    id: `${spec.family}.redraw`,
    family: spec.family,
    version: 1,
    title: "img2img",
    summary: "Image to image: an image redrawn from a prompt. The denoising strength says how far it may go from the original.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image" },
      { id: "prompt", type: "prompt", label: "Prompt", style: "sentences", placeholder: "what the picture shows, as it should come out" },
      { id: "strength", type: "number", label: "Denoising strength", note: "0.3 keeps it close, 0.7 only keeps the layout", min: 0.05, max: 1, step: 0.05, default: 0.55 },
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: () => [...LOAD_NODES, "LoadImage", "ImageScale", "VAEEncode"],
    optionalNodes: SOMETIMES,
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const size = sizeOf(ctx.media.source);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const sized = g.out("ImageScale", { image: source, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      const c = cond(g, k, input, input.prompt);
      g.phase("sampling");
      const { latent, pass } = sample(g, k, input, shifted(g, k.model, input, size), c, g.out("VAEEncode", { pixels: sized, vae: k.vae }), ctx.seed, { denoise: input.strength });
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
    },
    variants: [
      { name: "plain", input: { source: "p", prompt: "a" } as Partial<FlowRedraw>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 896, height: 1152 } } },
      { name: "a large picture, a fine-tune, a LoRA, strong", input: { source: "p", prompt: "a", strength: 0.8, ...tuned } as Partial<FlowRedraw>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 3000, height: 2000 } } },
    ],
  });

  // ---------------------------------------------------------------- inpaint
  /**
   * Only the painted part is redone: it is cut out with room around it, redrawn at a size the model draws
   * well, and put back into the untouched picture through a soft edge.
   */
  const paintOver = defineRecipe<FlowPaintOver>({
    id: `${spec.family}.paint-over`,
    family: spec.family,
    version: 1,
    title: "Inpaint",
    summary: "Paint a mask over a part of an image and prompt what goes there. Only the masked part is redrawn.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image" },
      { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the masked part with what is around it, as it should come out", style: "sentences", placeholder: "A woman's hand holding a glass of orange juice, on a terrace table in morning light." },
      { id: "strength", type: "number", label: "Denoising strength", note: "1 ignores what was there", min: 0.05, max: 1, step: 0.05, default: 0.8 },
      ...MASK_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: () => [...LOAD_NODES, "LoadImage", "VAEEncode", ...MASK_NODES],
    optionalNodes: SOMETIMES,
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const box = boxOf(ctx.media.source, ctx.media.mask);
      const size = sizeOf(box, 1.2, 0.8);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const part = g.out("ImageCrop", { image: source, width: box.width, height: box.height, x: box.x, y: box.y });
      const sized = g.out("ImageScale", { image: part, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      const masks = maskParts(g, ctx.uploads.mask!, box, size, input);
      const c = cond(g, k, input, input.prompt);
      const masked = g.out("SetLatentNoiseMask", { samples: g.out("VAEEncode", { pixels: sized, vae: k.vae }), mask: masks.forLatent });
      g.phase("sampling");
      const { latent, pass } = sample(g, k, input, shifted(g, k.model, input, size), c, masked, ctx.seed, { denoise: input.strength });
      g.phase("decoding");
      const drawn = g.out("VAEDecode", { samples: latent, vae: k.vae });
      const back = g.out("ImageScale", { image: drawn, upscale_method: "lanczos", width: box.width, height: box.height, crop: "disabled" });
      const whole = g.out("ImageCompositeMasked", { destination: source, source: back, x: box.x, y: box.y, resize_source: false, mask: masks.soft });
      const out = g.add("PreviewImage", { images: whole });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: k.loads };
    },
    variants: [
      {
        name: "a part of the picture",
        input: { source: "p", mask: "m", prompt: "a" } as Partial<FlowPaintOver>,
        slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo, mask: { ...photo, box: { x: 300, y: 500, width: 600, height: 500 } } },
      },
      {
        name: "nothing known about the mask: the whole picture, a fine-tune",
        input: { source: "p", mask: "m", prompt: "a", strength: 1, ...tuned } as Partial<FlowPaintOver>,
        slots: files, uploads: { source: "s.png", mask: "m.png" }, media: { source: photo },
      },
    ],
  });

  // ---------------------------------------------------------------- upscale 2x
  const sharper = defineRecipe<FlowSharper>({
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
      { id: "upscaler", type: "choice", label: "Upscaler", note: "from your upscale models", options: { node: "UpscaleModelLoader", input: "model_name" }, default: "4x-UltraSharp.pth", prefer: UPSCALER_PREFER },
      FACTOR_INPUT,
      { id: "refine", type: "toggle", label: "img2img pass after upscale", note: "a light pass with the model; skipped when the result is larger than about 3 megapixels", default: true },
      { id: "strength", type: "number", label: "Denoising strength", min: 0.05, max: 0.6, step: 0.01, default: 0.25, showWhen: "refine", advanced: true },
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: () => ["LoadImage", "UpscaleModelLoader", "ImageUpscaleWithModel", "ImageScale", "PreviewImage"],
    // the second pass: only when it is asked for and the result is small enough for it. All are ComfyUI's own nodes.
    optionalNodes: [...LOAD_NODES.filter((n) => n !== "PreviewImage"), "VAEEncode", ...SOMETIMES],
    build(input, ctx) {
      const g = new GraphBuilder();
      const from = ctx.media.source?.width ? ctx.media.source : { width: 1024, height: 1024 };
      const size = { width: r16(from.width * input.factor), height: r16(from.height * input.factor) };
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      g.phase("upscaling");
      const big = g.out("ImageUpscaleWithModel", { upscale_model: g.out("UpscaleModelLoader", { model_name: input.upscaler }), image: source });
      // upscale models enlarge by their own factor (usually 4x): scaled to exactly twice the picture
      const sized = g.out("ImageScale", { image: big, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
      const loads = [`upscale_models/${input.upscaler}`];
      if (!input.refine || size.width * size.height > REFINE_MAX_PIXELS) {
        const out = g.add("PreviewImage", { images: sized });
        return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads };
      }
      g.phase("loading");
      const k = load(g, input, ctx);
      const c = cond(g, k, input, input.prompt.trim() || SAME_PICTURE);
      g.phase("refining");
      const { latent, pass } = sample(g, k, input, shifted(g, k.model, input, size), c, g.out("VAEEncode", { pixels: sized, vae: k.vae }), ctx.seed, { steps: Math.max(3, Math.round(Math.min(30, k.steps) * 0.5)), denoise: input.strength });
      g.phase("decoding");
      const out = g.add("PreviewImage", { images: g.out("VAEDecode", { samples: latent, vae: k.vae }) });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: pass.steps, passes: [pass], loads: [...loads, ...k.loads] };
    },
    variants: [
      { name: "enlarged and gone over", input: { source: "p", upscaler: "u.pth" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "only enlarged", input: { source: "p", upscaler: "u.pth", refine: false } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
      { name: "too large to go over", input: { source: "p", upscaler: "u.pth" } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "a fine-tune with its shift, a prompt and a LoRA", input: { source: "p", upscaler: "u.pth", prompt: "a", ...tuned } as Partial<FlowSharper>, slots: files, uploads: { source: "s.png" }, media: { source: { width: 640, height: 960 } } },
    ],
  });

  // ---------------------------------------------------------------- face detailer
  /** The Impact Pack's FaceDetailer with this model: every face is found, redrawn larger, and put back with a soft edge. */
  const fixFace = defineRecipe<FlowFixFace>({
    id: `${spec.family}.fix-face`,
    family: spec.family,
    version: 1,
    title: "Face detailer",
    summary: "Like ADetailer: detects every face and inpaints it with more detail. Needs the Impact Pack nodes in ComfyUI.",
    output: "image",
    inputs: [
      spec.model,
      { id: "source", type: "image", role: "source", label: "Image" },
      { id: "prompt", type: "prompt", label: "Prompt", note: "the face and who it is: eye colour, hair, expression", style: "sentences", optional: true, default: "" },
      { id: "strength", type: "number", label: "Denoising strength", note: "0.3 cleans the face, 0.6 can make another one", min: 0.1, max: 0.8, step: 0.05, default: 0.4 },
      { id: "detector", type: "choice", label: "Detection model", note: "from ComfyUI's models/ultralytics folder", options: { node: "UltralyticsDetectorProvider", input: "model_name" }, default: "bbox/face_yolov8m.pt", prefer: FACE_DETECTOR_PREFER, advanced: true },
      ...FACE_INPUTS,
      ...inputs,
    ],
    ...(spec.presets ? { presets: spec.presets } : {}),
    nodes: () => [...LOAD_NODES.filter((n) => !["KSampler", "VAEDecode"].includes(n)), "LoadImage", "UltralyticsDetectorProvider", "FaceDetailer"],
    optionalNodes: SOMETIMES,
    build(input, ctx) {
      const g = new GraphBuilder();
      const k = load(g, input, ctx);
      const source = g.out("LoadImage", { image: ctx.uploads.source });
      const c = cond(g, k, input, input.prompt.trim() || A_FACE);
      const detector = g.out("UltralyticsDetectorProvider", { model_name: input.detector });
      g.phase("detailing");
      const fixed = g.add("FaceDetailer", {
        image: source, model: shifted(g, k.model, input, { width: 1024, height: 1024 }), clip: k.clip, vae: k.vae, positive: c.positive, negative: c.negative, bbox_detector: detector,
        guide_size: input.faceSize, guide_size_for: false, max_size: Math.max(input.faceMax, input.faceSize), seed: ctx.seed, steps: k.steps, cfg: k.cfg,
        sampler_name: input.sampler, scheduler: input.scheduler, denoise: input.strength, feather: input.faceFeather, noise_mask: true, force_inpaint: true,
        bbox_threshold: input.faceThreshold, bbox_dilation: input.faceGrow, bbox_crop_factor: input.faceCrop, sam_detection_hint: "center-1", sam_dilation: 0,
        sam_threshold: 0.93, sam_bbox_expansion: 0, sam_mask_hint_threshold: 0.7, sam_mask_hint_use_negative: "False",
        drop_size: 10, wildcard: "", cycle: 1,
      });
      const out = g.add("PreviewImage", { images: [fixed, 0] });
      return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: k.steps, passes: [{ node: fixed, steps: k.steps }], loads: k.loads };
    },
    variants: [
      { name: "plain", input: { source: "p", detector: "bbox/face.pt" } as Partial<FlowFixFace>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
      { name: "with words, a fine-tune and a LoRA", input: { source: "p", prompt: "green eyes", detector: "bbox/face.pt", ...tuned } as Partial<FlowFixFace>, slots: files, uploads: { source: "s.png" }, media: { source: photo } },
    ],
  });

  return { picture, redraw, paintOver, sharper, fixFace };
}
