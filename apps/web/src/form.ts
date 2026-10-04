import type { ModelSettings, RecipeInfo } from "./api";
import { defaultOf } from "./fields";

/**
 * What a form starts from, in two layers: the recipe's own defaults, then what was saved for the model
 * file that is picked. A draft holds only what differs from this, so a draft follows its model's
 * settings until something is changed on purpose.
 */
const baseName = (f: string) => (f.split(/[\\/]/).pop() ?? f).toLowerCase();

/**
 * A preset's model files, as this ComfyUI names them: a preset made elsewhere says "model.safetensors",
 * ComfyUI here may keep it as "High\\model.safetensors". The same file by name is taken for the same file.
 */
export function matchFiles(recipe: RecipeInfo, options: Record<string, string[]> | undefined, inputs: Record<string, unknown>): Record<string, unknown> {
  const out = { ...inputs };
  for (const i of recipe.inputs) {
    if (i.type !== "model" || typeof out[i.id] !== "string") continue;
    const list = options?.[i.id] ?? [];
    const value = out[i.id] as string;
    if (!list.includes(value)) {
      const same = list.find((o) => baseName(o) === baseName(value));
      if (same) out[i.id] = same;
    }
  }
  return out;
}

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
  const hasSaved = Object.keys(saved).length > 0;
  // nothing saved for this file yet: what its line's authors recommend, read from its name (Pony, NoobAI v-pred, Krea…)
  const name = file.split(/[\\/]/).pop() ?? "";
  const preset = !hasSaved && name ? (recipe.presets ?? []).find((p) => new RegExp(p.match, "i").test(name)) : undefined;
  const lined = preset ? Object.fromEntries(recipe.inputs.filter((i) => i.id in preset.values).map((i) => [i.id, preset.values[i.id]])) : {};
  const perModel = Object.fromEntries(recipe.inputs.filter((i) => i.perModel && i.id in saved).map((i) => [i.id, saved[i.id]]));
  return { defaults: { ...base, ...lined, ...perModel }, file, hasSaved, preset: preset?.note };
}
