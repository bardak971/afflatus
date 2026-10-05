/**
 * A size on a model's grid: the nearest multiple of `grid`, and never under `min` (the grid itself unless
 * said otherwise). The picture models want multiples of 16, the encoders 8, H3's latent upscale 32.
 */
export const roundTo = (n: number, grid: number, min = grid): number => Math.max(min, Math.round(n / grid) * grid);
