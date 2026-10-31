/**
 * Noise levels (sigmas) as ComfyUI's schedulers work them out, for the settings that say one: a re-sample's denoise that
 * is the σ it starts at, and the older ones that were a share of a schedule's steps instead.
 */

/** Where a gentle re-sample ends before its last step to zero (variant E of card #138): the karras tail stops here. */
export const RESAMPLE_SIGMA_FLOOR = 0.012;

/** What a flow model's shift does to a timestep t (0 to 1): ComfyUI's time_snr_shift. */
export const shifted = (shift: number, t: number): number => (shift * t) / (1 + (shift - 1) * t);

/**
 * The σ ComfyUI's BasicScheduler starts at for a denoise below 1, on the "simple" schedule of a flow model at this shift:
 * it lays out int(steps / denoise) steps over the model's 1000 timesteps and keeps the last steps + 1. At shift 8, denoise
 * 0.15 over 2 steps starts at 0.593, not 0.15: what the H3 finish's denoise meant until card #141.
 */
export function simpleStartSigma(denoise: number, steps: number, shift: number): number {
  if (denoise >= 0.9999) return shifted(shift, 1);
  const total = Math.trunc(steps / denoise);
  const x = Math.max(0, total - steps);
  return shifted(shift, (1000 - Math.trunc(x * (1000 / total))) / 1000);
}

/** ComfyUI's KarrasScheduler (k-diffusion's get_sigmas_karras): `steps` levels from `max` to `min` on a ρ curve, then 0. */
export function karrasSigmas(steps: number, max: number, min: number, rho = 7): number[] {
  const hi = max ** (1 / rho);
  const lo = min ** (1 / rho);
  const ramp = (i: number) => (steps > 1 ? i / (steps - 1) : 0);
  return [...Array.from({ length: steps }, (_, i) => (hi + ramp(i) * (lo - hi)) ** rho), 0];
}

/**
 * A re-sample's older denoise (BasicScheduler's, at a shift) as the σ it really started at, rounded as the form shows it;
 * null for the pair the form used to start on, which was never a choice: the new defaults apply instead (card #141).
 */
export function sigmaOfOldDenoise(old: { denoise: number; steps: number; shift: number }, oldDefault: { denoise: number; steps: number }): number | null {
  if (old.denoise === oldDefault.denoise && old.steps === oldDefault.steps) return null;
  return Math.round(simpleStartSigma(old.denoise, old.steps, old.shift) * 100) / 100;
}

/**
 * How a flow model turns a timestep into a σ: SD3's and AuraFlow's shift (ModelSamplingDiscreteFlow, ModelSamplingAuraFlow:
 * Z-Image, Qwen Image, H3), or FLUX's mu (ModelSamplingFlux: FLUX.1, which sets it from the picture's size, and Krea 2).
 */
export type FlowSampling = { shift: number } | { mu: number };

/** The σ of a flow model at timestep t (0 to 1), and how many timesteps ComfyUI's table of it holds (FLUX's 10000, the others' 1000). */
const sigmaAt = (s: FlowSampling, t: number): number => ("mu" in s ? Math.exp(s.mu) / (Math.exp(s.mu) + (1 / t - 1)) : shifted(s.shift, t));
const timesteps = (s: FlowSampling) => ("mu" in s ? 10000 : 1000);

/**
 * FLUX.1's mu for a picture of this size, as ComfyUI's ModelSamplingFlux node works it out: base_shift at 256 tokens, max_shift
 * at 4096 (1 MP), on a line past it. With the usual 1.15, a 1.5× hires pass of 896×1152 is at 1.99, a 2× of 768×1024 at 2.54.
 */
export function fluxMu(width: number, height: number, maxShift = 1.15, baseShift = 0.5): number {
  const m = (maxShift - baseShift) / (4096 - 256);
  return ((width * height) / (8 * 8 * 2 * 2)) * m + (baseShift - m * 256);
}

/**
 * The σ a KSampler (or BasicScheduler) pass of `steps` at a denoise below 1 starts at, on the "simple" schedule: it lays out
 * int(steps / denoise) steps over the model's timesteps and keeps the last steps + 1. simpleStartSigma, for any flow model.
 */
export function flowStartSigma(s: FlowSampling, steps: number, denoise: number): number {
  if (denoise >= 0.9999) return sigmaAt(s, 1);
  const n = timesteps(s);
  const total = Math.trunc(steps / denoise);
  return sigmaAt(s, (n - Math.trunc(Math.max(0, total - steps) * (n / total))) / n);
}

/**
 * The denoise a KSampler pass of `steps` is given so that, on the "simple" schedule, it starts at the real σ `sigma` (the
 * nearest its whole number of laid-out steps reaches): the field read as the noise it means, as A1111's is on an eps model
 * (card #146). The value is steps / (T + 0.5), so that ComfyUI's int(steps / denoise) gives T back whatever the rounding.
 */
export function denoiseForSigma(s: FlowSampling, steps: number, sigma: number): number {
  if (sigma >= sigmaAt(s, 1) - 1e-6) return 1;
  let best = steps;
  let gap = Infinity;
  // the start falls as the laid-out steps grow: it is past the field once below it
  for (let total = steps; total <= steps * 100; total++) {
    const at = total === steps ? sigmaAt(s, 1) : flowStartSigma(s, steps, steps / (total + 0.5));
    if (Math.abs(at - sigma) < gap) { gap = Math.abs(at - sigma); best = total; }
    if (at < sigma) break;
  }
  return best === steps ? 1 : Math.round((steps / (best + 0.5)) * 1e4) / 1e4;
}

/**
 * ComfyUI's Flux2Scheduler (FLUX.2 Klein): `steps` levels from 1 down at an empirical mu that follows the picture's tokens
 * and, under 4300 of them, the steps too; then 0.
 */
export function flux2Sigmas(steps: number, width: number, height: number): number[] {
  const seq = Math.round((width * height) / 256);
  const [a1, b1, a2, b2] = [8.73809524e-5, 1.89833333, 0.00016927, 0.45666666];
  let mu = a2 * seq + b2;
  if (seq <= 4300) {
    const m10 = a1 * seq + b1;
    const a = (mu - m10) / 190;
    mu = a * steps + (mu - 200 * a);
  }
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = 1 - i / steps;
    return i === steps ? 0 : Math.exp(mu) / (Math.exp(mu) + (1 / t - 1));
  });
}

/** The σ a Klein pass starts at: Flux2Scheduler's `steps` cut by SplitSigmasDenoise at `denoise`, which keeps the last round(steps × denoise). */
export function flux2StartSigma(steps: number, width: number, height: number, denoise: number): number {
  if (denoise >= 1) return 1;
  return flux2Sigmas(steps, width, height)[Math.max(0, steps - Math.round(steps * denoise))]!;
}

/**
 * What a Klein pass of `run` steps is laid out over so that it starts at the real σ `sigma` (the nearest): Flux2Scheduler's
 * steps, and the SplitSigmasDenoise denoise that keeps `run` of them (run / steps, which its round() gives back exactly).
 */
export function flux2ForSigma(run: number, width: number, height: number, sigma: number): { steps: number; denoise: number } {
  let best = run;
  let gap = Infinity;
  for (let steps = run; steps <= run * 100; steps++) {
    const at = flux2Sigmas(steps, width, height)[steps - run]!;
    if (Math.abs(at - sigma) < gap) { gap = Math.abs(at - sigma); best = steps; }
    if (at < sigma) break;
  }
  return { steps: best, denoise: best === run ? 1 : Math.round((run / best) * 1e4) / 1e4 };
}
