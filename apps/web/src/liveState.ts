import type { Job, ProgressUpdate, QueueStatus } from "./api";

/** The pure parts of the live events (live.ts): kept apart so that they can be tested without a page. */

/**
 * A progress event worked into the queue on screen: each running job with its figures (the event carries every running
 * job's in `all`, the first one's at its top), the one the screens that show one read and each machine's. Null when that
 * cannot be done (no figures, or a job the queue does not show as running yet): the queue is read.
 */
export function mergeProgress(q: QueueStatus | undefined, data: (Partial<ProgressUpdate> & { all?: Array<Partial<ProgressUpdate>> }) | null): QueueStatus | null {
  if (!data || !q) return null;
  const updates = (data.all ?? [data]).filter((u): u is Partial<ProgressUpdate> & { id: string } => typeof u.id === "string");
  const figuresOf = (id: string) => {
    const u = updates.find((x) => x.id === id);
    if (!u) return null;
    const { id: _id, ...figures } = u;
    return figures;
  };
  const top = q.running ? figuresOf(q.running.id) : null;
  const machines = (q.machines ?? []).map((m) => {
    const f = m.running ? figuresOf(m.running.id) : null;
    return f ? { ...m, running: { ...m.running!, ...f } } : m;
  });
  if (!top && !machines.some((m, i) => m !== q.machines?.[i])) return null;
  return { ...q, running: top && q.running ? { ...q.running, ...top } : q.running, machines };
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

/** The tag of a notice's notification: one per notice, so that tabs that both say it show it once. */
export const notifyTag = (said: string) => `afflatus:${said}`;

/**
 * Whether a hello is a reconnect, after which anything may have changed and everything is read again. The first hello is the
 * page opening, everything just read; unless another tab held the connection meanwhile (`followed`: it answered this one or
 * passed an event on), whose events this page heard. Waiting for the connection is not following: a page opened from another
 * Afflatus page waits for the old one to let it go, and taking that wait for a reconnect read its whole first load twice.
 */
export function greetings(): { followed(): void; hello(): boolean } {
  let greeted = false;
  return {
    followed: () => {
      greeted = true;
    },
    hello: () => {
      const again = greeted;
      greeted = true;
      return again;
    },
  };
}
