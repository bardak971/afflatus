import { roundTo, type BuildContext, type GraphBuilder, type InputSpec, type LoraValue, type Preset, type Ref } from "@afflatus/core";
import { kSample, type DetailSettings } from "../shared/detail";
import { applyLoras, loraLoads } from "../shared/model";
import { TILE_NODES } from "../shared/tiles";
import { GGUF_LOADER, loadUnet, unetNodes } from "../shared/unet";

/**
 * The picture models that are built the same way in ComfyUI (a diffusion model in a file of its own, one
 * or two text encoders, a VAE, a plain KSampler): Flux, Qwen Image and Krea 2. What differs between them is
 * said once, in a `FlowSpec`; the operations every picture model has here are made from it, one file each:
 * txt2img (with hires fix), img2img, inpaint, outpaint, upscale 2x and the face detailer.
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
  /**
   * Where txt2img's hires fix starts, when the family's authors give another: how much it enlarges, how much the
   * second pass redraws and its steps. Without it, 1.25×, 0.4 and half the steps (4 at least).
   */
  hires?: { scale?: number; denoise?: number; steps?: number };
  /** How it samples on the form, when the family's inputs are not the usual ones (Krea 2's: no weight precision, Turbo's ranges). */
  inputs?: InputSpec[];
  /** Inpainting with the mask as it is, without Differential Diffusion's soft edge (Krea 2's). */
  hardInpaint?: boolean;
  /**
   * A model patch that guides inpainting and outpainting when its optional file is there (Z-Image's Fun ControlNet
   * Union: the picture and the mask are given to it, and the masked part is drawn to fit them): the slot it is in.
   */
  inpaintPatch?: { slot: string };
  /** The sizes offered for a new picture, and about how many megapixels a picture is redrawn at. */
  shapes: Array<{ id: string; label: string; width: number; height: number }>;
  megapixels: number;
  /** The most pixels a new picture may have, when the model has a ceiling (FLUX.1: 2 MP). */
  maxPixels?: number;
  /** What a model file starts on the first time it is used, by its name. */
  presets?: Preset[];
  placeholder: string;
  /**
   * The look of a picture (FLUX.1 Redux): the picture is read by a vision model and what it sees is added to
   * the prompt, so the new picture takes its style, colours and subject without copying it. Its two files
   * are the family's slots `redux` and `vision`.
   */
  look?: boolean;
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

export const SAME_PICTURE = "The same picture in high quality, with sharp, natural detail.";
export const A_FACE = "A detailed, natural face with sharp eyes and realistic skin.";
export const photo = { width: 1536, height: 2048 };

/** What the recipes of one family share: its inputs, how its model is loaded, how it samples. */
/** The nodes the inpaint patch brings in: ComfyUI's own, used only when the family's file is there. */
export const INPAINT_PATCH_NODES = ["ModelPatchLoader", "ZImageFunControlnet"];

/**
 * The model with the family's inpaint patch on it when its file is there (and what it loads), else the model as it is.
 * The patch is given the picture the masked part is drawn into and the mask at the drawing size (1 = to draw; the node
 * turns it around itself). Tried on a real ComfyUI with Z-Image: the new part's scale and stone took the picture's
 * around it more closely, and an outpainted strip carried the scene further, than without it.
 */
export function inpaintPatched(g: GraphBuilder, ctx: BuildContext, spec: FlowSpec, model: Ref, vae: Ref, picture: Ref, mask: Ref): { model: Ref; loads: string[] } {
  const file = spec.inpaintPatch ? ctx.slots[spec.inpaintPatch.slot] : undefined;
  if (!file || !INPAINT_PATCH_NODES.every((n) => ctx.has(n))) return { model, loads: [] };
  const patch = g.out("ModelPatchLoader", { name: file });
  return { model: g.out("ZImageFunControlnet", { model, model_patch: patch, vae, strength: 1, inpaint_image: picture, mask }), loads: [`model_patches/${file}`] };
}

