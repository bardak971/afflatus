import { secondsOf } from "@studai/core";
import type { Rate, RecipeInfo } from "./api";

/**
 * About how long one render of this recipe with these values takes, from what was rendered before on
 * this machine: per second of video when the recipe has a length, else per job. null when nothing like
 * it was rendered yet. The same sum the server makes for the queue.
 */
export function estimateFor(rates: Record<string, Rate> | undefined, recipe: RecipeInfo | undefined, input: Record<string, unknown>): number | null {
  const rate = recipe && rates?.[recipe.id];
  if (!rate || !recipe) return null;
  const seconds = secondsOf(recipe.inputs, input);
  return rate.perSecondMs && seconds ? Math.round(rate.perSecondMs * seconds) : rate.perJobMs;
}
