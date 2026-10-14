import type { FamilyInfo, RecipeInfo } from "./api";

/**
 * What a model's "?" says, as one text for the tip (its head is the model's name): what it makes, what it is best and weak at,
 * and the operation picked, by its own summary. Nothing for a family that says nothing of itself (an imported workflow's).
 */
export function modelHelp(family: Pick<FamilyInfo, "help"> | undefined, recipe?: Pick<RecipeInfo, "title" | "summary">): string | undefined {
  const h = family?.help;
  if (!h) return undefined;
  return [h.what, "", `Best at: ${h.best}.`, `Weak at: ${h.weak}.`, ...(recipe ? ["", `${recipe.title}: ${recipe.summary}`] : [])].join("\n");
}
