import { guess, modelOf, secondsOf, type Known } from "@studai/core";
import type { Rate, RecipeInfo } from "./api";

/**
 * About how long one render of this recipe with these values takes, from what was rendered before on
 * this machine: from the record of renders like it (the same settings on the same model, else the
 * model, else the recipe), and where there is no record yet, from the totals of before. null when
 * nothing like it was rendered yet. The same sum the server makes for the queue.
 *
 * `held` is the model ComfyUI has loaded, as the queue names it: a form on another model is told what
 * loading it adds, once, however many renders are asked for.
 */
export function estimateFor(
  known: { rates: Record<string, Rate>; known?: Record<string, Known> } | undefined,
  recipe: RecipeInfo | undefined,
  input: Record<string, unknown>,
  held?: string | null,
): { ms: number; loadMs: number } | null {
  if (!recipe || !known) return null;
  const g = guess(known.known?.[recipe.id], recipe.inputs, input);
  if (g) {
    const model = modelOf(recipe.inputs, input);
    // the loaded model is named without folder or extension; one in two parts as "high + low"
    const loaded = held !== undefined && model !== null && (held ?? "").toLowerCase().split(" + ").includes(model);
    return { ms: g.ms, loadMs: held === undefined || model === null || loaded ? 0 : g.loadMs };
  }
  const rate = known.rates[recipe.id];
  if (!rate) return null;
  const seconds = secondsOf(recipe.inputs, input);
  return { ms: rate.perSecondMs && seconds ? Math.round(rate.perSecondMs * seconds) : rate.perJobMs, loadMs: 0 };
}
