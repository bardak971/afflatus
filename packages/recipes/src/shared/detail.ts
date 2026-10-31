import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

/**
 * Detail boost: more fine detail (skin, fabric, hair, foliage) from the same model, steps and time. Two ways:
 * Detail Daemon's Lying sigma sampler, which tells the model a little less noise is left than there is in the
 * middle of the sampling, so it keeps adding detail instead of smoothing; or, built into ComfyUI, a sharpen of
 * what the model predicts at each step. One switch and a strength up front; the way and the part of the
 * sampling it works on are under All settings.
 */
export interface DetailSettings {
  detail: boolean;
  detailStrength: number;
  detailMethod: string;
  detailStart: number;
  detailEnd: number;
}

const DETAIL_AUTO = "Auto";
const DETAIL_DAEMON = "Lying sigma (Detail Daemon)";
const DETAIL_SHARPEN = "Sharpen while sampling (built in)";
/** Detail Daemon's node (the ComfyUI-Detail-Daemon pack). */
export const LYING_SIGMA = "LyingSigmaSampler";
export const DAEMON_NEEDED = `"${DETAIL_DAEMON}" needs the ComfyUI-Detail-Daemon pack (its ${LYING_SIGMA} node). Install it with ComfyUI-Manager, or pick Auto or "${DETAIL_SHARPEN}".`;
const SHARPEN_NODES = ["LatentOperationSharpen", "LatentApplyOperationCFG"];
const CUSTOM_NODES = ["KSamplerSelect", "BasicScheduler", "CFGGuider", "RandomNoise", "SamplerCustomAdvanced"];

export const DETAIL_INPUTS: InputSpec[] = [
  { id: "detail", type: "toggle", label: "Detail boost", note: "more fine detail (skin, fabric, hair) from the same model and steps", default: false, perModel: true },
  { id: "detailStrength", type: "number", label: "Detail strength", note: "0.5 is a clear gain; past 0.8 textures can turn grainy", min: 0.1, max: 1, step: 0.05, default: 0.5, showWhen: "detail", perModel: true },
  {
    id: "detailMethod", type: "choice", label: "Detail method", options: [DETAIL_AUTO, DETAIL_DAEMON, DETAIL_SHARPEN], default: DETAIL_AUTO, showWhen: "detail", advanced: true, perModel: true,
    note: "Auto: Lying sigma when the Detail Daemon pack is installed, else the built-in sharpen. Lying sigma (dishonesty factor = strength × −0.06) adds detail; the sharpen (alpha = strength × 0.2) crisps what is there",
  },
  { id: "detailStart", type: "number", label: "Detail start %", note: "the part of the sampling it works on: the start sets the composition, best left alone", min: 0, max: 1, step: 0.05, default: 0.2, unit: "", showWhen: "detail", advanced: true, perModel: true },
  { id: "detailEnd", type: "number", label: "Detail end %", min: 0, max: 1, step: 0.05, default: 0.9, showWhen: "detail", advanced: true, perModel: true },
];

/** Whether this render boosts detail with Detail Daemon's sampler (and so samples through ComfyUI's custom sampler nodes). */
export function usesDaemon(input: DetailSettings, ctx: BuildContext): boolean {
  if (!input.detail) return false;
  if (input.detailMethod === DETAIL_DAEMON) {
    if (!ctx.has(LYING_SIGMA)) throw new Error(DAEMON_NEEDED);
    return true;
  }
  return input.detailMethod === DETAIL_AUTO && ctx.has(LYING_SIGMA);
}

/** The model, sharpened while it samples when the built-in way is the one (otherwise as it is). */
export function detailModel(g: GraphBuilder, model: Ref, input: DetailSettings, ctx: BuildContext): Ref {
  if (!input.detail || usesDaemon(input, ctx)) return model;
  const operation = g.out("LatentOperationSharpen", { sharpen_radius: 9, sigma: 1, alpha: Math.round(input.detailStrength * 0.2 * 1000) / 1000 });
  return g.out("LatentApplyOperationCFG", { model, operation });
}

/** A sampler (KSamplerSelect's) wrapped in Detail Daemon's when that is the way; otherwise as it is. */
export function detailSampler(g: GraphBuilder, sampler: Ref, input: DetailSettings, ctx: BuildContext): Ref {
  if (!usesDaemon(input, ctx)) return sampler;
  return g.out(LYING_SIGMA, { sampler, dishonesty_factor: Math.round(-0.06 * input.detailStrength * 1000) / 1000, start_percent: input.detailStart, end_percent: input.detailEnd });
}

