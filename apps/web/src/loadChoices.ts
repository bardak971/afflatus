import { useQueries, useQueryClient } from "@tanstack/react-query";
import { modelName } from "@afflatus/core";
import { api, type RecipeInfo } from "./api";
import { useDrafts, useQueue, useRecipes } from "./data";
import { machineLabel, severalMachines } from "./machines";
import { failedBanner } from "./sayFailed";
import { useBanners } from "./store";
import { queryKeys } from "./queryKeys";

type Look = Parameters<typeof api.warm>[2];
/** A form on screen, as the status bar's strip holds it (ModelLoad.tsx). */
export interface LoadForm {
  recipe: RecipeInfo;
  input: Record<string, unknown>;
  look: Look;
}

/** A model that can be loaded ahead, from the form on screen or a recent draft. */
export interface LoadChoice {
  key: string;
  /** The model it loads: its family and its file ("MiniMax H3 · DasiwaMinimaxH3_…"), else the operation's name. */
  label: string;
  /** Where it comes from: "this form", or the draft's name. */
  note?: string;
  ofForm: boolean;
  /** Its family's name, and the file it loads (by name) or, when its form picks none, its operation's usual one. */
  family: string;
  file: string;
}

/** How many recent drafts' models are offered. */
const RECENT = 6;

/**
 * What the model menus offer to load ahead (the strip's, a machine chip's "Load on"): the model of the form on screen
 * first, then the models of the recent drafts, each once, named by the model (a form's name did not say what is loaded,
 * and two forms on one checkpoint are one load). `load` queues the load, on the machine named or wherever the queue
 * renders it first; `lacksOn` says a machine has not the form's files (a draft's are not known before it is read).
 */
export function useLoadChoices(form?: LoadForm | null) {
  const drafts = useDrafts(true);
  const recipes = useRecipes();
  const queue = useQueue();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const several = severalMachines(queue.data);
  const setups = useQueries({ queries: several.map((m) => ({ queryKey: queryKeys.setup(m.id), queryFn: ({ signal }: { signal: AbortSignal }) => api.setup({ signal }, m.id), staleTime: 60_000, enabled: Boolean(form) })) });

  const familyOf = (recipe: string) => {
    const r = recipes.data?.recipes.find((x) => x.id === recipe);
    return { r, family: recipes.data?.families.find((f) => f.id === r?.family)?.name };
  };
  const fileOf = (recipe: string, model: string | null | undefined) => model ?? `${familyOf(recipe).r?.title ?? recipe} · its usual model`;
  const labelOf = (recipe: string, model: string | null | undefined) => {
    const { r, family } = familyOf(recipe);
    if (model) return family ? `${family} · ${model}` : model;
    return r ? (family && !r.title.startsWith(family) ? `${family} · ${r.title}` : r.title) : recipe;
  };
  // the form's own values, less what it no longer has; its model by name, as a draft's is
  const whole = form ? Object.fromEntries(Object.entries(form.input).filter(([k, v]) => form.recipe.inputs.some((i) => i.id === k) && v !== undefined)) : {};
  const picked = form?.recipe.inputs.find((i) => i.type === "model");
  const formFile = picked && typeof whole[picked.id] === "string" ? (whole[picked.id] as string) : "";
  const formModel = formFile ? modelName(formFile) : null;
  const keyOf = (recipe: string, model: string | null | undefined) => (model ? `model:${model}` : `recipe:${recipe}`);

  const choices: Array<LoadChoice & { draft?: string }> = [];
  const seen = new Set<string>();
  if (form) {
    const key = keyOf(form.recipe.id, formModel);
    seen.add(key);
    choices.push({ key, label: labelOf(form.recipe.id, formModel), note: "this form", ofForm: true, family: familyOf(form.recipe.id).family ?? "", file: fileOf(form.recipe.id, formModel) });
  }
  for (const d of drafts.data?.items ?? []) {
    if (choices.length >= RECENT + (form ? 1 : 0)) break;
    const key = keyOf(d.recipe, d.model);
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ key, label: labelOf(d.recipe, d.model), note: d.name || d.title || undefined, ofForm: false, draft: d.id, family: familyOf(d.recipe).family ?? "", file: fileOf(d.recipe, d.model) });
  }

  /** Whether a machine has not the form's files: its recipe not ready there, or the model the form picks not listed there. */
  const lacksOn = (machine: string) => {
    if (!form) return false;
    const i = several.findIndex((m) => m.id === machine);
    const status = setups[i]?.data?.recipes.find((r) => r.id === form.recipe.id);
    if (!status) return false;
    return !status.ready || form.recipe.inputs.some((x) => x.type === "model" && typeof whole[x.id] === "string" && whole[x.id] && status.options[x.id] && !status.options[x.id]!.includes(whole[x.id] as string));
  };

  const load = async (choice: LoadChoice & { draft?: string }, machine?: string) => {
    const where = machine ? several.find((m) => m.id === machine) : undefined;
    const on = where ? ` on ${machineLabel(where)}` : "";
    try {
      if (choice.ofForm && form) await api.warm(form.recipe.id, whole, form.look, machine);
      else if (choice.draft) {
        const d = await api.draft(choice.draft);
        await api.warm(d.recipe, d.forms[d.recipe] ?? {}, d.look, machine);
      }
      say({ id: `load:${Date.now()}`, tone: "good", title: `Loading ${choice.label}${on}`, text: "Queued: the next render with it starts at once.", href: "/queue", go: "Open queue" });
    } catch (err) {
      say(failedBanner({ id: "load", href: "/queue", go: "Open queue" }, `Could not load ${choice.label}${on}`, err));
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    }
  };

  return { choices, load, lacksOn, reading: !drafts.isSuccess };
}
