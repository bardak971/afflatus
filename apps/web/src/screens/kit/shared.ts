import type { InputSpec } from "@afflatus/core";
import type { Entity, FamilyInfo, Outfit, RecipeInfo } from "../../api";
import { fieldClass } from "../../ui";

export const field = `w-full py-2 ${fieldClass}`;

/** What one model can take of a person, read from its recipes: words (tags or a sentence), a LoRA, pictures, a voice. */
export function takes(family: FamilyInfo, recipes: RecipeInfo[]) {
  const mine = recipes.filter((r) => r.family === family.id);
  const has = (test: (i: InputSpec) => boolean) => mine.some((r) => r.inputs.some(test));
  return {
    tags: has((i) => i.type === "prompt" && !i.optional && i.style === "tags"),
    lora: has((i) => i.type === "loras"),
    pictures: has((i) => i.type === "references"),
    voice: has((i) => i.type === "audio" && i.role === "voice"),
  };
}

/**
 * The rows of "per model" lists (a person's LoRAs, a style's text and LoRAs): one per model. A workflow's family
 * folds into the family of the same name ("Wan 2.2" built in and a Wan 2.2 workflow: workflows of one model share
 * its LoRAs; "Krea2" and "Krea 2" are one name), the built-in one first; the Image tools take no prompt and are
 * left out. `ids` is every family the row stands for: what is set there is stored under each, so a render by any
 * of them finds it, and an entry stored under one of them alone (before rows were merged) still shows.
 */
export function modelRows(families: FamilyInfo[], recipes: RecipeInfo[]) {
  const rows: Array<{ family: FamilyInfo; ids: string[]; can: ReturnType<typeof takes> }> = [];
  const key = (name: string) => name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  for (const f of families) {
    if (f.id === "tools") continue;
    const can = takes(f, recipes);
    const row = rows.find((r) => key(r.family.name) === key(f.name));
    if (!row) {
      rows.push({ family: f, ids: [f.id], can });
      continue;
    }
    row.ids.push(f.id);
    for (const k of Object.keys(can) as Array<keyof typeof can>) row.can[k] ||= can[k];
  }
  return rows;
}
/** A row's entry: the first of its families that has one. */
export const entryOf = <T,>(models: Record<string, T>, ids: string[]): T | undefined => ids.map((id) => models[id]).find(Boolean);
/** A row's entry changed: written under every family of the row. */
export const withEntry = <T,>(models: Record<string, T>, ids: string[], entry: T): Record<string, T> => ({ ...models, ...Object.fromEntries(ids.map((id) => [id, entry])) });

export const remembered = <T,>(key: string, otherwise: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : otherwise;
  } catch {
    return otherwise;
  }
};
export const remember = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // nowhere to remember it: it holds for this visit
  }
};

/** Everything an item is found by. */
export function textOf(e: Entity): string {
  if (e.kind === "person") return `${e.name} ${e.def.tags} ${e.def.sentence} ${e.def.outfits.map((o) => o.name).join(" ")}`;
  if (e.kind === "place") return `${e.name} ${e.def.tags} ${e.def.sentence}`;
  if (e.kind === "style") return `${e.name} ${Object.values(e.def.models).map((m) => m.words).join(" ")}`;
  if (e.kind === "snippet") return `${e.name} ${e.def.category} ${e.def.text}`;
  return e.name;
}

/**
 * An outfit that holds nothing yet: no name, no words and no picture. It is a row just added with "+ Outfit" and not
 * filled in, so it is not saved and not counted; an empty one saved before this rule stays in the person's data
 * (nothing is deleted behind the owner's back) but is left out of the counts and the menus.
 */
export const blankOutfit = (o: Outfit) => !o.name.trim() && !o.tags.trim() && !o.sentence.trim() && !o.picture;
/** The outfits that hold something. */
export const outfitsOf = (outfits: Outfit[]) => outfits.filter((o) => !blankOutfit(o));
