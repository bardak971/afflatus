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

const ranOutOfMemory = (error: string | null) => /out of memory|\boom\b|allocat|not enough memory/i.test(error ?? "");
/** Which memory ran out: the card's, or the machine's (a CPU allocator: the work had fallen back to the processor). */
export const memoryThatRanOut = (error: string | null): "ram" | "vram" | null =>
  !ranOutOfMemory(error) ? null : /CPUAllocator|cannot allocate memory|system memory|\bRAM\b/i.test(error ?? "") ? "ram" : "vram";

/** After a latent upscale ran out of memory: the same job re-sampled in shorter stretches of frames. null when it was not a latent upscale, or the stretch is as short as it goes. */
export function shorterStretch(recipe: RecipeInfo | undefined, input: Record<string, unknown> | null): { change: Record<string, unknown>; label: string } | null {
  if (!recipe || !input || !/latent/i.test(String(input.upscale ?? ""))) return null;
  const chunk = recipe.inputs.find((i) => i.id === "upscaleChunk");
  if (!chunk || chunk.type !== "number") return null;
  const now = Number(input[chunk.id] ?? chunk.default);
  const next = Math.max(chunk.min, now - chunk.step * 2);
  return next < now ? { change: { [chunk.id]: next }, label: `Retry with ${next}-frame stretches` } : null;
}
