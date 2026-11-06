import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { formModelInput, gridAxes, gridCount, gridCountSaid, sameOpForms, type GridAcross, type GridAxisValues, type GridSetup } from "@afflatus/core";
import { api, type GridAsk, type GridPlanView, type RecipeInfo, type RecipeStatus } from "../api";
import { useRecipes, useSetup } from "../data";
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
  pod: GridPlanView["pod"];
  /** A cell on another family that no machine it may go to can run, and why (the server's word): Queue grid is refused. */
  refused: string | null;
  /** What the Model axis may run across (card #294): the other families' forms of this operation with files on the machines. */
  across: GridAcross | undefined;
  /** Their files by recipe id, as the grid is sent. */
  lists: Record<string, string[]>;
}

/**
 * The other families' forms of this one's operation (core sameOpForms) that have model files on the machines, each with
 * its model input's list: what the Model axis offers beside the form's own files and finds a typed value in (card #294).
 */
function useGridAcross(recipe: RecipeInfo | undefined): { across: GridAcross | undefined; lists: Record<string, string[]> } {
  const recipes = useRecipes();
  const setup = useSetup();
  return useMemo(() => {
    const lists: Record<string, string[]> = {};
    if (!recipe || !recipes.data) return { across: undefined, lists };
    const name = (family: string) => recipes.data.families.find((f) => f.id === family)?.name ?? family;
    const families = sameOpForms(recipe, recipes.data.recipes).flatMap((r) => {
      const model = formModelInput(r);
      const files = model ? setup.data?.recipes.find((x) => x.id === r.id)?.options[model.id] ?? [] : [];
      if (!files.length) return [];
      lists[r.id] = files;
      return [{ recipe: r, name: name(r.family), files }];
    });
    return { across: families.length ? { name: name(recipe.family), families } : undefined, lists };
  }, [recipe, recipes.data, setup.data]);
}

/** The grid of the form as it stands, worked out and planned (see GridPlan). */
export function useGridPlan(recipe: RecipeInfo | undefined, whole: Record<string, unknown>, setup: GridSetup | null | undefined, status: RecipeStatus | undefined, draftId: string | undefined): GridPlan {
  const picked = usePickedMachine(draftId);
  const { across, lists } = useGridAcross(recipe);
  const read = recipe && setup?.axes.some((a) => a.field) ? gridAxes(recipe.inputs, whole, setup, gridOptions(status), across) : { axes: [] };
  const axes = "axes" in read ? read.axes : [];
  const error = "error" in read ? { axis: read.axis, text: read.error } : null;
  // asked again once the typing settles, and when the models the machines hold change (a load less where it is held)
  const key = useSettled(recipe && setup && axes.length && !error ? JSON.stringify(gridAsk(recipe, whole, setup, status, picked?.id, lists)) : "", 500);
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
  return { axes, error, count: gridCount(axes), said: gridCountSaid(axes), ms: got?.ms ?? null, pod: got?.pod ?? null, refused: got?.refused ?? null, across, lists };
}

/** The grid as it is priced and queued: the same ask, so that the cells asked about are the cells sent. */
export const gridAsk = (recipe: RecipeInfo, input: Record<string, unknown>, setup: GridSetup, status: RecipeStatus | undefined, machine: string | undefined, across: Record<string, string[]>): GridAsk => ({
  recipe: recipe.id, input, axes: setup.axes, options: gridOptions(status), ...(Object.keys(across).length ? { across } : {}), machine,
});

/** The lists the form offers (a model's files, a sampler's names) by input id: where a typed value is found. */
export const gridOptions = (status: RecipeStatus | undefined): Record<string, string[]> => status?.options ?? {};
