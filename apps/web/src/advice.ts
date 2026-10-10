import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Advice, type RecipeInfo } from "./api";
import { aboutMs } from "./format";
import { settingsOnly } from "./form";
import { useSettled } from "./hooks";
import { useQueueOf } from "./screens/studio/queueOf";
import { queryKeys } from "./queryKeys";

/**
 * What a form will take, the server's forecast from this machine's renders (POST /api/advice). The form's Output
 * line and the Generate button under it read this one query: one figure, said twice. It is asked again only when
 * a setting changes (not while text is typed), once the settings have settled, so a slider dragged across the
 * form is one question, not one per pixel; and when ComfyUI loads another model, since loading it is part of it.
 */
export function useAdvice(recipe: RecipeInfo | undefined, values: Record<string, unknown>) {
  const key = useSettled(useMemo(() => (recipe ? JSON.stringify(settingsOnly(recipe, values)) : ""), [recipe, values]), 500);
  // the model ComfyUI holds, alone: the form is not drawn again at every sampler step
  const held = useQueueOf((q) => q.model) ?? null;
  return useQuery({
    queryKey: queryKeys.advice.form(recipe?.id, key, held),
    // a prompt the form must have is written as "x": what it says changes nothing of the time
    queryFn: () => api.advice(recipe!.id, { ...Object.fromEntries(recipe!.inputs.filter((i) => i.type === "prompt" && !i.optional).map((i) => [i.id, "x"])), ...(JSON.parse(key) as Record<string, unknown>) }),
    enabled: Boolean(recipe && key),
    staleTime: 60_000,
  });
}

/** What `count` renders of a form take in all, said as the Generate button says it: the model loads once, before the first. */
export const batchAbout = (advice: Pick<Advice, "ms" | "loadMs"> | null | undefined, count: number): string =>
  advice ? aboutMs((advice.ms - advice.loadMs) * count + advice.loadMs) : "";
