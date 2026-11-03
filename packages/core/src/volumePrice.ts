import { GB } from "./money";

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

/** The sizes RunPod makes a network volume in, GB. */
export const VOLUME_MIN_GB = 10;
export const VOLUME_MAX_GB = 4096;

/**
 * The size a volume wants for these bytes: a quarter more, up to the next ten GB (of 2^30 bytes, as RunPod's volumes read),
 * within what RunPod takes. Make a volume…'s plan and Costs' "a volume would have kept them" both size by it: Costs said a
 * tenth more, in GB of 10^9 bytes, with no ceiling, so it advised a smaller and cheaper volume than the plan made.
 */
export const volumeSizeFor = (bytes: number): number => Math.min(VOLUME_MAX_GB, Math.max(VOLUME_MIN_GB, Math.ceil((bytes * 1.25) / GB / 10) * 10));

/** What a running pod's own disk costs, USD per GB and month (RunPod's price for the volume disk of a running pod). */
export const RUNNING_DISK_PER_GB_MONTH = 0.1;
/** What a stopped pod's own disk costs, USD per GB and month (RunPod's price for the volume disk of a stopped pod). */
export const STOPPED_DISK_PER_GB_MONTH = 0.2;
/** The hours of a month RunPod's monthly prices of storage are billed over, by the hour (365 × 24 / 12). */
export const HOURS_A_MONTH = 730;

/** What a pod's own disk adds to its GPU's price an hour while it runs (USD): RunPod bills it with the GPU. */
export const diskPerHour = (gb: number): number => (Math.max(0, gb) * RUNNING_DISK_PER_GB_MONTH) / HOURS_A_MONTH;

/** A price per GB and month as a tip says it: "$0.10/GB a month". */
export const perGbMonth = (usd: number): string => `$${usd.toFixed(2)}/GB a month`;
