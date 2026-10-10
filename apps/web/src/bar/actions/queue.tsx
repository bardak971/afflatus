import { ArrowUpToLine, Copy, ListOrdered, PenLine, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "../../api";
import { moved } from "../../screens/queue/order";
import { lighter, memoryThatRanOut, shorterStretch } from "../../screens/queue/retry";
import { copyText } from "../../secureContext";
import type { Item } from "../items";
import type { Action } from "../useActions";
import type { BarCtx } from "./ctx";
import { queryKeys } from "../../queryKeys";

/** A job of the queue: what its row and menu on the Queue page do. */
export function jobActions(x: BarCtx, it: Item): Action[] {
  const { client, failed, good } = x;
  const { job, state } = it.job!;
  const toQueue: Action = { label: "Open queue", icon: <ListOrdered size={14} />, run: () => x.go("/queue") };
  const toDraft: Action[] = job.draftId ? [{ label: "Open its draft", icon: <PenLine size={14} />, run: () => x.openDraft(job.draftId!) }] : [];
  if (state === "running") {
    const seed = (job as { seed?: number | null }).seed ?? null;
    return [
      toQueue,
      { label: "Stop this render", icon: <X size={14} />, danger: true, note: "nothing is added", run: () => api.cancel(job.id).then(() => client.invalidateQueries({ queryKey: queryKeys.queue() }), failed("Could not stop it")) },
      ...(seed !== null ? [{ label: "Copy the seed", icon: <Copy size={14} />, note: String(seed), stay: true, run: () => copyText(String(seed)).then(() => x.onCopied(`the seed ${seed}`), () => x.onCopied("")) }] : []),
      ...toDraft,
    ];
  }
  if (state === "waiting") {
    const ids = x.queue?.waiting.map((w) => w.id) ?? [];
    return [
      toQueue,
      { label: "Run next", icon: <ArrowUpToLine size={14} />, disabled: ids[0] === job.id, run: () => api.queueOrder(moved(ids, job.id, 0)).then((q) => client.setQueryData(queryKeys.queue(), q), failed("Could not move it")) },
      { label: "Cancel this one", icon: <X size={14} />, danger: true, run: () => api.cancel(job.id).then(() => client.invalidateQueries({ queryKey: queryKeys.queue() }), failed("Could not cancel it")) },
      ...toDraft,
    ];
  }
  // a failure: run again (changed, or not) and taken out of the list once queued, as its row on the Queue page does
  const recipe = x.recipes.find((r) => r.id === job.recipe);
  const memory = memoryThatRanOut(job.error);
  const fix = memory ? lighter(recipe, job.input) : null;
  const stretch = memory ? shorterStretch(recipe, job.input) : null;
  const retry = (input?: Record<string, unknown>) => x.jobs.again.mutate({ id: job.id, input }, { onSuccess: () => { x.jobs.dismiss.mutate(job.id); good(`${job.label} queued again`, undefined, "/queue", "Open queue"); } });
  return [
    toQueue,
    { label: "Retry unchanged", icon: <RotateCcw size={14} />, note: "the same job again", run: () => retry() },
    ...(stretch ? [{ label: stretch.label, icon: <RotateCcw size={14} />, note: "less memory", run: () => retry(stretch.change) }] : []),
    ...(fix ? [{ label: fix.label, icon: <RotateCcw size={14} />, note: "less memory", run: () => retry(fix.change) }] : []),
    ...toDraft,
    { label: "Dismiss", icon: <Trash2 size={14} />, danger: true, note: "out of the history", run: () => x.jobs.dismiss.mutate(job.id) },
  ];
}
