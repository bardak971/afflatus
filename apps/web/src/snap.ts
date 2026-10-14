/** How many decimals a number is written with (0.05 → 2), so that a sum of steps does not end in …0000001. */
const decimalsOf = (n: number) => (String(n).split(".")[1] ?? "").length;

/**
 * A number brought within `min`..`max` and onto the steps counted from `min`: what a recipe's range takes.
 * Counted from 0, the ends could fall off it (320..1080 by 16 gave 1088 at its right end, a −0.999 start
 * gave −1); rounded past `max`, it takes the last step that fits.
 */
export function snapTo(v: number, min: number, max: number, step: number): number {
  if (!(max > min)) return min;
  if (!(step > 0)) return Math.max(min, Math.min(max, v));
  const decimals = Math.max(decimalsOf(step), decimalsOf(min));
  const at = (k: number) => Number((min + k * step).toFixed(decimals));
  const last = Math.floor((max - min) / step + 1e-9);
  const k = Math.max(0, Math.min(last, Math.round((Math.max(min, Math.min(max, v)) - min) / step)));
  // the last step is counted with a little slack for sums like 0.1 + 0.2, which can then land a hair past the end
  return Math.max(min, Math.min(max, at(k)));
}

/**
 * As snapTo, but a range's own end is reached as it is when it falls between two steps: a part of a 5.06 s video, by steps of
 * 0.1, stopped at 5.0 and its last frames could not be taken (a drag past the last step's middle lands on the end).
 */
export function snapReachingEnd(v: number, min: number, max: number, step: number): number {
  const on = snapTo(v, min, max, step);
  return max - on > 0 && max - on < step && v > (on + max) / 2 ? max : on;
}

/**
 * SeedVR2's batch size: 0 is auto, else a count of frames on its 4n + 1 grid (1, 5, 9 … 49). Steps of 4 from 0 gave
 * 4, 8 … 48, which are off that grid, and never reached 49.
 */
export const seedvrBatch = (n: number): number => (!(n > 0) ? 0 : Math.min(49, 1 + 4 * Math.max(0, Math.round((n - 1) / 4))));
