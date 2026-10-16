import { useMutation } from "@tanstack/react-query";
import { api, type AssetDetail } from "./api";
import { useRecipes } from "./data";
import { useOpenNewDraft } from "./draft";
import { reusedInputs, type ReuseSeed } from "./viewer/shared";

export type { ReuseSeed } from "./viewer/shared";

/** A render's generation parameters, as the item's details carry them. */
export type Generation = NonNullable<AssetDetail["generation"]>;

/**
 * Reuse a render's generation parameters as a new draft in the form, its seed kept (L) or rolled again
 * (Shift+L): what is being written elsewhere is not touched. For the viewer, a tile's menu and the command
 * bar. `leave` runs before the form opens (the viewer over the screen steps aside); `onError` says why it failed.
 */
export function useReuse({ leave, onError }: { leave?(): void; onError?(err: Error): void } = {}) {
  const recipes = useRecipes();
  const openNew = useOpenNewDraft();
  const mutation = useMutation({
    mutationFn: ({ g, seed }: { g: Generation; seed: ReuseSeed }) => {
      const recipe = recipes.data?.recipes.find((r) => r.id === g.recipe);
      return api.createDraft({ recipe: g.recipe, forms: { [g.recipe]: reusedInputs(g, recipe, seed) } });
    },
    onSuccess: (d) => {
      leave?.();
      openNew(d);
    },
    onError,
  });
  return {
    /** Reuse · same seed (L). */
    sameSeed: (g: Generation) => mutation.mutate({ g, seed: "same" }),
    /** Reuse · new seed (Shift+L). */
    newSeed: (g: Generation) => mutation.mutate({ g, seed: "new" }),
    isPending: mutation.isPending,
    error: mutation.error,
    /** When it was last asked (0: never), for a place that says the latest of its failures. */
    submittedAt: mutation.submittedAt,
  };
}
