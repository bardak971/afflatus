/**
 * The power a machine of this PC's draws, as its node pack reads it (GET /afflatus/power): kept as samples for a while, so
 * that a render's energy is worked out from the readings of its own stretch when it ends (renders.ts, the Costs tab's
 * electricity). The readings ride on what is read already (the 2 s load of the open pages, a render's progress and its
 * monitor's feed): no loop of its own. A rented pod is billed by the hour and never read.
 */

export interface Sample {
  at: number;
  watts: number;
}

/** A reading is held this long at most between two: past it, a stretch with no reading is not counted (Afflatus was away). */
export const HOLD_MS = 120_000;
/** The samples kept: about a day at one every two seconds, and older than a day are dropped. */
const KEEP = 50_000;
const KEEP_MS = 86_400_000;

/**
 * A render's energy from the samples of its machine: each reading held until the next (the GPU draws about the same between
 * two), from `from` to `to`; the reading just before `from` covers its start. Null when no reading falls on it. Its mean
 * power is over the time the readings covered, and its energy that mean over the whole of it: a render whose first reading
 * came a few seconds late is not counted short.
 */
export function energyOf(samples: readonly Sample[], from: number, to: number): { wh: number; avgW: number } | null {
  if (!(to > from)) return null;
  let joules = 0;
  let covered = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const next = samples[i + 1]?.at ?? Math.min(to, s.at + HOLD_MS);
    const a = Math.max(from, s.at);
    const b = Math.min(to, next, s.at + HOLD_MS);
    if (b <= a) continue;
    joules += (s.watts * (b - a)) / 1000;
    covered += b - a;
  }
  if (covered <= 0) return null;
  const avgW = (joules * 1000) / covered;
  return { wh: (avgW * (to - from)) / 3_600_000, avgW };
}

/** One machine's readings, oldest first. */
export class PowerLog {
  private readonly samples: Sample[] = [];

  add(watts: number, at = Date.now()): void {
    const last = this.samples.at(-1);
    if (last && at <= last.at) return;
    this.samples.push({ at, watts });
    if (this.samples.length > KEEP || this.samples[0]!.at < at - KEEP_MS) {
      const cut = this.samples.findIndex((x) => x.at >= at - KEEP_MS);
      this.samples.splice(0, Math.max(cut < 0 ? this.samples.length : cut, this.samples.length - KEEP));
    }
  }

  /** The energy of a stretch (a render's), or null when nothing was read over it. */
  energy(from: number, to: number): { wh: number; avgW: number } | null {
    // the reading just before the stretch, and those in it
    let first = this.samples.findIndex((x) => x.at >= from);
    if (first < 0) first = this.samples.length;
    return energyOf(this.samples.slice(Math.max(0, first - 1)).filter((x) => x.at <= to), from, to);
  }
}
