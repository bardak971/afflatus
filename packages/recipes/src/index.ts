import type { Family, Recipe } from "@studai/core";
import { h3 } from "./h3/family";
import { h3Video } from "./h3/video";
import { klein } from "./klein/family";
import { kleinEdit, kleinFixFace, kleinPaintOver, kleinPicture, kleinReshape, kleinSharper, kleinVariation } from "./klein/recipes";
import { sdxl } from "./sdxl/family";
import { sdxlTextToPicture } from "./sdxl/text-to-picture";
import { sdxlFixFace, sdxlPaintOver, sdxlRedraw, sdxlSharper } from "./sdxl/tools";
import { removeBackground, tools } from "./tools";

export const families: Family[] = [sdxl, klein, h3, tools];

/** Every built-in recipe. Imported workflows are added to this list at run time by the server. */
export const recipes: Recipe<any>[] = [
  sdxlTextToPicture, sdxlRedraw, sdxlPaintOver, sdxlSharper, sdxlFixFace,
  kleinPicture, kleinEdit, kleinVariation, kleinPaintOver, kleinReshape, kleinSharper, kleinFixFace,
  h3Video,
  removeBackground,
];

export const familyById = (id: string) => families.find((f) => f.id === id);
export const recipeById = (id: string) => recipes.find((r) => r.id === id);

export { h3, h3Video, klein, sdxl, sdxlTextToPicture, tools };
export { h3Canvas, h3Frames, H3_FPS } from "./h3/family";
export { h3Prompt, h3ReferencePrompt, isH3Layout } from "./h3/prompt";
export { introduce, kleinSize } from "./klein/common";
export { padsFor } from "./klein/recipes";
export type { H3Video } from "./h3/video";
export type { SdxlTextToPicture } from "./sdxl/text-to-picture";
