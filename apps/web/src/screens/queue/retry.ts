import { secondsInput } from "@afflatus/core";
import type { RecipeInfo } from "../../api";

/**
 * After a render ran out of memory: the same job, one size smaller (or, when it has no size to set,
 * shorter). null when the recipe offers nothing to make it lighter.
 */
export function lighter(recipe: RecipeInfo | undefined, input: Record<string, unknown> | null): { change: Record<string, unknown>; label: string } | null {
  if (!recipe || !input) return null;
  const size = recipe.inputs.find((i) => i.type === "number" && /short|resolution|megapixel|size/i.test(`${i.id} ${i.label}`));
  const length = secondsInput(recipe.inputs);
  for (const spec of [size, length]) {
    if (!spec || spec.type !== "number") continue;
    const now = Number(input[spec.id] ?? spec.default);
    const next = Math.max(spec.min, Number((now - spec.step * (spec === length ? Math.max(1, Math.round(1 / spec.step)) : 1)).toFixed(4)));
    if (next < now) return { change: { [spec.id]: next }, label: `Retry at ${next}${spec.unit ?? ""}` };
  }
  return null;
}

export const ranOutOfMemory = (error: string | null) => /out of memory|\boom\b|allocat|not enough memory/i.test(error ?? "");
