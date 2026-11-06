import { useMemo } from "react";
import { boxEditFamily } from "@afflatus/core";
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

/**
 * Every editor Edit in box can use, turned on or not: the recipes that say they are one (their boxEditor), in the server's
 * order, which is Settings'. A box recipe is hidden (the Stage's alone): it is found by that, never by its id.
 */
export const allBoxEditors = (recipes: readonly RecipeInfo[]): Array<RecipeInfo & { boxEditor: NonNullable<RecipeInfo["boxEditor"]> }> =>
  recipes.filter((r): r is RecipeInfo & { boxEditor: NonNullable<RecipeInfo["boxEditor"]> } => Boolean(r.boxEditor));

/** The instruction editors of the families turned on, in Settings' order, and the one to start on for a picture made by `made`. */
export function useBoxEditors(made: string | undefined): { editors: BoxEditor[]; start: BoxEditor | undefined } {
  const recipes = useRecipes();
  const setup = useSetup();
  const settings = useSettings();
  const { isOn } = useFamilies();
  const asked = settings.data?.boxEditModel;
  return useMemo(() => {
    const all = recipes.data?.recipes ?? [];
    // the one set in Settings, the default while the settings are not read yet (or name one no longer there)
    const chosen = boxEditFamily(all, asked);
    // its family on, as the editor's own would have to be
    const editors = allBoxEditors(all).filter((r) => isOn(r.family)).map((recipe) => ({
      family: recipe.family, recipe, name: recipe.boxEditor.name, ready: Boolean(setup.data?.recipes.find((s) => s.id === recipe.id)?.ready),
    }));
    return { editors, start: startEditor(editors, made, chosen) };
  }, [recipes.data, setup.data, isOn, made, asked]);
}
