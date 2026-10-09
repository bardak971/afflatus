import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type Clip, type RecipeInfo } from "../api";
import { settingsOnly } from "../form";

/**
 * About how long each clip takes to render, in ms: the server's forecast (learned from this machine's past renders, the
 * same as the timeline card's and the command bar's) of the whole form a render of it would send. Its texts are left
 * out, so typing asks nothing. Null for a clip with nothing like it rendered yet, or while its changed form is asked.
 */
export function useForecasts(clips: Clip[], recipes: RecipeInfo[], formOf: (c: Clip) => Record<string, unknown> | null): (c: Clip) => number | null {
  const forms = useMemo(() => {
    const out = new Map<string, { recipe: string; input: Record<string, unknown> }>();
    for (const c of clips) {
      const recipe = c.kind === "video" ? recipes.find((r) => r.id === c.recipe) : undefined;
      const input = recipe ? formOf(c) : null;
      if (recipe && input) out.set(c.id, { recipe: recipe.id, input: settingsOnly(recipe, input) });
    }
    return out;
  }, [clips, recipes, formOf]);
  // each form asked once, however many clips share it
  const asked = useMemo(() => [...new Map([...forms.values()].map((f) => [keyOf(f), f])).values()], [forms]);
  const got = useQuery({
    queryKey: ["forecasts", asked],
    // the answer keeps the forms it is for: while a changed form is asked, the others keep their figure
    queryFn: async ({ signal }) => {
      const { ms } = await api.forecasts(asked, { signal });
      return new Map(asked.map((f, i) => [keyOf(f), ms[i] ?? null]));
    },
    enabled: asked.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const known = got.data;
  return (c) => {
    const f = forms.get(c.id);
    return f && known ? known.get(keyOf(f)) ?? null : null;
  };
}

const keyOf = (f: { recipe: string; input: Record<string, unknown> }) => `${f.recipe}\n${JSON.stringify(f.input)}`;
