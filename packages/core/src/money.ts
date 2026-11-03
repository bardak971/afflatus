/**
 * Money and its units, one copy for the server and the web: what a rented GPU's time costs, how a dollar amount is said,
 * where a month and a day start, and how long a pod's files take to come. Each was written by hand in a dozen places,
 * and the copies had drifted: a file read 6.9 GB in Costs' advice and 6.4 GB in its tip, "$12.5" in a notice and "$12.50"
 * on the tab (the 2026-11-02 review).
 */

/** A GB as Afflatus says sizes, everywhere: 2^30 bytes (what a disk tool and RunPod's volumes read). */
export const GB = 2 ** 30;
export const HOUR_MS = 3_600_000;

/** What `ms` of a machine billed at `rate` ($ an hour) costs, USD, unrounded. */
export const usdFor = (ms: number, rate: number): number => (ms / HOUR_MS) * rate;

/**
 * What a run (its start and end, ms, at `rate` an hour) cost over its part from `from` to `to` (ms): 0 when they do not
 * overlap or a time could not be read. The batch notice, the 7-day pace, the caps and an MCP token's spend all count by it.
 */
export function runCost(start: number, end: number, rate: number, from = -Infinity, to = Infinity): number {
  const a = Math.max(from, start);
  const b = Math.min(to, end);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? usdFor(b - a, rate) : 0;
}

/** An amount rounded to the cent, as an answer gives it. */
export const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * An amount in US dollars, as a rented GPU's cost is said: cents under $100 ("$0.69", "$12.40"), whole dollars past it.
 * `fine`: a cost that runs (a pod's, by the second), to a tenth of a cent under a dollar ("$0.012"), so that it is seen to move.
 */
export function usd(n: number, fine = false): string {
  if (fine && n > 0 && n < 1) return `$${n.toFixed(3)}`;
  return n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

/** The start of the user's day holding `at` (ms, local time): what "today" counts from. */
export function dayStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The start of the user's month holding `at` (ms, local time), or of the one `ahead` months after: a cap's month. */
export function monthStart(at: number, ahead = 0): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth() + ahead, 1).getTime();
}

/** A source's speeds (bytes a second, slowest to fastest), `guessed` when no pod has measured it yet. */
export interface SpeedRange {
  low: number;
  high: number;
  guessed?: boolean;
}

/**
 * How long files take to reach a pod (ms, fastest and slowest), each at its source's speeds, one after another (a pod
 * takes two at a time, which share its line). `guessed`: a source of them was never measured and its guess is in it.
 * Null when a source has no range at all. A file of unknown size or source adds nothing.
 */
export function fetchTime<K extends string>(files: ReadonlyArray<{ bytes: number | null | undefined; kind: K | null | undefined }>, speeds: Readonly<Record<K, SpeedRange | null>>): { fastMs: number; slowMs: number; guessed: boolean } | null {
  let fastMs = 0;
  let slowMs = 0;
  let guessed = false;
  for (const f of files) {
    if (!f.bytes || f.bytes <= 0 || !f.kind) continue;
    const r = speeds[f.kind];
    if (!r) return null;
    guessed ||= Boolean(r.guessed);
    fastMs += (f.bytes / r.high) * 1000;
    slowMs += (f.bytes / r.low) * 1000;
  }
  return { fastMs, slowMs, guessed };
}