export function flowKit(spec: FlowSpec) {
  /** How it samples: the values of ComfyUI's own template to begin with, each kept per model once saved. */
  const inputs: InputSpec[] = spec.inputs ?? [
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
      note: "how the model's weights are held in memory: default keeps the file's own. fp8 halves the memory of a bf16 file (a 22 GB FLUX.1 dev takes 11) at a slight cost in quality; a file that is fp8 already gains nothing",
    },
    { id: "seed", type: "seed", label: "Seed" },
  ];

  /**
   * The nodes a recipe that samples once at the model's own size uses: the loaders, the texts, the sampler, the
   * decode, and what a setting brings in (the LoRAs, the emptied negative side, the shift, Flux's guidance).
   */
  const loadNodes = (input: FlowBase) => [
    ...unetNodes(input.model), ...spec.encoder.nodes, "VAELoader", "CLIPTextEncode", "KSampler", "VAEDecode", "PreviewImage",
    ...(!spec.turbo && input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : []),
    ...(!input.negative.trim() && spec.negative.empty === "zero" ? ["ConditioningZeroOut"] : []),
    ...(spec.shift.node === "ModelSamplingFlux" || input.shift > 0 ? [spec.shift.node] : []),
    ...(spec.guidance ? ["FluxGuidance"] : []),
  ];
  /** With a turbo LoRA, whether it is put on depends on its file being there: the LoRA loader is then the build's to say. */
  const SOMETIMES = spec.turbo ? ["LoraLoaderModelOnly"] : [];
  /** Every node a second pass that is only sometimes made can use (the light pass after an upscale). */
  const SECOND_PASS = [
    "UNETLoader", GGUF_LOADER, ...spec.encoder.nodes, "VAELoader", "CLIPTextEncode", "KSampler", "VAEDecode", "VAEEncode", "LoraLoaderModelOnly",
    ...(spec.negative.empty === "zero" ? ["ConditioningZeroOut"] : []), spec.shift.node,
    ...(spec.guidance ? ["FluxGuidance"] : []), ...TILE_NODES,
  ];

  /** Whether the form offers the weight precision (Krea 2's does not). */
  const precise = inputs.some((i) => i.id === "precision");

  /** The model with its LoRAs (and the turbo LoRA when Turbo is on and the model needs it), the text encoder and the VAE. */
  function load(g: GraphBuilder, input: FlowBase, ctx: BuildContext) {
    const unet = input.model ?? ctx.slots.unet;
    let model: Ref = loadUnet(g, ctx, unet, (precise && input.precision) || "default");
    const made = spec.turbo ? spec.turbo.named.test(unet?.split(/[\\/]/).pop() ?? "") : false;
    const turboLora = spec.turbo && input.fast && !made ? ctx.slots[spec.turbo.slot] : undefined;
    // a model made for a few steps runs at them whether Turbo is on or not (40 steps at CFG 4 on a Lightning
    // merge comes out burnt). Turbo with a model that is not made for it and no LoRA to make it so: the full steps
    const turbo = Boolean(spec.turbo && (made || (input.fast && turboLora)));
    if (turboLora) model = g.out("LoraLoaderModelOnly", { model, lora_name: turboLora, strength_model: 1 });
    model = applyLoras(g, model, input.loras);
    return {
      model,
      clip: spec.encoder.load(g, ctx.slots),
      vae: g.out("VAELoader", { vae_name: ctx.slots.vae }),
      steps: turbo ? input.turboSteps ?? spec.turbo!.steps : input.steps,
      cfg: turbo ? 1 : input.cfg,
      turbo,
      loads: [`diffusion_models/${unet}`, ...spec.encoder.files(ctx.slots), `vae/${ctx.slots.vae}`, ...(turboLora ? [`loras/${turboLora}`] : []), ...loraLoads(input.loras)],
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

  /** The two texts from what the prompt was read into: Flux's guidance on it, and the negative side (the positive one emptied, or the negative prompt, as the family's template has it). */
  function condFrom(g: GraphBuilder, k: Loaded, input: FlowBase, said: Ref) {
    const positive = spec.guidance ? g.out("FluxGuidance", { conditioning: said, guidance: input.guidance ?? spec.guidance.default }) : said;
    const negative = input.negative.trim() || spec.negative.empty === "encode" ? g.out("CLIPTextEncode", { text: input.negative, clip: k.clip }) : g.out("ConditioningZeroOut", { conditioning: said });
    return { positive, negative };
  }
  /** The two texts, from the prompt. */
  const cond = (g: GraphBuilder, k: Loaded, input: FlowBase, text: string) => condFrom(g, k, input, g.out("CLIPTextEncode", { text, clip: k.clip }));

  /** One pass of sampling, with the detail boost when one is given with the context it is built in. */
  function sample(g: GraphBuilder, k: Loaded, input: FlowBase, model: Ref, c: { positive: Ref; negative: Ref }, latent: Ref, seed: number, opts: { steps?: number; denoise?: number; sampler_name?: string; scheduler?: string } = {}, detail?: { input: DetailSettings; ctx: BuildContext }) {
    const steps = opts.steps ?? k.steps;
    const args = {
      model, positive: c.positive, negative: c.negative, latent_image: latent, seed,
      steps, cfg: k.cfg, sampler_name: opts.sampler_name ?? input.sampler, scheduler: opts.scheduler ?? input.scheduler, denoise: opts.denoise ?? 1,
    };
    const sampled = detail ? kSample(g, args, detail.input, detail.ctx) : g.out("KSampler", args);
    return { latent: sampled, pass: { node: sampled[0], steps } };
  }

  /** The size a picture (or a part of one) is worked on at: its own shape, both edges multiples of 16, at most about `megapixels`. */
  function sizeOf(of: { width: number; height: number } | undefined, megapixels = spec.megapixels, least = 0.6) {
    if (!of?.width || !of.height) return { width: 1024, height: 1024 };
    const mp = (of.width * of.height) / (1024 * 1024);
    // large pictures are brought down to what the model draws well; small parts are brought up to where it has room to draw
    const k = mp > megapixels ? Math.sqrt(megapixels / mp) : mp < least ? Math.sqrt(least / mp) : 1;
    return { width: roundTo(of.width * k, 16), height: roundTo(of.height * k, 16) };
  }

  /** What the checker's variants share: a fine-tune with a shift, a CFG, its steps, a negative prompt and a LoRA. */
  const tuned = { model: spec.fineTune, shift: 4, cfg: 3, steps: 25, negative: "blurry", loras: [{ file: "l.safetensors", weight: 0.8 }] };

  /**
   * Turbo's LoRA, when Turbo is on and the model picked is not made for a few steps (load): the family's file this input
   * needs (Recipe.needsWith), so that a pod is sent it and a machine without it does not take the job at the full steps.
   */
  const turboNeeds = (input: FlowBase): string[] =>
    spec.turbo && input.fast && !spec.turbo.named.test((input.model ?? "").split(/[\\/]/).pop() ?? "") ? [spec.turbo.slot] : [];

  return { inputs, loadNodes, SOMETIMES, SECOND_PASS, load, shifted, condFrom, cond, sample, sizeOf, tuned, turboNeeds };
}
export type FlowKit = ReturnType<typeof flowKit>;
