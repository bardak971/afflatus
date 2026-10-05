import type { InputSpec } from "@afflatus/core";
import type { Entity, FamilyInfo, RecipeInfo } from "../../api";

export const field = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-ink placeholder:text-ink-3";

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
