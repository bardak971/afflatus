import type { BuildContext, GraphBuilder, InputSpec, LoraValue, Ref } from "@afflatus/core";
import { loadUnet, unetNodes } from "../shared/unet";

/** What every Krea 2 recipe asks for besides its own inputs. */
export interface Krea2Base {
  model?: string;
  negative: string;
  loras: LoraValue[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  shift: number;
  seed: number;
}

/** Which Krea 2 model: Turbo, or a fine-tune of it. The form starts on the one found by name. */
export const krea2Model: InputSpec = {
  id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["krea.?2", "(^|[^a-z0-9])k2([^a-z0-9]|$)"],
  note: "Krea 2 Turbo, or a fine-tune of it",
};

/** How it samples: the values of ComfyUI's own Krea 2 Turbo template to begin with, each kept per model once saved. */
export const krea2Inputs: InputSpec[] = [
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
  { id: "negative", type: "prompt", label: "Negative prompt", note: "only acts with a CFG scale above 1", style: "sentences", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", note: "8 for Turbo and its fine-tunes", min: 1, max: 60, step: 1, default: 8, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "CFG scale", note: "1 for Turbo. Above 1 the negative prompt acts and every step takes twice as long", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
  { id: "shift", type: "number", label: "Shift", note: "0 leaves the model's own. Some fine-tunes ask for another (4, for example)", min: 0, max: 12, step: 0.05, default: 0, advanced: true, perModel: true },
  { id: "seed", type: "seed", label: "Seed" },
];

export const r16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);

/** The size a picture (or a part of one) is worked on at: its own shape, both edges multiples of 16, at most about `megapixels`. */
export function krea2Size(of: { width: number; height: number } | undefined, megapixels = 1.6, least = 0.6) {
  if (!of?.width || !of.height) return { width: 1024, height: 1024 };
  const mp = (of.width * of.height) / (1024 * 1024);
  // large pictures are brought down to what the model draws well; small parts are brought up to where it has room to draw
  const k = mp > megapixels ? Math.sqrt(megapixels / mp) : mp < least ? Math.sqrt(least / mp) : 1;
  return { width: r16(of.width * k), height: r16(of.height * k) };
}

export interface Krea2 {
  /** The model with its LoRAs, before any shift. */
  model: Ref;
  clip: Ref;
  vae: Ref;
  input: Krea2Base;
  seed: number;
  loads: string[];
}

export const LOAD_NODES = (input: Krea2Base) => [
  ...unetNodes(input.model), "CLIPLoader", "VAELoader", "CLIPTextEncode", "KSampler", "VAEDecode", "PreviewImage",
  ...(input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : []),
  ...(input.negative.trim() ? [] : ["ConditioningZeroOut"]),
  ...(input.shift > 0 ? ["ModelSamplingAuraFlow"] : []),
];

/** The model with its LoRAs, the text encoder and the VAE. */
export function loadKrea2(g: GraphBuilder, input: Krea2Base, ctx: BuildContext): Krea2 {
  const unet = input.model ?? ctx.slots.unet;
  let model = loadUnet(g, ctx, unet);
  for (const l of input.loras) {
    if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
  }
  return {
    model,
    clip: g.out("CLIPLoader", { clip_name: ctx.slots.clip, type: "krea2", device: "default" }),
    vae: g.out("VAELoader", { vae_name: ctx.slots.vae }),
    input,
    seed: ctx.seed,
    loads: [`diffusion_models/${unet}`, `text_encoders/${ctx.slots.clip}`, `vae/${ctx.slots.vae}`],
  };
}

/** The model as it is sampled with: the shift typed in, or the model's own when it is 0. */
export const shifted = (g: GraphBuilder, model: Ref, input: Krea2Base) => (input.shift > 0 ? g.out("ModelSamplingAuraFlow", { model, shift: input.shift }) : model);

/**
 * The two texts. Turbo has no use for a negative prompt (it runs at CFG 1): without one, the negative
 * side is the positive one emptied, as in ComfyUI's template.
 */
export function krea2Cond(g: GraphBuilder, k: Krea2, positive: Ref) {
  return { positive, negative: k.input.negative.trim() ? g.out("CLIPTextEncode", { text: k.input.negative, clip: k.clip }) : g.out("ConditioningZeroOut", { conditioning: positive }) };
}

/** One pass of sampling. */
export function krea2Sample(g: GraphBuilder, k: Krea2, model: Ref, cond: { positive: Ref; negative: Ref }, latent: Ref, opts: { steps?: number; denoise?: number; sampler_name?: string; scheduler?: string } = {}) {
  const steps = opts.steps ?? k.input.steps;
  const sampled = g.out("KSampler", {
    model, positive: cond.positive, negative: cond.negative, latent_image: latent, seed: k.seed,
    steps, cfg: k.input.cfg, sampler_name: opts.sampler_name ?? k.input.sampler, scheduler: opts.scheduler ?? k.input.scheduler, denoise: opts.denoise ?? 1,
  });
  return { latent: sampled, pass: { node: sampled[0], steps } };
}
