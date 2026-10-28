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
