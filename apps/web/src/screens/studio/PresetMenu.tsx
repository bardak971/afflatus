import { useState } from "react";
import { Bookmark } from "lucide-react";
import type { Entity, RecipeInfo } from "../../api";
import { useRecipes } from "../../data";
import { recipeLabel } from "../../format";
import { Select } from "../../Select";
import { Button, ErrorNote } from "../../ui";

type Preset = Extract<Entity, { kind: "preset" }>;

/**
 * Why a preset cannot be applied, or null: one made for a model that is not here (a workflow removed,
 * a family not installed) is refused rather than moving the draft onto a model it cannot show.
 */
export const presetRefusal = (p: Preset, all: RecipeInfo[]): string | null =>
  p.def.recipe && !all.some((r) => r.id === p.def.recipe) ? `${p.name} is made for a model that is not installed here (${p.def.recipe}).` : null;

/** The presets: load one into the form, or save the form as one under a name. */
export function PresetMenu({ presets, onApply, onSave, error }: {
  presets: Preset[];
  onApply(p: Preset): void;
  onSave(name: string): void;
  /** Why the last load or save did not happen. */
  error: string | null;
}) {
  const recipes = useRecipes();
  const all = recipes.data?.recipes ?? [];
  const [presetName, setPresetName] = useState("");
  return (
    <>
      <Select
        dashed
        size="sm"
        className="h-9"
        icon={<Bookmark size={13} className="shrink-0" />}
        label="Presets"
        placeholder={presets.length ? "Load a preset, or save this as one" : "Save as preset"}
        value=""
        onChange={(id) => {
          const p = presets.find((x) => x.id === id);
          if (p) onApply(p);
        }}
        options={presets.map((p) => ({ value: p.id, label: p.name, note: p.def.recipe ? recipeLabel(recipes.data?.families.find((f) => f.id === all.find((r) => r.id === p.def.recipe)?.family)?.name, all.find((r) => r.id === p.def.recipe)?.title ?? "model no longer installed") : "any model" }))}
        footer={(close) => (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!presetName.trim()) return;
              onSave(presetName.trim());
              setPresetName("");
              close();
            }}
          >
            <input aria-label="New preset name" placeholder="Save as preset: name" value={presetName} onChange={(e) => setPresetName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="h-8 min-w-0 grow rounded-md bg-raised px-2 placeholder:text-ink-3" />
            <Button size="sm" tone="quiet" type="submit" disabled={!presetName.trim()}>Save</Button>
          </form>
        )}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
    </>
  );
}
