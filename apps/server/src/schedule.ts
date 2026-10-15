import type { Machine } from "./settings";

/**
 * Which machine takes which waiting job, when there are several ComfyUIs (settings.ts `machines`). Pure: the queue hands it
 * the line and what it knows of each machine, and starts what it plans. Down the line in its order, each job goes to the
 * machine that would finish it first: when that machine is free, plus loading the model when it does not hold it, plus the
 * render as that machine's own renders of the model say it (else at its learned pace). So a model stays where it is
 * loaded, and a long job waits a little for a faster machine rather than taking a slow one that is free. One machine takes
 * the line in its order, as the queue always did.
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
  /** Of those, the rented pods it can run on once its files come there, with how long until they are there (ms). */
  fetchMs?: ReadonlyMap<string, number>;
}

/** A waiting job with what its forecast says (all null when nothing like it was rendered yet). */
export interface Planned extends Waiting {
  /** The model it loads, by name; null for none (a tool). */
  model: string | null;
  /** How long it renders with its model loaded, at the reference pace; null when not known. */
  renderMs: number | null;
  /** What loading its model adds; null when not known. */
  loadMs: number | null;
  /** How long it renders on each machine, from that machine's own renders (or the others' at its pace): read before `renderMs` at the machine's pace. */
  renderOn?: ReadonlyMap<string, number>;
  /** What loading its model adds on each machine, as `renderOn`: a pod's disk is not this computer's. */
  loadOn?: ReadonlyMap<string, number>;
  /** It runs on the GPU with no model of its own (a finish, a RIFE slow motion): its machine holds no model after it. */
  frees?: boolean;
  /** The job it waits for (a clip carried on from the one before): it starts once that one ends, wherever that one runs. */
  after?: string;
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

/**
 * Where each job goes, when it would start there and when it would end, in ms from now (Infinity: after a job whose end
 * cannot be told). A job no machine takes is left out. A job like nothing rendered yet (no render time, on no machine) is
 * placed where it starts soonest, and the machine it goes to is busy for a time that cannot be told after it: the jobs
 * behind it there say no time rather than one that counts it as nothing.
 */
export function plan(lanes: readonly Lane[], jobs: readonly Planned[]): Map<string, { lane: string; startsInMs: number; endsInMs: number }> {
  const at = new Map(lanes.map((l) => [l.id, l.busyForMs ?? Infinity]));
  const held = new Map(lanes.map((l) => [l.id, l.holds]));
  const out = new Map<string, { lane: string; startsInMs: number; endsInMs: number }>();
  for (const job of jobs) {
    let best: { lane: Lane; starts: number; ends: number; cold: boolean; known: boolean } | null = null;
    // a job that waits for another starts once that one ends (one the plan does not place is not waited for here)
    const ready = job.after ? out.get(job.after)?.endsInMs ?? 0 : 0;
    for (const lane of lanes) {
      if (!takes(lane, job)) continue;
      // on a pod still getting its files, it starts once they are there (they come while the pod renders what is before it)
      const starts = Math.max(at.get(lane.id)!, job.fetchMs?.get(lane.id) ?? 0, ready);
      const cold = Boolean(job.model && !held.get(lane.id)!.has(job.model));
      const render = job.renderOn?.get(lane.id) ?? (job.renderMs === null ? null : job.renderMs * lane.pace);
      // an unknown render is weighed as nothing to choose its machine, and ends at a time that cannot be told
      const ends = starts + (cold ? job.loadOn?.get(lane.id) ?? job.loadMs ?? UNKNOWN_LOAD_MS : 0) + (render ?? 0);
      // the first machine that ends it soonest: ties go to one that holds its model (a load its renders did not show yet
      // still reads the model again), then to the one named first
      if (!best || ends < best.ends || (ends === best.ends && best.cold && !cold)) best = { lane, starts, ends, cold, known: render !== null };
    }
    if (!best) continue;
    const ends = best.known ? best.ends : Infinity;
    out.set(job.id, { lane: best.lane.id, startsInMs: best.starts, endsInMs: ends });
    at.set(best.lane.id, ends);
    if (job.model) held.set(best.lane.id, new Set([job.model]));
    else if (job.frees) held.set(best.lane.id, new Set());
  }
  return out;
}

/**
 * How long until every one of these jobs is done, through the machines' lanes as the queue would share them (plan): two
 * free machines take a line of renders in about half the time one does. Null when one of them cannot be placed, or ends at
 * a time that cannot be told.
 */
export function planTotal(lanes: readonly Lane[], jobs: readonly Planned[]): number | null {
  const got = plan(lanes, jobs);
  if (got.size < jobs.length) return null;
  const end = Math.max(0, ...[...got.values()].map((p) => p.endsInMs));
  return Number.isFinite(end) ? end : null;
}
