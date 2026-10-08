import { useQuery } from "@tanstack/react-query";
import { api, type QueueStatus } from "../../api";

/**
 * One part of the queue, for a screen that would otherwise draw itself again at every sampler step (the
 * queue is patched on every progress event): it draws again only when that part changes. The same query
 * as `useQueue`, read through `select`.
 */
export const useQueueOf = <T>(select: (q: QueueStatus) => T): T | undefined => useQuery({ queryKey: ["queue"], queryFn: api.queue, select }).data;
