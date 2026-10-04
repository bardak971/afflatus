import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink } from "lucide-react";
import { api, type Entity, type PresetDef } from "./api";
import { useRecipes } from "./data";
import { fileLabel, recipeLabel } from "./format";
import { PresetFiles } from "./PresetFiles";
import { Button, ErrorNote } from "./ui";

/**
 * A preset that ships with Afflatus, opened in the Prompt kit: who made it, what it is, the model and
 * the parameters it sets, its files and what is missing. It cannot be changed; a copy can.
 */
export function ShippedPreset({ e, onCopied }: { e: Extract<Entity, { kind: "preset" }>; onCopied(copy: Entity): void }) {
  const recipes = useRecipes();
  const client = useQueryClient();
  const def: PresetDef = e.def;
  const recipe = recipes.data?.recipes.find((r) => r.id === def.recipe);
  const family = recipes.data?.families.find((f) => f.id === recipe?.family);
  const copy = useMutation({
    mutationFn: () => api.createEntity("preset", e.name, def),
    onSuccess: async (made) => {
      await client.invalidateQueries({ queryKey: ["entities"] });
      onCopied(made);
    },
  });
  const said = (k: string, v: unknown) => {
    const input = recipe?.inputs.find((i) => i.id === k);
    const label = input?.label ?? k;
    if (input?.type === "model" || (typeof v === "string" && /\.(safetensors|gguf|ckpt|pt|pth)$/i.test(v))) return `${label}: ${fileLabel(String(v))}`;
    if (typeof v === "boolean") return `${label}: ${v ? "on" : "off"}`;
    if (typeof v === "object" && v !== null) return `${label}: ${JSON.stringify(v)}`;
    return `${label}: ${String(v)}`;
  };
  return (
    <div className="flex flex-col gap-4">
      {def.note && <div className="text-ink-2">{def.note}</div>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        {def.author && <span>By <span className="font-semibold">{def.author}</span></span>}
        {def.homepage && <a href={def.homepage} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-semibold underline">Its page <ExternalLink size={11} /></a>}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink-2">Model and operation</span>
        <span>{recipe ? recipeLabel(family?.name, recipe.title) : `${def.recipe ?? "any model"} (not installed as a built-in here)`}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink-2">What it sets</span>
        {Object.keys(def.inputs).length === 0 && <span className="text-ink-2">Nothing beyond the model's defaults.</span>}
        {Object.entries(def.inputs).map(([k, v]) => <span key={k}>{said(k, v)}</span>)}
        <span className="text-xs text-ink-3">Applied in Studio (under Model), it changes only these; everything else follows the model's own defaults and what you saved for it.</span>
      </div>
      <PresetFiles id={e.id} def={def} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => copy.mutate()} disabled={copy.isPending} className="flex items-center gap-1.5"><Copy size={13} /> Copy to my presets</Button>
        <span className="text-xs text-ink-3">A built-in preset cannot be changed; a copy can, and keeps the files and the credit.</span>
      </div>
      {copy.isError && <ErrorNote>{copy.error.message}</ErrorNote>}
    </div>
  );
}
