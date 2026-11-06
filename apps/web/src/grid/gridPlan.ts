import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { gridAxes, gridCount, gridCountSaid, type GridAxisValues, type GridSetup } from "@afflatus/core";
import { api, type GridAsk, type RecipeInfo, type RecipeStatus } from "../api";
import { useQueueOf } from "../screens/studio/queueOf";
import { usePickedMachine } from "../GenerateOn";
import { useSettled } from "../hooks";
import { queryKeys } from "../queryKeys";

/**
 * What a grid will take before it is queued (card #21), said on its card and its button always: the count, the time from
 * the user's own renders, and on a rented pod the money at its rate. The time and the money are the server's (POST
 * /api/grids/plan), each cell priced at its own steps, size, hires and model, as MCP's render_grid is held to them: worked
 * out here from the base form, a size or hires axis was priced at the base render and the ask stayed silent (the
 * 2026-11-05 review, M4). Read here once for the card, the button and the guard.
 */
export interface GridPlan {
  /** The axes in use, worked out; empty when none has a field and values yet. */
  axes: GridAxisValues[];
  /** The first axis that cannot be read and why (its index, X = 0). */
  error: { axis: number; text: string } | null;
  count: number;
  /** "3 × 4 × 2 = 24 renders". */
  said: string;
  /** All of it, on the machine it goes to (on Auto, shared as the queue shares it); null without a forecast. */
  ms: number | null;
  /**
   * On a rented pod it may go to: the time there and the money, at worst (all of it on the dearest); null off pods. `most`
   * counts each unsure forecast half again, as an MCP token is held to: what the ask before queuing is about.
   */
  pod: { ms: number | null; usd: number | null; most: number | null } | null;
}

/** The grid of the form as it stands, worked out and planned (see GridPlan). */
export function useGridPlan(recipe: RecipeInfo | undefined, whole: Record<string, unknown>, setup: GridSetup | null | undefined, status: RecipeStatus | undefined, draftId: string | undefined): GridPlan {
  const picked = usePickedMachine(draftId);
  const read = recipe && setup?.axes.some((a) => a.field) ? gridAxes(recipe.inputs, whole, setup, gridOptions(status)) : { axes: [] };
  const axes = "axes" in read ? read.axes : [];
  const error = "error" in read ? { axis: read.axis, text: read.error } : null;
  // asked again once the typing settles, and when the models the machines hold change (a load less where it is held)
  const key = useSettled(recipe && setup && axes.length && !error ? JSON.stringify(gridAsk(recipe, whole, setup, status, picked?.id)) : "", 500);
  const held = useQueueOf((q) => [q.model, ...(q.machines ?? []).map((m) => m.model)].join("|")) ?? null;
  const plan = useQuery({
    queryKey: queryKeys.grids.plan(key, held),
    queryFn: ({ signal }) => api.gridPlan(JSON.parse(key) as GridAsk, { signal }),
    enabled: Boolean(key),
    staleTime: 30_000,
    // the last figure stays while the next is worked out, rather than the card's money line coming and going
    placeholderData: keepPreviousData,
  });
  const got = key ? plan.data : undefined;
  return { axes, error, count: gridCount(axes), said: gridCountSaid(axes), ms: got?.ms ?? null, pod: got?.pod ?? null };
}

/** The grid as it is priced and queued: the same ask, so that the cells asked about are the cells sent. */
export const gridAsk = (recipe: RecipeInfo, input: Record<string, unknown>, setup: GridSetup, status: RecipeStatus | undefined, machine: string | undefined): GridAsk => ({
  recipe: recipe.id, input, axes: setup.axes, options: gridOptions(status), machine,
});

/** The lists the form offers (a model's files, a sampler's names) by input id: where a typed value is found. */
export const gridOptions = (status: RecipeStatus | undefined): Record<string, string[]> => status?.options ?? {};
