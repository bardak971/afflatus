import type { Job, ProgressUpdate, QueueStatus } from "./api";

/** The pure parts of the live events (live.ts): kept apart so that they can be tested without a page. */

/**
 * A progress event worked into the queue on screen: the running job with the event's figures. Null when
 * that cannot be done (no figures, or a job the queue does not show as running yet): the queue is read.
 */
export function mergeProgress(q: QueueStatus | undefined, data: Partial<ProgressUpdate> | null): QueueStatus | null {
  if (!data || typeof data.id !== "string" || !q?.running || q.running.id !== data.id) return null;
  const { id: _id, ...figures } = data;
  return { ...q, running: { ...q.running, ...figures } };
}

const ENDED = new Set<Job["status"]>(["done", "failed", "cancelled"]);

/**
 * The jobs of the queue's recent list that ended since it was last looked at. `seen` is what had ended
 * then (null: the queue has not been looked at yet, and nothing counts as new).
 */
export function endedSince(seen: ReadonlySet<string> | null, q: QueueStatus): { ended: Job[]; seen: Set<string> } {
  const over = q.recent.filter((j) => ENDED.has(j.status));
  return { ended: seen ? over.filter((j) => !seen.has(j.id)) : [], seen: new Set(over.map((j) => j.id)) };
}

/**
 * `run` at most once every `ms`: the first call runs after what is left of the `ms` since the last run,
 * and the calls that come meanwhile are folded into it. So a burst of events costs one read at once and
 * one at the end, never one per event.
 */
export function throttle(run: () => void, ms: number, now: () => number = Date.now): { (): void; cancel(): void } {
  let last = -Infinity;
  let wait: ReturnType<typeof setTimeout> | null = null;
  const call = () => {
    if (wait) return;
    wait = setTimeout(() => {
      wait = null;
      last = now();
      run();
    }, Math.max(0, ms - (now() - last)));
  };
  call.cancel = () => {
    if (wait) clearTimeout(wait);
    wait = null;
  };
  return call;
}

/** The tag of a job's notification: one per job, so that tabs that both say it show it once. */
export const notifyTag = (jobId: string) => `afflatus:${jobId}`;
