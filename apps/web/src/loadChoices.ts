import { useQueries, useQueryClient } from "@tanstack/react-query";
import { modelName, sameFile } from "@afflatus/core";
import { api, type RecipeInfo, type Scan } from "./api";
import { useDrafts, useQueue, useRecipes, useSetup } from "./data";
import { fileLabel } from "./format";
import { picksUnlisted } from "./officialFiles";
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
  /** Its family's name, and the file it loads as it is written (its family's usual one when its form picks none). */
  family: string;
  file: string;
  /** The operation it loads with, its model input, and the model file as ComfyUI lists it (null: not known). */
  recipe: string;
  input: string | null;
  path: string | null;
}

/** How many recent drafts' models are offered. */
const RECENT = 6;

/**
 * A model file in a machine's lists, for an operation's model input. Matched as the server matches it when it builds the job
 * (core sameFile): a draft names its file as the machine it was made on keeps it, and another machine may keep the same file
 * in another sub-folder or list it behind a backslash, and renders it all the same.
 */
export const listedOn = (scan: Scan | undefined, recipe: string, input: string | null, path: string | null): boolean | null => {
  if (!scan || !input || !path) return null;
  const status = scan.recipes.find((r) => r.id === recipe);
  return status ? Boolean(sameFile(status.options[input] ?? [], path)) : null;
};

/**
 * What the model menus offer to load ahead (the Load a model panel): the model of the form on screen first, then the
 * models of the recent drafts, each once, named by the model as it is written (a form's name did not say what is loaded,
 * and two forms on one checkpoint are one load). A form that picks no model names its family's usual file. `load` queues
 * the load, on the machine named or wherever the queue renders it first; `lacksOn` says a machine has not the form's
 * files; `setups` are each machine's lists, for what has what.
 */
export function useLoadChoices(form?: LoadForm | null) {
  const drafts = useDrafts(true);
  const recipes = useRecipes();
  const queue = useQueue();
  const setup = useSetup();
  const client = useQueryClient();
  const say = useBanners((b) => b.push);
  const several = severalMachines(queue.data);
  const setups = useQueries({ queries: several.map((m) => ({ queryKey: queryKeys.setup(m.id), queryFn: ({ signal }: { signal: AbortSignal }) => api.setup({ signal }, m.id), staleTime: 60_000 })) });

  const recipeOf = (id: string) => recipes.data?.recipes.find((x) => x.id === id);
  const familyName = (id: string) => recipes.data?.families.find((f) => f.id === recipeOf(id)?.family)?.name ?? "";
  /** An operation's model input, and the file it uses when the form picks none: its family's usual one, from the scan. */
  const modelInput = (id: string) => recipeOf(id)?.inputs.find((i) => i.type === "model");
  const usual = (id: string): string | null => {
    const i = modelInput(id);
    const slot = i && "slot" in i ? i.slot : undefined;
    return (slot && setup.data?.families.find((f) => f.id === recipeOf(id)?.family)?.slots.find((s) => s.id === slot)?.file) || null;
  };
  const choiceOf = (key: string, recipe: string, picked: string | null, note: string | undefined, ofForm: boolean) => {
    const path = picked ?? usual(recipe);
    const family = familyName(recipe);
    const file = path ? fileLabel(path) : `${recipeOf(recipe)?.title ?? recipe} · its usual model`;
    return { key, label: family ? `${family} · ${file}` : file, note, ofForm, family, file, recipe, input: modelInput(recipe)?.id ?? null, path };
  };
  // compared by name, whatever the case and the folder: one model, one row
  const keyOf = (recipe: string, picked: string | null) => {
    const path = picked ?? usual(recipe);
    return path ? `model:${modelName(path)}` : `recipe:${recipe}`;
  };

  // the form's own values, less what it no longer has
  const whole = form ? Object.fromEntries(Object.entries(form.input).filter(([k, v]) => form.recipe.inputs.some((i) => i.id === k) && v !== undefined)) : {};
  const formInput = form?.recipe.inputs.find((i) => i.type === "model");
  const formFile = formInput && typeof whole[formInput.id] === "string" && whole[formInput.id] ? (whole[formInput.id] as string) : null;

  const choices: Array<LoadChoice & { draft?: string }> = [];
  const seen = new Set<string>();
  if (form) {
    const key = keyOf(form.recipe.id, formFile);
    seen.add(key);
    choices.push(choiceOf(key, form.recipe.id, formFile, "this form", true));
  }
  for (const d of drafts.data?.items ?? []) {
    if (choices.length >= RECENT + (form ? 1 : 0)) break;
    const key = keyOf(d.recipe, d.model ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ ...choiceOf(key, d.recipe, d.model ?? null, d.name || d.title || undefined, false), draft: d.id });
  }

  /** Whether a machine has not the form's files: its recipe not ready there, or the model the form picks not listed there. */
  const lacksOn = (machine: string) => {
    if (!form) return false;
    const i = several.findIndex((m) => m.id === machine);
    const status = setups[i]?.data?.recipes.find((r) => r.id === form.recipe.id);
    if (!status) return false;
    return !status.ready || picksUnlisted(status, form.recipe, whole);
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
      say({ id: `load:${Date.now()}`, tone: "good", title: `Loading ${choice.file}${on}`, text: "Queued: the next render with it starts at once.", href: "/queue", go: "Open queue" });
    } catch (err) {
      say(failedBanner({ id: "load", href: "/queue", go: "Open queue" }, `Could not load ${choice.file}${on}`, err));
    } finally {
      void client.invalidateQueries({ queryKey: queryKeys.queue() });
    }
  };

  return { choices, load, lacksOn, reading: !drafts.isSuccess, setups: setups.map((q) => q.data) };
}
