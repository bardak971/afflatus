import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Workflow } from "lucide-react";
import type { Draft, RecipeInfo } from "../../api";
import { useFamilies, useOfficialSizes, useRecipes, useSetup } from "../../data";
import { formsCanQueue, notReady, plural, waitsForGpu } from "../../format";
import { lacksOnlyFiles, officialFiles } from "../../officialFiles";
import { firstOperation, sizeSaid } from "../../familyMinimum";
import { carryAcross, carryOver, modelGroups } from "../../picker";
import { Select } from "../../Select";
import { modelHelp } from "../../modelHelp";
import { cx, Help, Segmented } from "../../ui";

type ModelGroup = ReturnType<typeof modelGroups>[number];
/** One empty list while the recipes load, so what is worked out from them is not redone at every render. */
const NO_RECIPES: RecipeInfo[] = [];

/**
 * A model first, then what to do with it: the models that make the kind of thing the form makes, each with
 * its operations. Kept above the form (whose parts are drawn afresh for each recipe): going back to a model
 * goes back to the operation last used with it, and to a kind, to the model last used of it.
 */
export function useModelPick({ recipe, draft, onPick }: {
  recipe: RecipeInfo | undefined;
  draft: Draft | null;
  /** Another recipe, with what it takes along from the form that is left. */
  onPick(id: string, carried: Record<string, unknown>): void;
}) {
  const recipes = useRecipes();
  const setup = useSetup();
  const families = useFamilies();
  const sizes = useOfficialSizes();
  const all = recipes.data?.recipes ?? NO_RECIPES;
  const comfyOnline = formsCanQueue(setup.data?.comfy);
  // pictures or videos: the models of the other kind are out of the way; the last one used of each kind is remembered
  const kinds = [...new Set(all.map((r) => r.output))];
  const [lastOf, setLastOf] = useState<Record<string, string>>({});
  const groups = useMemo(
    () => modelGroups(all.filter((r) => r.output === (recipe?.output ?? "image") && (families.offers(r) || r.id === recipe?.id)), recipes.data?.families ?? []),
    [all, recipe?.output, recipe?.id, recipes.data?.families, families],
  );
  const group = groups.find((g) => g.recipes.some((r) => r.id === recipe?.id));
  // a family file with an official download keeps nothing from being picked: the job waits for it where it runs
  const familyOf = (id: string) => recipes.data?.families.find((f) => f.id === id);
  const statusOf = (r: RecipeInfo) => setup.data?.recipes.find((x) => x.id === r.id);
  const why = (r: RecipeInfo) => (setup.isSuccess && !(comfyOnline && lacksOnlyFiles(statusOf(r), r, familyOf(r.family))) ? notReady(statusOf(r), comfyOnline) : null);
  /** A model whose files are not here (their official downloads): "3 files not here", with what they weigh when known. */
  const notHere = (g: ModelGroup): string | null => {
    const r = g.recipes.find((x) => lacksOnlyFiles(statusOf(x), x, familyOf(x.family)));
    if (!r || waitsForGpu(setup.data?.comfy)) return null;
    const family = familyOf(r.family);
    const st = statusOf(r)!;
    // its family files not found, and the official file of each model input with nothing to pick
    const urls = new Set([
      ...st.missingSlots.map((id) => family?.slots?.find((s) => s.id === id)?.get?.url),
      ...st.emptyInputs.flatMap((id) => { const i = r.inputs.find((x) => x.id === id); return i?.type === "model" ? officialFiles(family, i.folder, i.slot).slice(0, 1).map((o) => o.url) : []; }),
    ].filter((u): u is string => Boolean(u)));
    const weight = sizeSaid([...urls], sizes.data);
    return `${urls.size ? `${plural(urls.size, "file")} ` : ""}not here${weight ? ` · ${weight}` : ""}`;
  };
  /**
   * A model none of whose operations can run, in a few words beside its "not ready" (the #143 audit: it said "not ready"
   * and nothing of why): of its first operation, the nodes this ComfyUI lacks, or its files missing with what they weigh.
   */
  const notReadyWhy = (g: ModelGroup): string => {
    const r = firstOperation(g.recipes);
    const st = r && statusOf(r);
    if (!r || !st || !comfyOnline) return "not ready";
    if (st.missingNodes.length) return `not ready · ${plural(st.missingNodes.length, "node")} missing`;
    const family = familyOf(r.family);
    const files = [...st.missingSlots.map((id) => family?.slots?.find((x) => x.id === id)?.get?.url), ...st.missingFiles.map(() => undefined), ...st.emptyInputs.map(() => undefined)];
    if (!files.length) return "not ready";
    const weight = sizeSaid(files, sizes.data);
    return `not ready · ${plural(files.length, "file")} missing${weight ? ` · ${weight}` : ""}`;
  };
  /** The operation last used with each model: going back to a model goes back to it. */
  const [lastIn, setLastIn] = useState<Record<string, string>>({});
  const pick = (id: string) => {
    const r = all.find((x) => x.id === id);
    if (!r) return;
    setLastOf((l) => ({ ...l, [r.output]: id }));
    const to = groups.find((g) => g.recipes.includes(r));
    if (to) setLastIn((l) => ({ ...l, [to.key]: id }));
    // another operation of the same model takes along what was set: the prompt, the model, the LoRAs, how it samples.
    // Another model that makes the same kind of thing takes along what it is made from and about: the pictures
    // (a start image stays the start image) and what is written, never the settings of the first model
    const carried = !recipe || !draft || !to ? {}
      : to === group ? carryOver(recipe, r, draft.forms[recipe.id], draft.forms[r.id])
      : r.output === recipe.output ? carryAcross(recipe, r, draft.forms[recipe.id], draft.forms[r.id])
      : {};
    onPick(id, carried);
  };
  const pickModel = (key: string) => {
    const to = groups.find((g) => g.key === key);
    if (!to) return;
    const back = to.recipes.find((r) => r.id === lastIn[key]);
    pick((back ?? to.recipes.find((r) => !why(r)) ?? to.recipes[0]!).id);
  };
  const pickKind = (k: string) => pick(lastOf[k] ?? all.find((r) => r.output === k)!.id);
  return { all, kinds, groups, group, why, notHere, notReadyWhy, pick, pickModel, pickKind };
}

