import { roundTo, type BuildContext, type GraphBuilder, type InputSpec, type LoraValue, type Phase, type ReferenceValue, type Ref } from "@afflatus/core";
import { detailModel, detailSampler, sharpenRange, usesDaemon, type DetailSettings } from "../shared/detail";
import { loadUnet, unetNodes } from "../shared/unet";

/** What every Klein recipe asks for besides its own inputs. */
export interface KleinBase {
  model?: string;
  negative: string;
  loras: LoraValue[];
  steps: number;
  cfg: number;
  sampler: string;
  seed: number;
}

/** Which Klein model: the base one, a distilled one, or a fine-tune. The form starts on the one found by name. */
export const kleinModel: InputSpec = {
  id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["^(?!.*(minimax|h3)).*flux-?2.*klein", "^(?!.*(minimax|h3)).*(klein|f2k)"],
  note: "FLUX.2 Klein: the base model, a distilled one (4 steps, CFG 1), or a fine-tune",
};

/** How it samples: the values of ComfyUI's own Klein template for the base model, each kept per model once saved. */
export const kleinInputs: InputSpec[] = [
  { id: "loras", type: "loras", label: "LoRAs", max: 4 },
  // empty, as ComfyUI's templates have it: a fixed list ("cartoon, illustration") fights the styles the model is asked for
  { id: "negative", type: "prompt", label: "Negative prompt", note: "only acts with a CFG scale above 1, so not with a distilled model. Empty in ComfyUI's templates; a short list of what must not appear, when something does", style: "sentences", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", note: "20 for the base model, 4 for a distilled one", min: 1, max: 60, step: 1, default: 20, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "CFG scale", note: "5 for the base model, 1 for a distilled one", min: 1, max: 12, step: 0.5, default: 5, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSamplerSelect", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
  { id: "seed", type: "seed", label: "Seed" },
];

/** About one megapixel at this shape, both edges multiples of 16: where Klein draws best. */
export function kleinSize(of: { width: number; height: number } | undefined, megapixels = 1) {
  if (!of?.width || !of.height) return { width: 1024, height: 1024 };
  const k = Math.sqrt((megapixels * 1024 * 1024) / (of.width * of.height));
  return { width: roundTo(of.width * k, 16), height: roundTo(of.height * k, 16) };
}

export interface Klein {
  model: Ref;
  clip: Ref;
  vae: Ref;
  input: KleinBase;
  loads: string[];
}

export const LOAD_NODES = (input: KleinBase) => [...unetNodes(input.model), "CLIPLoader", "VAELoader", ...(input.loras.some((l) => l.weight !== 0) ? ["LoraLoaderModelOnly"] : [])];
export const SAMPLE_NODES = ["CLIPTextEncode", "Flux2Scheduler", "CFGGuider", "KSamplerSelect", "RandomNoise", "SamplerCustomAdvanced", "VAEDecode"];
export const REFERENCE_NODES = ["LoadImage", "ImageScaleToTotalPixels", "VAEEncode", "ReferenceLatent"];

/** The model with its LoRAs, the text reader and the picture decoder. */
export function loadKlein(g: GraphBuilder, input: KleinBase, ctx: BuildContext): Klein {
  const unet = input.model ?? ctx.slots.unet;
  let model = loadUnet(g, ctx, unet);
  for (const l of input.loras) {
    if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
  }
  return {
    model,
    clip: g.out("CLIPLoader", { clip_name: ctx.slots.clip, type: "flux2", device: "default" }),
    vae: g.out("VAELoader", { vae_name: ctx.slots.vae }),
    input,
    loads: [`diffusion_models/${unet}`, `text_encoders/${ctx.slots.clip}`, `vae/${ctx.slots.vae}`],
  };
}

/** Both texts read, each carrying the pictures to follow (scaled to about a megapixel, less when there are many). */
export function kleinCond(g: GraphBuilder, k: Klein, text: string, pictures: Ref[]) {
  let positive = g.out("CLIPTextEncode", { text, clip: k.clip });
  let negative = g.out("CLIPTextEncode", { text: k.input.negative, clip: k.clip });
  const megapixels = pictures.length > 3 ? 0.6 : 1;
  for (const picture of pictures) {
    const scaled = g.out("ImageScaleToTotalPixels", { image: picture, upscale_method: "lanczos", megapixels, resolution_steps: 16 });
    const latent = g.out("VAEEncode", { pixels: scaled, vae: k.vae });
    positive = g.out("ReferenceLatent", { conditioning: positive, latent });
    negative = g.out("ReferenceLatent", { conditioning: negative, latent });
  }
  return { positive, negative };
}

/**
 * Sampling the way Klein is run: its own scheduler, and euler unless another sampler is picked. A strength under 1 keeps the first part of
 * what is there (the sigmas are split and only the end of them is run).
 */
export function kleinSample(
  g: GraphBuilder, k: Klein, cond: { positive: Ref; negative: Ref }, latent: Ref, size: { width: number; height: number }, seed: number,
  opts: { steps?: number; strength?: number; detail?: { input: DetailSettings; ctx: BuildContext } } = {},
) {
  const { sampled, pass } = kleinSampleLatent(g, k, cond, latent, size, seed, opts);
  g.phase("decoding");
  const image = g.out("VAEDecode", { samples: sampled, vae: k.vae });
  return { image, pass };
}

/** The same sampling, left as a latent (for a pass in tiles, decoded with the others). With the detail boost when one is given. */
export function kleinSampleLatent(
  g: GraphBuilder, k: Klein, cond: { positive: Ref; negative: Ref }, latent: Ref, size: { width: number; height: number }, seed: number,
  opts: { steps?: number; strength?: number; detail?: { input: DetailSettings; ctx: BuildContext }; phase?: Phase } = {},
) {
  const steps = opts.steps ?? k.input.steps;
  const strength = opts.strength ?? 1;
  let sigmas = g.out("Flux2Scheduler", { steps, width: size.width, height: size.height });
  if (strength < 1) sigmas = g.out("SplitSigmasDenoise", { sigmas, denoise: strength }, 1);
  const range = opts.detail && !usesDaemon(opts.detail.input, opts.detail.ctx) ? sharpenRange(opts.detail.input, steps, strength) : null;
  const model = opts.detail ? detailModel(g, k.model, opts.detail.input, opts.detail.ctx) : k.model;
  const guider = g.out("CFGGuider", { model, positive: cond.positive, negative: cond.negative, cfg: k.input.cfg });
  let sampler = g.out("KSamplerSelect", { sampler_name: k.input.sampler });
  if (opts.detail) sampler = detailSampler(g, sampler, opts.detail.input, opts.detail.ctx);
  const noise = g.out("RandomNoise", { noise_seed: seed });
  // a pass over tiles of a finished picture is a refine pass, as the other families' say
  g.phase(opts.phase ?? "sampling");
  if (range) {
    // the sharpen only between its steps: the sigmas cut at both ends, the plain model before and after
    const plain = g.out("CFGGuider", { model: k.model, positive: cond.positive, negative: cond.negative, cfg: k.input.cfg });
    const first = g.add("SplitSigmas", { sigmas, step: range.from });
    const rest = g.add("SplitSigmas", { sigmas: [first, 1], step: range.to - range.from });
    const parts: Array<[Ref, Ref, number]> = [[plain, [first, 0], range.from], [guider, [rest, 0], range.to - range.from], [plain, [rest, 1], steps - range.to]];
    let at = latent;
    let last: Ref = latent;
    parts.filter(([, , n]) => n > 0).forEach(([gd, sg], i) => {
      last = g.out("SamplerCustomAdvanced", { noise: i === 0 ? noise : g.out("DisableNoise", {}), guider: gd, sampler, sigmas: sg, latent_image: at });
      at = last;
    });
    return { sampled: last, pass: { node: last[0], steps } };
  }
  const sampled = g.out("SamplerCustomAdvanced", { noise, guider, sampler, sigmas, latent_image: latent });
  return { sampled, pass: { node: sampled[0], steps: Math.max(1, Math.round(steps * strength)) } };
}

const WHAT: Record<ReferenceValue["role"], (many: boolean) => string> = {
  person: (many) => `${many ? "show" : "shows"} who is in it`,
  place: (many) => `${many ? "show" : "shows"} the place: the scene is there`,
  clothing: (many) => `${many ? "show" : "shows"} what is worn`,
  object: (many) => `${many ? "show" : "shows"} a thing that is in it`,
  style: (many) => `${many ? "show" : "shows"} the look the picture has`,
};

/**
 * One sentence saying what each reference picture is, by its number: Klein is handed the pictures in
 * order and has no other way to know which one is the person and which one the place. `first` is the
 * number of the first reference (2 when the picture being changed comes before them).
 */
export function introduce(refs: ReferenceValue[], first = 1): string {
  if (!refs.length) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < refs.length) {
    let j = i;
    while (j + 1 < refs.length && refs[j + 1]!.role === refs[i]!.role) j++;
    const many = j > i;
    parts.push(`${many ? `Pictures ${first + i} to ${first + j}` : `Picture ${first + i}`} ${WHAT[refs[i]!.role](many)}`);
    i = j + 1;
  }
  const keep = refs.some((r) => r.role === "person") ? " Keep each person's face, hair and build exactly as in their pictures." : "";
  return `${parts.join("; ")}.${keep}`;
}

/** The words Klein is given: what the pictures are, then what the user wrote. */
export const withIntro = (intro: string, prompt: string) => [intro, prompt.trim()].filter(Boolean).join(" ");
