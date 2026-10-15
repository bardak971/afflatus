import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Advice, type MachineState, type RecipeInfo } from "./api";
import { aboutMs } from "./format";
import { timeOn } from "./machines";
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
  // the models the ComfyUIs hold, alone: the form is not drawn again at every sampler step (each machine is told whether it
  // holds the form's model itself)
  const held = useQueueOf((q) => [q.model, ...(q.machines ?? []).map((m) => m.model)].join("|")) ?? null;
  return useQuery({
    queryKey: queryKeys.advice.form(recipe?.id, key, held),
    // a prompt the form must have is written as "x": what it says changes nothing of the time
    queryFn: () => api.advice(recipe!.id, { ...Object.fromEntries(recipe!.inputs.filter((i) => i.type === "prompt" && !i.optional).map((i) => [i.id, "x"])), ...(JSON.parse(key) as Record<string, unknown>) }),
    enabled: Boolean(recipe && key),
    staleTime: 60_000,
  });
}

/**
 * What `count` renders of a form take in all (ms). On `machine` when one is picked: its own render, its model loading once
 * before the first. On Auto with several machines: shared between the ones Auto may give it to (`auto`) as the queue shares
 * a batch, each render to the machine that ends it soonest, each loading the model once: two machines take four renders in
 * about the time one takes two. Null without a forecast.
 */
export function batchMs(advice: Pick<Advice, "ms" | "loadMs" | "on" | "loadOn" | "auto"> | null | undefined, count: number, machine: Pick<MachineState, "id" | "pace"> | null = null): number | null {
  if (!advice) return null;
  const n = Math.max(1, count);
  if (machine) {
    const own = advice.on?.[machine.id] !== undefined;
    const load = own ? advice.loadOn?.[machine.id] ?? 0 : advice.loadMs;
    return (timeOn(advice.ms, advice.on, machine)! - load) * n + load;
  }
  const lanes = (advice.auto ?? []).flatMap((id) => (advice.on?.[id] !== undefined ? [{ ms: advice.on[id]!, loadMs: advice.loadOn?.[id] ?? 0 }] : []));
  if (lanes.length < 2) return (advice.ms - advice.loadMs) * n + advice.loadMs;
  const ends = lanes.map(() => 0);
  const loaded = lanes.map(() => false);
  for (let k = 0; k < n; k++) {
    // the machine that ends this render soonest, its model loaded for its first
    const end = lanes.map((l, i) => ends[i]! + (loaded[i] ? l.ms - l.loadMs : l.ms));
    const i = end.indexOf(Math.min(...end));
    ends[i] = end[i]!;
    loaded[i] = true;
  }
  return Math.max(...ends);
}

/** What `count` renders of a form take in all, said as the Generate button says it (batchMs: on Auto, shared between its machines). */
export const batchAbout = (advice: Parameters<typeof batchMs>[0], count: number): string => {
  const ms = batchMs(advice, count);
  return ms === null ? "" : aboutMs(ms);
};
