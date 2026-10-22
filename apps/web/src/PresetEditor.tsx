import { useMemo } from "react";
import { type Look, type PresetDef, type RecipeInfo } from "./api";
import { useEntities, useRecipes, useSetup } from "./data";
import { wholeForm } from "./form";
import { plural, recipeLabel } from "./format";
import { LookBar, lookWords } from "./LookBar";
import { useModelSettings } from "./data";
import { useInputEdits } from "./hooks";
import { Form } from "./RecipeForm";
import { Select } from "./Select";
import { AutoText } from "./ui";
import { PresetFiles } from "./PresetFiles";

/**
 * A preset, opened to be changed: the model and operation it is for (or none: then only the prompt and
 * the references, for any model), its form with only what the preset sets (a field that is reset
 * follows the model's defaults and is no longer part of the preset), and who is in it. The same Form
 * as Studio's: what is stored is what the preset holds.
 */
export function PresetEditor({ id, def, onChange }: { id?: string; def: PresetDef; onChange(def: PresetDef): void }) {
  const recipes = useRecipes();
  const setup = useSetup();
  const entities = useEntities();
  const settings = useModelSettings();
  const recipe = recipes.data?.recipes.find((r) => r.id === def.recipe);
  const status = setup.data?.recipes.find((r) => r.id === def.recipe);
  const families = recipes.data?.families ?? [];
  const nameOf = (r: RecipeInfo) => recipeLabel(families.find((f) => f.id === r.family)?.name, r.title);
  const options = useMemo(() => [
    { value: "", label: "Any model", note: "only the prompt and the references are kept" },
    ...(recipes.data?.recipes ?? []).map((r) => ({ value: r.id, label: nameOf(r), group: families.find((f) => f.id === r.family)?.name })),
  ], [recipes.data]); // eslint-disable-line react-hooks/exhaustive-deps -- the options follow the recipes' read; nameOf and families come from it
  const held = Object.keys(def.inputs).length;
  const look = (def.look as Look | null | undefined) ?? null;
  // the values the form shows: the model's defaults under what the preset sets
  const whole = recipe ? wholeForm(recipe, status, settings.data?.items ?? [], def.inputs) : def.inputs;
  // an emptied text or list is not "set to nothing": it leaves the preset, so that applying it leaves the form's own alone
  const setInputs = (inputs: Record<string, unknown>) => onChange({ ...def, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => !(v === "" || (Array.isArray(v) && v.length === 0)))) });
  const edit = useInputEdits(def.inputs, setInputs);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-ink-2">Model and operation</span>
        <Select
          label="Model and operation of the preset"
          value={def.recipe ?? ""}
          onChange={(id) => {
            // another model: what has the same name in both forms stays, the rest would mean nothing there
            const next = recipes.data?.recipes.find((r) => r.id === id);
            const kept = next ? Object.fromEntries(Object.entries(def.inputs).filter(([k]) => next.inputs.some((i) => i.id === k))) : Object.fromEntries(Object.entries(def.inputs).filter(([k]) => k === "prompt" || k === "negative"));
            onChange({ ...def, recipe: id || undefined, inputs: kept });
          }}
          options={options}
          searchHint="Search the models and operations"
        />
        <span className="text-xs text-ink-3">
          {held ? `${plural(held, "parameter")} set` : "No parameter set"}{look && lookWords(look, entities.data?.items ?? []) ? ` · ${lookWords(look, entities.data?.items ?? [])}` : ""}.
          {" "}A field left at the model's default is not part of the preset; "Changed · reset" takes one out. Applying the preset changes only what it sets.
        </span>
      </div>

      {def.files?.length ? <PresetFiles id={id ?? ""} def={def} /> : null}

      {recipe ? (
        <Form
          key={recipe.id}
          // a preset's values, not a form renders are made from: no Pinned card
          noPins
          recipe={recipe}
          status={status}
          stored={def.inputs}
          onChange={edit}
          onClear={(inputs) => setInputs(Object.fromEntries(Object.entries(def.inputs).filter(([k]) => !inputs.includes(k))))}
          madeSummary={nameOf(recipe)}
          look={<LookBar look={look} onChange={(l) => onChange({ ...def, look: l })} recipe={recipe} input={whole} />}
          lookSummary={lookWords(look, entities.data?.items ?? [])}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink-2">Prompt <span className="font-normal text-ink-3">(optional)</span></span>
            <AutoText aria-label="Prompt" value={String(def.inputs.prompt ?? "")} onChange={(e) => setInputs(e.target.value ? { ...def.inputs, prompt: e.target.value } : Object.fromEntries(Object.entries(def.inputs).filter(([k]) => k !== "prompt")))} placeholder="Written into the prompt of whatever form the preset is applied to" />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink-2">Negative prompt <span className="font-normal text-ink-3">(optional)</span></span>
            <AutoText aria-label="Negative prompt" value={String(def.inputs.negative ?? "")} onChange={(e) => setInputs(e.target.value ? { ...def.inputs, negative: e.target.value } : Object.fromEntries(Object.entries(def.inputs).filter(([k]) => k !== "negative")))} placeholder="Models with a negative prompt take it; the others leave it" />
          </div>
          <LookBar look={look} onChange={(l) => onChange({ ...def, look: l })} />
        </div>
      )}
    </div>
  );
}
