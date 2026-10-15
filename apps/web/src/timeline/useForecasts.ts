import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type Clip, type MachineState, type RecipeInfo } from "../api";
import { settingsOnly } from "../form";
import { timeOn } from "../machines";
import { queryKeys } from "../queryKeys";

/**
 * About how long each clip takes to render, in ms: the server's forecast (learned from past renders, the same as the
 * timeline card's and the command bar's) of the whole form a render of it would send, planned as its render will be (the
 * clip named: the timeline's frame, the clip it carries on from). Its texts are left out, so typing asks nothing. On a
 * `machine` when one is picked: that machine's own figure (timeOn); else Auto's. Null for a clip with nothing like it
 * rendered yet, or while its changed form is asked, and on a machine that cannot render it (`can`: its files not there).
 */
export function useForecasts(clips: Clip[], recipes: RecipeInfo[], formOf: (c: Clip) => Record<string, unknown> | null): {
  takesOn(c: Clip, machine?: MachineState | null): number | null;
  /** Whether a machine can render the clip, as the server's plan says (unknown: it can). */
  canOn(c: Clip, machine: MachineState): boolean;
} {
  const forms = useMemo(() => {
    const out = new Map<string, { recipe: string; input: Record<string, unknown>; clip: string }>();
    for (const c of clips) {
      const recipe = c.kind === "video" ? recipes.find((r) => r.id === c.recipe) : undefined;
      const input = recipe ? formOf(c) : null;
      if (recipe && input) out.set(c.id, { recipe: recipe.id, input: settingsOnly(recipe, input), clip: c.id });
    }
    return out;
  }, [clips, recipes, formOf]);
  const asked = useMemo(() => [...forms.values()], [forms]);
  const got = useQuery({
    queryKey: queryKeys.forecasts(asked),
    // the answer keeps the forms it is for: while a changed form is asked, the others keep their figure
    queryFn: async ({ signal }) => {
      const { ms, on, can } = await api.forecasts(asked, { signal });
      return new Map(asked.map((f, i) => [keyOf(f), { ms: ms[i] ?? null, on: on?.[i] ?? null, can: can?.[i] ?? null }]));
    },
    enabled: asked.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const known = got.data;
  const of = (c: Clip) => {
    const f = forms.get(c.id);
    return f && known ? known.get(keyOf(f)) : undefined;
  };
  const canOn = (c: Clip, machine: MachineState) => !of(c)?.can || of(c)!.can!.includes(machine.id);
  return {
    takesOn: (c, machine) => {
      const one = of(c);
      if (!one || (machine && !canOn(c, machine))) return null;
      return timeOn(one.ms, one.on, machine);
    },
    canOn,
  };
}

const keyOf = (f: { recipe: string; input: Record<string, unknown>; clip: string }) => `${f.recipe}\n${f.clip}\n${JSON.stringify(f.input)}`;
