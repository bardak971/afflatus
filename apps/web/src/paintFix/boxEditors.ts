import { useMemo } from "react";
import { BOX_EDIT_DEFAULT, BOX_EDIT_FAMILIES, BOX_EDITOR_NAMES, inBoxOf } from "@afflatus/core";
import type { RecipeInfo } from "../api";
import { useFamilies, useRecipes, useSettings, useSetup } from "../data";

/** An instruction editor Edit in box can use (card #284): its box recipe, its model's name, and whether its files are there. */
export interface BoxEditor {
  family: string;
  recipe: RecipeInfo;
  name: string;
  ready: boolean;
}

/**
 * The editor an Edit in box starts on: the picture's own model's when it edits by instruction (`made`, its family), else the
 * one set in Settings › Models (`chosen`), else the first one whose files are there, else the first. A model not ready
 * stays chosen when it is the picture's own or the one set: the bar says its files are missing rather than switch quietly.
 */
export function startEditor(editors: readonly BoxEditor[], made: string | undefined, chosen: string | undefined): BoxEditor | undefined {
  return editors.find((e) => e.family === made) ?? editors.find((e) => e.family === chosen) ?? editors.find((e) => e.ready) ?? editors[0];
}

/** The instruction editors of the families turned on, in Settings' order, and the one to start on for a picture made by `made`. */
export function useBoxEditors(made: string | undefined): { editors: BoxEditor[]; start: BoxEditor | undefined } {
  const recipes = useRecipes();
  const setup = useSetup();
  const settings = useSettings();
  const { isOn } = useFamilies();
  const chosen = settings.data?.boxEditModel ?? BOX_EDIT_DEFAULT;
  return useMemo(() => {
    const all = recipes.data?.recipes ?? [];
    // a box recipe is hidden (the Stage's alone): it is found by its editor's id, its family on as the editor's would be
    const editors = BOX_EDIT_FAMILIES.flatMap((family) => {
      const recipe = all.find((r) => r.id === inBoxOf(`${family}.edit`));
      if (!recipe || !isOn(family)) return [];
      return [{ family, recipe, name: BOX_EDITOR_NAMES[family], ready: Boolean(setup.data?.recipes.find((s) => s.id === recipe.id)?.ready) }];
    });
    return { editors, start: startEditor(editors, made, chosen) };
  }, [recipes.data, setup.data, isOn, made, chosen]);
}
