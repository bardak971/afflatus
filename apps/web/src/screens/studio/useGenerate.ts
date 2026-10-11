import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Draft, type RecipeInfo } from "../../api";
import type { useDraft } from "../../draft";
import { notFilled, sentForm } from "../../form";
import { movingSeed, seedAfter, useSeedMode } from "../../seedMode";
import { queryKeys } from "../../queryKeys";

/**
 * What Generate does: the whole form, checked, sent to the queue as many times as the batch says, filed in
 * `folder`. Ctrl + Enter does it from anywhere on the screen, a text box included.
 */
export function useGenerate({ recipe, draft, defaults, folder, d, blocked }: {
  recipe: RecipeInfo | undefined;
  draft: Draft | null;
  /** The form's starting values, for what was never touched. */
  defaults: Record<string, unknown>;
  folder: string | undefined;
  d: ReturnType<typeof useDraft>;
  blocked: string | null;
}) {
  const client = useQueryClient();
  const send = useMutation({
    mutationFn: async () => {
      if (!recipe || !draft) return;
      const input = sentForm(recipe, defaults, draft.forms[recipe.id]);
      const missing = notFilled(recipe, input);
      if (missing) throw new ApiError(missing);
      const count = draft.count;
      // a seed meant to move: the batch takes the next seeds in a row, and the form shows the one after them
      const mode = useSeedMode.getState().mode;
      const seedMode = movingSeed(input.seed, mode);
      // the draft it was sent from, whichever is open by the time the queue answers
      const id = draft.id;
      await api.enqueue(recipe.id, input, count, draft.look, { draft: id, folder, seedMode });
      if (seedMode) {
        const next = seedAfter(input.seed as number, mode, count);
        await d.editDraft(id, (x) => ({ ...x, forms: { ...x.forms, [recipe.id]: { ...x.forms[recipe.id], seed: next } } }));
      }
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.queue() }),
  });

  const make = useRef(() => {});
  make.current = () => {
    if (recipe && draft && !blocked && !send.isPending && !document.querySelector("[role=dialog][aria-modal=true]")) send.mutate();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // not once something else took the key: Ctrl+Enter in the command bar is a row's second action ("Show in Projects"),
      // and the bar closing on it left nothing here to tell it was not the form's
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.defaultPrevented) {
        e.preventDefault();
        make.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return send;
}
