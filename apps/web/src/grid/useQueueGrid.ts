import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GRID_ASK_USD, gridAsks, plural } from "@afflatus/core";
import { api, ApiError, type Draft, type RecipeInfo, type RecipeStatus } from "../api";
import { ask } from "../Confirm";
import { useQueue } from "../data";
import { useDraftMachine } from "../draftMachine";
import { notFilled, sentForm } from "../form";
import { severalMachines } from "../machines";
import { queryKeys } from "../queryKeys";
import { localId } from "../secureContext";
import { useBanners } from "../store";
import { useGridBoard } from "./boardLayout";
import { gridAsk, type GridPlan } from "./gridPlan";

/**
 * Queue grid (card #21): the form as Render sends it, its axes, sent as one grid of jobs; the board then takes the Stage.
 * The money guard is asked here, last: only on a rented pod, above a few dollars, at a cap, or with a cost that cannot be
 * told (core gridAsks). The grid is priced afresh for it as it is sent, each cell at its own settings, and the spending
 * read afresh too: a figure the card worked out a moment before may be of another form. Elsewhere it is queued at once.
 */
export function useQueueGrid({ recipe, draft, defaults, folder, status, plan }: {
  recipe: RecipeInfo | undefined;
  draft: Draft | null;
  defaults: Record<string, unknown>;
  folder: string | undefined;
  status: RecipeStatus | undefined;
  plan: GridPlan;
}) {
  const client = useQueryClient();
  const queue = useQueue();
  const say = useBanners((b) => b.push);
  return useMutation({
    mutationFn: async () => {
      if (!recipe || !draft?.grid || !plan.count) return null;
      const input = sentForm(recipe, defaults, draft.forms[recipe.id]);
      const missing = notFilled(recipe, input);
      if (missing) throw new ApiError(missing);
      if (plan.error) throw new ApiError(`${"XYZ"[plan.error.axis]}: ${plan.error.text}`);
      // the machine picked for this draft, as Render sends to it; one removed since is forgotten (Auto)
      const asked = useDraftMachine.getState().of[draft.id];
      const machine = asked && severalMachines(queue.data).some((m) => m.id === asked) ? asked : undefined;
      const grid = gridAsk(recipe, input, draft.grid, status, machine);
      const priced = await api.gridPlan(grid);
      if (priced.pod) {
        // the spending as it is now, not as a page left open an hour ago read it: a cap is money
        const spend = (await client.fetchQuery({ queryKey: queryKeys.rentedSpending(), queryFn: ({ signal }) => api.rentedSpending({ signal }), staleTime: 5_000 })).spending;
        const why = gridAsks({ onPod: true, usd: priced.pod.usd }, spend);
        if (why && !(await ask({ title: `Queue ${plural(priced.count, "render")} on the pod?`, text: `${plan.said}. ${why}`, yes: `Queue ${plural(priced.count, "render")}`, help: `Asked only on a rented pod, above $${GRID_ASK_USD} or near a spending cap. The figure comes from your own render times on that pod, each cell at its own settings, and its hourly rate.` }))) return null;
      }
      // one key per click: a request sent again on its way queues nothing more
      const queued = await api.queueGrid({ ...grid, look: draft.look, draft: draft.id, folder, key: localId() });
      useGridBoard.getState().show(draft.id, queued.id);
      return queued;
    },
    onSuccess: (queued) => {
      if (!queued) return;
      void client.invalidateQueries({ queryKey: queryKeys.grids.all() });
      say({ id: `grid:${queued.id}`, tone: "good", title: `Grid queued · ${plural(queued.count, "render")}`, text: "It lands on the Stage as one board.", href: "/queue", go: "Open the Queue" });
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.queue() }),
  });
}
