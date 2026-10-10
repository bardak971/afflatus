import { create } from "zustand";

/**
 * The input a new draft was opened for: an action that put a picture in a form (Image to video, Extend, a tool) names
 * the slot it filled, and the form opens on it (the Inputs part unfolded, the slot scrolled to and ringed once), so
 * that what was handed over is seen, not left folded under the prompt. Taken by the first form of that recipe drawn
 * within a few seconds; not kept.
 */
export const useFormAim = create<{ aim: { recipe: string; input: string; at: number } | null; set(recipe: string, input: string): void; take(recipe: string): string | null }>()((set, get) => ({
  aim: null,
  set: (recipe, input) => set({ aim: { recipe, input, at: Date.now() } }),
  take: (recipe) => {
    const aim = get().aim;
    if (!aim || aim.recipe !== recipe) return null;
    set({ aim: null });
    return Date.now() - aim.at < 10_000 ? aim.input : null;
  },
}));
