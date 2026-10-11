import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type QueueStatus } from "../../api";
import { ask } from "../../Confirm";
import { pinnedFailures } from "./failures";
import { byModel, groupingSaves } from "./order";
import { plural } from "../../format";
import { queryKeys } from "../../queryKeys";
import { useSayFailed } from "../../sayFailed";

// what the command bar shows next to "Group the queue by model"
export { groupingSaves };

/**
 * The queue's bulk actions, one request each: cancel every waiting job, retry or dismiss failures, group the queue by
 * model. Plain functions of the query client, so that the Queue page and the command bar call the same ones; the
 * ones that cannot be undone ask first (`ask: false` when the caller asked already). `useQueueBulk` binds them, with
 * what fails said in a banner.
 */

const queueOf = (client: QueryClient) => client.getQueryData<QueueStatus>(queryKeys.queue());

/** Every waiting job cancelled, after asking; `ids`: only those (what the screen showed when it was asked). How many were; null when the question was declined or nothing waits. */
async function cancelAllWaiting(client: QueryClient, opts: { ids?: string[]; ask?: boolean } = {}): Promise<number | null> {
  const n = opts.ids?.length ?? queueOf(client)?.waiting.length ?? 0;
  if (!n) return null;
  if (opts.ask !== false && !(await ask({ title: `Cancel ${plural(n, "waiting job")}?`, text: "The running render goes on. They go to the history as cancelled, where Requeue brings one back.", yes: n === 1 ? "Cancel it" : `Cancel all ${n}` }))) return null;
  const { cancelled } = await api.cancelWaiting(opts.ids);
  void client.invalidateQueries({ queryKey: queryKeys.queue() });
  void client.invalidateQueries({ queryKey: queryKeys.history.all() });
  return cancelled;
}

/** Failed jobs queued again, oldest first, and taken off the history once queued. `ids`: newest first as the history lists them; when left out, the failures since the last render done. */
async function retryAllFailed(client: QueryClient, ids?: string[]): Promise<{ ids: string[]; failed: number }> {
  const which = ids ?? (await recentFailures()).map((j) => j.id);
  if (!which.length) return { ids: [], failed: 0 };
  const r = await api.retryJobs([...which].reverse(), true);
  void client.invalidateQueries({ queryKey: queryKeys.queue() });
  void client.invalidateQueries({ queryKey: queryKeys.history.all() });
  return r;
}

/** Failed jobs taken off the history (what they made, nothing: they made nothing). With `ask`, asked first; when `ids` is left out, every failure in the history. How many went; null when declined. */
async function dismissAllFailed(client: QueryClient, opts: { ids?: string[]; ask?: boolean } = {}): Promise<number | null> {
  const which = opts.ids ?? (await allFailures()).map((j) => j.id);
  if (!which.length) return null;
  if (opts.ask && !(await ask({ title: `Dismiss ${plural(which.length, "failed job")}?`, text: "They leave the history. Nothing is deleted from the library.", yes: "Dismiss them" }))) return null;
  const { dismissed } = await api.dismissJobs(which);
  void client.invalidateQueries({ queryKey: queryKeys.history.all() });
  return dismissed;
}

/** The waiting jobs grouped by model, the running job's model first (order.ts byModel). False when grouping saves no load. */
async function groupQueueByModel(client: QueryClient): Promise<boolean> {
  const q: QueueStatus = queueOf(client) ?? (await api.queue());
  if (!groupingSaves(q.waiting, q.running)) return false;
  client.setQueryData(queryKeys.queue(), await api.queueOrder(byModel(q.waiting, q.running)));
  return true;
}

/** The failures the history pins (since the last render done), newest first, read from the server: for a caller without the history on screen. */
async function recentFailures() {
  return pinnedFailures((await api.jobs({ limit: 200 })).items).pinned;
}

/** Every failure in the history (up to 500), newest first. */
async function allFailures() {
  const first = await api.jobs({ status: "failed", limit: 200 });
  const rest = first.more && first.next ? await api.jobs({ status: "failed", after: first.next, limit: 200 }) : null;
  return [...first.items, ...(rest?.items ?? [])].slice(0, 500);
}

/** The bulk actions bound to this page's query client, what fails said in a banner (as the queue's other actions do). */
export function useQueueBulk() {
  const client = useQueryClient();
  const sayFailed = useSayFailed({ id: "queue", href: "/queue", go: "Open queue" });
  const failed = (title: string) => (err: unknown) => {
    sayFailed(title)(err);
    return null;
  };
  return {
    cancelAllWaiting: (opts?: { ids?: string[]; ask?: boolean }) => cancelAllWaiting(client, opts).catch(failed("Could not cancel the waiting jobs")),
    retryAllFailed: (ids?: string[]) =>
      retryAllFailed(client, ids)
        .then((r) => {
          // a job whose workflow was deleted since cannot be queued again: said, the others went
          if (r.failed) failed(`${r.failed} could not be queued again`)(new Error("Their workflow or its settings are gone; they stay in the history."));
          return r;
        })
        .catch(failed("Could not queue them again")),
    dismissAllFailed: (opts?: { ids?: string[]; ask?: boolean }) => dismissAllFailed(client, opts).catch(failed("Could not dismiss them")),
    groupQueueByModel: () => groupQueueByModel(client).catch(failed("Could not reorder the queue")),
  };
}
