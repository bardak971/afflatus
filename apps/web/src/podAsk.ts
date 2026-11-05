import type { QueryClient } from "@tanstack/react-query";
import { GRID_ASK_USD, gridAsks, plural, usdFor } from "@afflatus/core";
import { api, type QueueStatus, type RecipeInfo } from "./api";
import { batchMs } from "./advice";
import { ask } from "./Confirm";
import { severalMachines } from "./machines";
import { queryKeys } from "./queryKeys";

/**
 * Asked before many renders of one form are queued where a rented pod may take them (the 2026-11-05 review, M2): a pass or a
 * Vary ×8 on 300 pictures was 2,400 jobs queued without a word, where a 200-cell grid is asked about. The grid's rule (core
 * gridAsks: above GRID_ASK_USD, at a spending cap, or a cost that cannot be told), on `total` renders of the first
 * picture's form, priced on every pod set up at its rate, at worst: a pod stopped now runs them once it is started. Off
 * pods it asks nothing. True: queue them.
 */
export async function askBeforeMany(client: QueryClient, o: { recipe: RecipeInfo; input: Record<string, unknown>; total: number; what: string }): Promise<boolean> {
  const queue = await client.fetchQuery({ queryKey: queryKeys.queue(), queryFn: ({ signal }) => api.queue({ signal }), staleTime: 5_000 });
  const pods = severalMachines(queue as QueueStatus).filter((m) => m.rented);
  if (!pods.length) return true;
  const estimate = (await api.advice(o.recipe.id, o.input).catch(() => ({ estimate: null }))).estimate;
  const each = pods.map((p) => {
    const ms = batchMs(estimate, o.total, p);
    return ms === null || p.rented?.rate == null ? null : usdFor(ms, p.rented.rate);
  });
  const usd = each.some((u) => u === null) ? null : Math.max(...(each as number[]));
  // the spending as it is now: a cap is money
  const spend = (await client.fetchQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), staleTime: 5_000 })).spending;
  const why = gridAsks({ onPod: true, usd }, spend);
  if (!why) return true;
  return ask({
    title: `Queue ${plural(o.total, "render")} where a pod may take them?`,
    text: `${o.what}. ${why}`,
    yes: `Queue ${plural(o.total, "render")}`,
    help: `Asked only with a rented pod set up, above $${GRID_ASK_USD} or near a spending cap. The figure comes from your own render times of the first picture's model on each pod, and its hourly rate.`,
  });
}
