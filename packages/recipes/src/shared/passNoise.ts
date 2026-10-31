import type { InputSpec } from "@afflatus/core";

/**
 * How the light second pass of a flow model (hires fix, Upscale 2x) reads its denoise, card #146. ComfyUI's way, the one the
 * forms use: int(steps / denoise) steps laid out at the model's shift for the pass's size, the last ones run, so that FLUX.1's
 * Upscale 2x, whose shift grows with the size, starts its 0.25 from 0.81 of real noise on a 1536×2048 gone over whole, and
 * Klein's (its scheduler's mu is 2.2 already at 1 MP) from 0.73–0.75.
 * "1 MP shift": the pass keeps the shift of one megapixel, as Krea 2 does at every size. "Real σ": the field is the noise
 * it starts from, as the H3 re-latent's (card #141). The two others are for side-by-sides on a pod: no default moves before
 * the owner has seen them (#141 and #144 showed that the real σ is not always the better picture).
 */
export const PASS_NOISE = { comfy: "ComfyUI's", oneMp: "1 MP shift", real: "Real σ" } as const;
export type PassNoise = (typeof PASS_NOISE)[keyof typeof PASS_NOISE];

export const PASS_NOISE_INPUT: InputSpec = {
  id: "passNoise", type: "choice", label: "Second pass noise", options: Object.values(PASS_NOISE), default: PASS_NOISE.comfy, internal: true,
};

/** The noise level a field's denoise starts from, as its "?" says it: two decimals. */
export const sigmaWords = (sigma: number) => sigma.toFixed(2);