/** What a KSampler takes. */
interface KSamplerArgs {
  model: Ref;
  positive: Ref;
  negative: Ref;
  latent_image: Ref;
  seed: number;
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  denoise: number;
}

/**
 * A KSampler, with the detail boost asked for: the model sharpened, or the same sampling through ComfyUI's
 * custom sampler nodes with Detail Daemon's sampler in it (a KSampler cannot take another sampler).
 */
export function kSample(g: GraphBuilder, args: KSamplerArgs, input: DetailSettings, ctx: BuildContext): Ref {
  if (!usesDaemon(input, ctx)) {
    const range = sharpenRange(input, args.steps, args.denoise);
    if (!range) return g.out("KSampler", { ...args, model: detailModel(g, args.model, input, ctx) });
    // the sharpen only between its steps: the first ones (the layout) and the last ones as the model draws them
    const sharp = detailModel(g, args.model, input, ctx);
    const common = { positive: args.positive, negative: args.negative, noise_seed: args.seed, steps: args.steps, cfg: args.cfg, sampler_name: args.sampler_name, scheduler: args.scheduler };
    let latent = args.latent_image;
    const parts: Array<[Ref, number, number]> = [[args.model, 0, range.from], [sharp, range.from, range.to], [args.model, range.to, args.steps]];
    parts.filter(([, a, b]) => b > a).forEach(([model, a, b], i, all) => {
      latent = g.out("KSamplerAdvanced", { ...common, model, latent_image: latent, add_noise: i === 0 ? "enable" : "disable", start_at_step: a, end_at_step: b, return_with_leftover_noise: i < all.length - 1 ? "enable" : "disable" });
    });
    return latent;
  }
  const sigmas = g.out("BasicScheduler", { model: args.model, scheduler: args.scheduler, steps: args.steps, denoise: args.denoise });
  const guider = g.out("CFGGuider", { model: args.model, positive: args.positive, negative: args.negative, cfg: args.cfg });
  const sampler = detailSampler(g, g.out("KSamplerSelect", { sampler_name: args.sampler_name }), input, ctx);
  const noise = g.out("RandomNoise", { noise_seed: args.seed });
  return g.out("SamplerCustomAdvanced", { noise, guider, sampler, sigmas, latent_image: args.latent_image });
}

/**
 * The steps the built-in sharpen works on, when it is not all of them: a full sampling (denoise 1) whose layout
 * steps must be left alone. A light pass over a picture (denoise below 1) keeps the picture's layout anyway.
 */
export function sharpenRange(input: DetailSettings, steps: number, denoise = 1): { from: number; to: number } | null {
  if (!input.detail || denoise < 1) return null;
  const from = Math.max(0, Math.min(steps, Math.round(steps * input.detailStart)));
  const to = Math.max(from, Math.min(steps, Math.round(steps * input.detailEnd)));
  return from === 0 && to === steps ? null : { from, to };
}

/**
 * The nodes the detail boost needs for these settings. With Auto, the built-in way's: Detail Daemon's is taken
 * only when ComfyUI has it, with ComfyUI's own custom sampler nodes.
 */
export function detailNodes(input: DetailSettings, sampler: "KSampler" | "custom" = "KSampler"): string[] {
  if (!input.detail) return [];
  if (input.detailMethod === DETAIL_DAEMON) return [LYING_SIGMA, ...(sampler === "KSampler" ? CUSTOM_NODES : [])];
  return SHARPEN_NODES;
}

/**
 * The sampler nodes of a full pass (denoise 1) with these settings: a KSampler, or the KSamplerAdvanced steps
 * when the built-in sharpen works on part of them (or, for a custom sampler, the sigmas split for it).
 */
export function fullPassNodes(input: DetailSettings, steps: number, sampler: "KSampler" | "custom" = "KSampler"): string[] {
  const ranged = input.detailMethod !== DETAIL_DAEMON && sharpenRange(input, steps) !== null;
  if (sampler === "custom") return ranged ? ["SplitSigmas", "DisableNoise"] : [];
  return ranged ? ["KSamplerAdvanced"] : ["KSampler"];
}

/** What a recipe with the detail boost uses only when ComfyUI has it (Auto takes Detail Daemon when it is installed). */
export const DETAIL_OPTIONAL = [LYING_SIGMA];

/** A variant with the detail boost on, built as on a ComfyUI without Detail Daemon (the graph checker's catalog has not got it). */
export const withoutDaemon = (node: string) => node !== LYING_SIGMA;
