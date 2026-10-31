import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InputSpec } from "@afflatus/core";
import { api, type RecipeInfo } from "../api";
import { sameValue } from "../fields";
import { modelSaved, type FormSetup } from "../form";
import { fileLabel, plural } from "../format";
import { Button, Failed } from "../ui";
import { firstFailed } from "../sayFailed";
import { queryKeys } from "../queryKeys";

/**
 * What belongs to the model, whatever part of the form it is in: how the per-model settings stand against
 * the defaults kept for the model file, with the ways to save them as its defaults, reset them, or forget
 * what was saved.
 */
export function ModelDefaults({ recipe, setup, file, hasSaved, values, defaults, onClear }: {
  recipe: RecipeInfo;
  /** What the form is worked out with (formDefaults'), for what the file starts on with nothing saved. */
  setup: FormSetup;
  /** The model file the defaults are kept for. */
  file: string;
  hasSaved: boolean;
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  onClear(inputs: string[]): void;
}) {
  const client = useQueryClient();
  const perModel = recipe.inputs.filter((i: InputSpec) => i.perModel);
  const differs = perModel.filter((i) => !sameValue(values[i.id], defaults[i.id]));
  const refetch = () => client.invalidateQueries({ queryKey: queryKeys.modelSettings() });
  const save = useMutation({
    // only what differs from the file's start with nothing saved: the rest follows the recipe's defaults as they change
    mutationFn: () => api.saveModelSettings({ family: recipe.family, file, values: modelSaved(recipe, setup, values) }),
    onSuccess: async () => {
      await refetch();
      // they are the model's own now: the draft no longer needs to hold them
      onClear(perModel.map((i) => i.id));
    },
  });
  const forget = useMutation({ mutationFn: () => api.forgetModelSettings(recipe.family, file), onSuccess: refetch });
  const failed = firstFailed([["Model defaults not saved", save], ["Not forgotten", forget]]);
  const model = fileLabel(file) || "this model";
  if (!perModel.length || !file) return null;
  return (
    <div className="flex flex-col gap-2 text-xs text-ink-2">
      <span>
        {differs.length
          ? `${plural(differs.length, "setting")} ${differs.length > 1 ? "differ" : "differs"} from ${model}'s defaults. They apply to this draft only.`
          : hasSaved
            ? `These are the defaults you saved for ${model}.`
            : `No defaults saved for ${model} yet: these are the recipe's.`}
      </span>
      <span className="flex flex-wrap gap-1.5">
        {differs.length > 0 && <Button size="sm" tone="quiet" onClick={() => save.mutate()} disabled={save.isPending} data-tip={`Save these as the defaults of ${model}`}>Save as this model's defaults</Button>}
        {differs.length > 0 && <Button size="sm" onClick={() => onClear(differs.map((i) => i.id))}>Reset all</Button>}
        {hasSaved && !differs.length && <Button size="sm" onClick={() => forget.mutate()} disabled={forget.isPending}>Forget saved defaults</Button>}
      </span>
      {failed && <Failed what={failed.what} error={failed.error} />}
    </div>
  );
}
