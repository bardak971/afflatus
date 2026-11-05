import { useQuery } from "@tanstack/react-query";
import { api, type QueueStatus, type RunningJob } from "../../api";
import { queryKeys } from "../../queryKeys";

/**
 * One part of the queue, for a screen that would otherwise draw itself again at every sampler step (the
 * queue is patched on every progress event): it draws again only when that part changes. The same query
 * as `useQueue`, read through `select`.
 */
/**
 * Every job running now: each machine's, and the queue's own `running` (the first of them, and on a queue of one machine
 * the only place it is said), once each.
 */
export function allRunning(q: QueueStatus): RunningJob[] {
  const out = (q.machines ?? []).flatMap((m) => (m.running ? [m.running] : []));
  if (q.running && !out.some((j) => j.id === q.running!.id)) out.unshift(q.running);
  return out;
}

export const useQueueOf = <T>(select: (q: QueueStatus) => T): T | undefined => useQuery({ queryKey: queryKeys.queue(), queryFn: api.queue, select }).data;
