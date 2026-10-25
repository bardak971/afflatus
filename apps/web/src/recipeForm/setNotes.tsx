import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FamilyInfo, type RecipeInfo, type SetFinding } from "../api";
import { settingsOnly } from "../form";
import { useSettled } from "../hooks";
import { queryKeys } from "../queryKeys";

/**
 * Whether the form's files go together (server modelSetCheck.ts, card #83): a VAE, text encoder or LoRA of another
 * version, a pair swapped. Asked again only when a setting changes, as the pack notes are. Never changes a file: the user
 * decides, and Render goes ahead with a warning (said on the job); a mix known to give black frames is refused there.
 */
export function useSetNotes(recipe: RecipeInfo, values: Record<string, unknown>): SetFinding[] {
  const key = useSettled(useMemo(() => JSON.stringify(settingsOnly(recipe, values)), [recipe, values]), 500);
  return useQuery({
    queryKey: queryKeys.setCheck(recipe.id, key),
    queryFn: ({ signal }) => api.setCheck(recipe.id, JSON.parse(key) as Record<string, unknown>, { signal }),
    staleTime: 30_000,
  }).data?.findings ?? [];
}

/**
 * The findings of one LoRA list, under it (`input`); or, with `input` null, every other one above the form, named by its
 * field or family file: a model input is often picked in the screen's own model picker, a family file in Settings › Models.
 */
export function SetNotes({ of, input, recipe, family }: { of: SetFinding[]; input: string | null; recipe: RecipeInfo; family: FamilyInfo | undefined }) {
  const lists = new Set(recipe.inputs.filter((i) => i.type === "loras").map((i) => i.id));
  const notes = of.filter((f) => (input === null ? !lists.has(f.at) : f.at === input));
  if (!notes.length) return null;
  const where = (at: string) => recipe.inputs.find((i) => i.id === at)?.label ?? family?.slots?.find((s) => s.id === at)?.label ?? at;
  return (
    <>
      {notes.map((f) => (
        <span key={`${f.at}:${f.file}`} className="text-xs text-warn-ink" data-set-note={f.at} data-tip={f.black ? "Render refuses this mix: pick another file." : "Render still goes ahead; the job says it too."}>
          {input === null && <span className="font-semibold">{where(f.at)}: </span>}
          {f.text}
          {f.black && " Render refuses it."}
        </span>
      ))}
    </>
  );
}
