/**
 * RunPod's price of a standard network volume, USD per GB and month: one figure for the server (each volume's row, what
 * storage costs a month) and the forms (Make a volume…, Grow…), so that what a button says is what the row says after.
 */
export const VOLUME_PER_GB_MONTH = 0.07;
/** Past its first TB, a GB costs less. */
export const VOLUME_PER_GB_MONTH_PAST_TB = 0.05;
const TB_GB = 1000;

/** What a volume of this size costs a month, USD, unrounded: the first TB at the full price, the rest at the lower one. */
export function volumePerMonth(gbs: number): number {
  const size = Math.max(0, gbs);
  return Math.min(size, TB_GB) * VOLUME_PER_GB_MONTH + Math.max(0, size - TB_GB) * VOLUME_PER_GB_MONTH_PAST_TB;
}
