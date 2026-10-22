import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
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
  // worked out again at each key typed in a clip's form (formOf is new then), but from what was worked out for the forms
  // that did not change: each clip's settings kept with its whole form (formOf answers the same object while the clip's
  // form is the same), and the list asked kept while each form in it says the same (typing a prompt changes no setting)
  const kept = useRef<{ asked: Asked[]; key: string } | null>(null);
  const { forms, asked, key } = useMemo(() => {
    const forms = new Map<string, Asked>();
    const was = new Map(kept.current?.asked.map((f) => [f.clip, f]));
    for (const c of clips) {
      const recipe = c.kind === "video" ? recipes.find((r) => r.id === c.recipe) : undefined;
      const input = recipe ? formOf(c) : null;
      if (!recipe || !input) continue;
      const before = was.get(c.id);
      const now = { recipe: recipe.id, input: settingsOf(recipe, input), clip: c.id };
      forms.set(c.id, before && before.recipe === now.recipe && (before.input === now.input || keyOf(before) === keyOf(now)) ? before : now);
    }
    const asked = [...forms.values()];
    const same = kept.current && asked.length === kept.current.asked.length && asked.every((f, i) => f === kept.current!.asked[i]);
    // the query's key is the forms said as one string, made once for each list: as the list itself, its 150 forms were
    // hashed again at every draw of the editor
    if (!same) kept.current = { asked, key: asked.map(keyOf).join("\n\n") };
    return { forms, asked: kept.current!.asked, key: kept.current!.key };
  }, [clips, recipes, formOf]);
  const got = useQuery({
    queryKey: queryKeys.forecasts(key),
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

type Asked = { recipe: string; input: Record<string, unknown>; clip: string };
/** A form said as a string, made once for each form: each clip's figure is looked up by it, several times a draw. */
const keys = new WeakMap<Asked, string>();
function keyOf(f: Asked): string {
  let k = keys.get(f);
  if (k === undefined) keys.set(f, (k = `${f.recipe}\n${f.clip}\n${JSON.stringify(f.input)}`));
  return k;
}

/** A whole form's settings (settingsOnly), worked out once for each whole form. */
const settingsSeen = new WeakMap<Record<string, unknown>, Record<string, unknown>>();
function settingsOf(recipe: RecipeInfo, input: Record<string, unknown>): Record<string, unknown> {
  let v = settingsSeen.get(input);
  if (!v) settingsSeen.set(input, (v = settingsOnly(recipe, input)));
  return v;
}
