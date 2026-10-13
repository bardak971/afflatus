import type { Machine } from "./settings";

/**
 * Which machine takes which waiting job, when there are several ComfyUIs (settings.ts `machines`). Pure: the queue hands it
 * the line and what it knows of each machine, and starts what it plans. Down the line in its order, each job goes to the
 * machine that would finish it first: when that machine is free, plus loading the model when it does not hold it, plus the
 * render at that machine's learned pace. So a model stays where it is loaded, and a long job waits a little for a faster
 * machine rather than taking a slow one that is free. One machine takes the line in its order, as the queue always did.
 */

/** A waiting job as the scheduler reads it. */
export interface Waiting {
  id: string;
  /** What it makes: a picture, or a video (a clip, a sound, a finish, a slow motion). */
  makes: "image" | "video";
  /** The machine it was pinned to by hand; null: any. */
  pin: string | null;
  /** The machines that have its files, with its family on (machineScans.ts canRun); left out: any. */
  can?: ReadonlySet<string>;
}

/** A waiting job with what its forecast says (all null when nothing like it was rendered yet). */
export interface Planned extends Waiting {
  /** The model it loads, by name; null for none (a tool). */
  model: string | null;
  /** How long it renders with its model loaded, at the reference pace; null when not known. */
  renderMs: number | null;
  /** What loading its model adds; null when not known. */
  loadMs: number | null;
}

/** A machine as the scheduler reads it: one that may take work now (not paused, not known to be away). */
export interface Lane {
  id: string;
  takes: Machine["takes"];
  /** How long until it is free: 0 when it is; null when it runs a job whose end cannot be told. */
  busyForMs: number | null;
  /** The models it holds, by name. */
  holds: ReadonlySet<string>;
  /** Its learned pace against the others: 1 the same, 2 half as fast. */
  pace: number;
}

/** What loading a model is taken to cost when nothing says: enough that a machine holding it is preferred, no more. */
export const UNKNOWN_LOAD_MS = 20_000;

/**
 * Whether this machine may take this job: it has the job's files, the job's pin, and what the machine takes (Settings:
 * everything, pictures, videos). A job pinned to a machine without its files waits there until they come.
 */
export function takes(machine: Pick<Machine, "id" | "takes">, job: Pick<Waiting, "makes" | "pin" | "can">): boolean {
  if (job.can && !job.can.has(machine.id)) return false;
  if (job.pin && job.pin !== machine.id) return false;
  // a job pinned here runs here, whatever the machine is set to take
  if (job.pin === machine.id) return true;
  return machine.takes === "all" || machine.takes === job.makes;
}

/** Where each job goes and when it would start there, in ms from now (Infinity: after a job whose end cannot be told). A job no machine takes is left out. */
export function plan(lanes: readonly Lane[], jobs: readonly Planned[]): Map<string, { lane: string; startsInMs: number }> {
  const at = new Map(lanes.map((l) => [l.id, l.busyForMs ?? Infinity]));
  const held = new Map(lanes.map((l) => [l.id, l.holds]));
  const out = new Map<string, { lane: string; startsInMs: number }>();
  for (const job of jobs) {
    let best: { lane: Lane; starts: number; ends: number } | null = null;
    for (const lane of lanes) {
      if (!takes(lane, job)) continue;
      const starts = at.get(lane.id)!;
      const cold = Boolean(job.model && !held.get(lane.id)!.has(job.model));
      const ends = starts + (cold ? job.loadMs ?? UNKNOWN_LOAD_MS : 0) + (job.renderMs ?? 0) * lane.pace;
      // the first machine that ends it soonest: ties go to the one named first
      if (!best || ends < best.ends) best = { lane, starts, ends };
    }
    if (!best) continue;
    out.set(job.id, { lane: best.lane.id, startsInMs: best.starts });
    at.set(best.lane.id, best.ends);
    if (job.model) held.set(best.lane.id, new Set([job.model]));
  }
  return out;
}
