import { carryOver, squash } from "@afflatus/core";
import type { FamilyInfo, RecipeInfo } from "./api";

export { carryOver };

/** A model to make things with: a built-in family, the workflows imported under its name, or both. */
interface ModelGroup {
  key: string;
  name: string;
  summary: string;
  /** What its "?" says (a built-in model's own words). */
  help?: FamilyInfo["help"];
  /** Built in, as opposed to made only of imported workflows. */
  builtIn: boolean;
  /** Its operations: the built-in ones, then the user's workflows. */
  recipes: RecipeInfo[];
}

/**
 * The models, each with its operations. A workflow imported under the name of a built-in model
 * ("Krea2" and "Krea 2" are one name) is listed with that model, next to its built-in operations.
 */
export function modelGroups(recipes: RecipeInfo[], families: Array<{ id: string; name: string; summary: string; imported?: true; help?: FamilyInfo["help"] }>): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const family of families) {
    const own = recipes.filter((r) => r.family === family.id);
    if (!own.length) continue;
    const builtIn = !family.imported;
    const same = groups.find((g) => g.key === squash(family.name));
    if (same) {
      same.recipes.push(...own);
      if (builtIn && !same.builtIn) Object.assign(same, { name: family.name, summary: family.summary, help: family.help, builtIn: true, recipes: [...own, ...same.recipes.filter((r) => !own.includes(r))] });
    } else {
      groups.push({ key: squash(family.name), name: family.name, summary: family.summary, help: family.help, builtIn, recipes: own });
    }
  }
  // a recipe whose family is not listed is still something to make things with
  for (const r of recipes) {
    if (groups.some((g) => g.recipes.includes(r))) continue;
    const same = groups.find((g) => g.key === squash(r.family));
    if (same) same.recipes.push(r);
    else groups.push({ key: squash(r.family), name: r.family, summary: "", builtIn: false, recipes: [r] });
  }
  return groups;
}

/**
 * What a clip that carries on from another starts with: the settings the other was made with (its model,
 * LoRAs, size, steps, sounds, who is in it…). Not what was its own: its pictures, the clips it joined,
 * its seed, and what happened in it, which is for the new clip to say.
 *
 * On another model, only what describes the clip goes along (its length, its shape, its sounds): the
 * model file, the LoRAs and every setting of how the first model was run are that model's own, and a
 * form of one model holding the file of another renders nothing.
 */
export function followOn(from: RecipeInfo | undefined, to: RecipeInfo, stored: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!from || !stored) return {};
  const same = from.id === to.id;
  const taken = same ? { ...stored } : carryOver(from, to, stored, undefined);
  const said = to.inputs.find((i) => i.type === "prompt" && !i.optional);
  const has = new Map(to.inputs.map((i) => [i.id, i]));
  for (const id of Object.keys(taken)) {
    const i = has.get(id);
    if (!i || i.type === "image" || i.type === "clip" || i.type === "seed" || i.id === said?.id) delete taken[id];
    else if (!same && from.family !== to.family && (i.type === "model" || i.type === "loras" || i.advanced || i.perModel)) delete taken[id];
  }
  return taken;
}

/**
 * What goes along to another model's form: what the thing is made from and about. Its pictures, each
 * to the place that is for the same thing there (a start image to the start image, whatever the two
 * forms call it), and what is written, when both models are written to the same way. Never how the
 * first model was run: its file, its LoRAs and its settings are its own. Nothing the other form
 * already holds is replaced.
 */
export function carryAcross(from: RecipeInfo, to: RecipeInfo, stored: Record<string, unknown> | undefined, held: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!stored) return out;
  const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());
  for (const i of to.inputs) {
    if (i.type !== "image" || !empty(held?.[i.id])) continue;
    const was = from.inputs.find((o) => o.type === "image" && o.role === i.role);
    if (was && !empty(stored[was.id])) out[i.id] = stored[was.id];
  }
  const said = (r: RecipeInfo) => r.inputs.find((i) => i.type === "prompt" && !i.optional);
  const a = said(from);
  const b = said(to);
  if (a?.type === "prompt" && b?.type === "prompt" && a.style === b.style && !empty(stored[a.id]) && empty(held?.[b.id])) out[b.id] = stored[a.id];
  return out;
}

/**
 * Which of several ways to make something a new draft opens on: the one used last (the newest draft made
 * with one of them: drafts come newest first), else the first that is ready, else the first.
 */
export function usedLast<R extends { id: string }>(ways: R[], drafts: Array<{ recipe: string }> | undefined, ready: (r: R) => boolean): R | undefined {
  for (const d of drafts ?? []) {
    const way = ways.find((r) => r.id === d.recipe);
    if (way) return way;
  }
  return ways.find(ready) ?? ways[0];
}
