import type { ModelSettings, RecipeInfo } from "./api";
import { defaultOf } from "./fields";

/**
 * What a form starts from, in two layers: the recipe's own defaults, then what was saved for the model
 * file that is picked. A draft holds only what differs from this, so a draft follows its model's
 * settings until something is changed on purpose.
 */
export function formDefaults(
  recipe: RecipeInfo,
  options: Record<string, string[]> | undefined,
  settings: ModelSettings[],
  stored: Record<string, unknown> | undefined,
) {
  const base = Object.fromEntries(recipe.inputs.map((i) => [i.id, defaultOf(i, options?.[i.id])]));
  const modelInput = recipe.inputs.find((i) => i.type === "model");
  const file = modelInput ? String(stored?.[modelInput.id] ?? base[modelInput.id] ?? "") : "";
  const saved = settings.find((s) => s.family === recipe.family && s.file === file)?.values ?? {};
  const perModel = Object.fromEntries(recipe.inputs.filter((i) => i.perModel && i.id in saved).map((i) => [i.id, saved[i.id]]));
  return { defaults: { ...base, ...perModel }, file, hasSaved: Object.keys(saved).length > 0 };
}