/**
 * The radio buttons of a model's operations: one stop for Tab, the arrow keys go from one to the next (and pick it). Studio's,
 * and the clip inspector's (card #172), where `noteOf` says how each would meet the clip before.
 */
export function Operations({ group, recipe, why, pick, noteOf }: { group: ModelGroup; recipe: RecipeInfo; why(r: RecipeInfo): string | null; pick(id: string): void; noteOf?(r: RecipeInfo): string | undefined }) {
  const self = useRef<HTMLDivElement>(null);
  const step = (e: KeyboardEvent, i: number) => {
    const by = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? group.recipes.length - 1 : by ? (i + by + group.recipes.length) % group.recipes.length : -1;
    if (to < 0) return;
    e.preventDefault();
    pick(group.recipes[to]!.id);
    self.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[to]?.focus();
  };
  return (
    <div ref={self} role="radiogroup" aria-label="Operation" className="flex flex-wrap gap-1 rounded-control bg-raised p-[3px]">
      {group.recipes.map((r, i) => {
        const on = r.id === recipe.id;
        const own = r.imported;
        return (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-tip={`${why(r) ? `${why(r)} ` : ""}${noteOf?.(r) ? `${noteOf(r)}. ` : ""}${r.summary}`}
            onClick={() => pick(r.id)}
            onKeyDown={(e) => step(e, i)}
            className={cx("flex h-7 min-w-0 grow items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-semibold", own ? "basis-[45%]" : "basis-[30%]", on ? "bg-line-strong text-ink-strong" : why(r) ? "text-ink-3" : "text-ink-2 hover:text-ink")}
          >
            {own && <Workflow size={12} className="shrink-0" />}
            <span className="truncate">{r.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/** What picks the model and the operation, first in the form's "Model" part. */
export function ModelPicker({ pick, recipe, presets }: { pick: ReturnType<typeof useModelPick>; recipe: RecipeInfo; /** The presets menu, under the model. */ presets: ReactNode }) {
  const { kinds, groups, group, why } = pick;
  if (!group) return null;
  return (
    <>
      <div className="flex flex-col gap-2">
        {kinds.length > 1 && (
          <Segmented
            label="Output type"
            value={recipe.output}
            options={kinds.map((k) => ({ value: k, label: k === "image" ? "Image" : k === "video" ? "Video" : "Audio" }))}
            onChange={pick.pickKind}
          />
        )}
        <div className="flex items-center gap-2">
          <Select
            id="create-model"
            label="Model"
            searchHint="Search your models and workflows"
            className="w-full"
            value={group.key}
            onChange={pick.pickModel}
            options={groups.map((g) => ({
              value: g.key, label: g.name, group: g.builtIn ? "Models" : "Your workflows",
              note: g.recipes.some((r) => !why(r)) ? (pick.notHere(g) ?? `${plural(g.recipes.length, "operation")}`) : pick.notReadyWhy(g),
              detail: g.builtIn ? g.summary : g.recipes.map((r) => r.title).join(" · "), search: g.recipes.map((r) => r.title).join(" "),
              // what each model is for, to compare before picking
              tip: modelHelp(g), tipHead: g.name,
            }))}
          />
          {modelHelp(group, recipe) && <Help title={group.name} text={modelHelp(group, recipe)!} />}
        </div>
      </div>
      {/* its operations: what is built in, then your workflows for it. A few are tabs; many go in a list */}
      {group.recipes.length > 1 && group.recipes.length <= 8 && <Operations group={group} recipe={recipe} why={why} pick={pick.pick} />}
      {group.recipes.length > 8 && (
        <Select
          id="create-operation"
          label="Operation"
          value={recipe.id}
          onChange={pick.pick}
          options={group.recipes.map((r) => ({ value: r.id, label: r.title, detail: r.summary, note: why(r) ? "not ready" : undefined, group: r.imported ? "Your workflows" : "Built in" }))}
        />
      )}
      {/* only what stops it: the description lives in the picker's list and on the operations' hover */}
      {why(recipe) && <span className="text-xs text-warn-ink">{why(recipe)}</span>}
      {presets}
    </>
  );
}
