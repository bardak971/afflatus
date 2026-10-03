import type { Family, Recipe } from "@afflatus/core";
import { flux, fluxEdit, fluxFixFace, fluxPaintOver, fluxPicture, fluxRedraw, fluxSharper } from "./flux";
import { h3 } from "./h3/family";
import { h3Video } from "./h3/video";
import { klein } from "./klein/family";
import { ltx } from "./ltx/family";
import { ltxVideo } from "./ltx/video";
import { krea2 } from "./krea2/family";
import { krea2FixFace, krea2PaintOver, krea2Picture, krea2Redraw, krea2Sharper } from "./krea2/recipes";
import { kleinEdit, kleinFixFace, kleinPaintOver, kleinPicture, kleinReshape, kleinSharper, kleinVariation } from "./klein/recipes";
import { sdxl } from "./sdxl/family";
import { sdxlTextToPicture } from "./sdxl/text-to-picture";
import { sdxlFixFace, sdxlPaintOver, sdxlRedraw, sdxlSharper } from "./sdxl/tools";
import { qwen, qwenEdit, qwenFixFace, qwenPaintOver, qwenPicture, qwenRedraw, qwenSharper } from "./qwen";
import { removeBackground, tools } from "./tools";
import { wan } from "./wan/family";
import { wanVideo } from "./wan/video";

export const families: Family[] = [sdxl, klein, krea2, flux, qwen, h3, wan, ltx, tools];

/** Every built-in recipe. Imported workflows are added to this list at run time by the server. */
export const recipes: Recipe<any>[] = [
  sdxlTextToPicture, sdxlRedraw, sdxlPaintOver, sdxlSharper, sdxlFixFace,
  kleinPicture, kleinEdit, kleinVariation, kleinPaintOver, kleinReshape, kleinSharper, kleinFixFace,
  krea2Picture, krea2Redraw, krea2PaintOver, krea2Sharper, krea2FixFace,
  fluxPicture, fluxEdit, fluxRedraw, fluxPaintOver, fluxSharper, fluxFixFace,
  qwenPicture, qwenEdit, qwenRedraw, qwenPaintOver, qwenSharper, qwenFixFace,
  h3Video,
  wanVideo,
  ltxVideo,
  removeBackground,
];

export const familyById = (id: string) => families.find((f) => f.id === id);
export const recipeById = (id: string) => recipes.find((r) => r.id === id);

export { h3, h3Video, klein, krea2, krea2Picture, sdxl, sdxlTextToPicture, tools, wan, wanVideo };
export { wanCanvas, wanFrames, WAN_FPS } from "./wan/family";
export { ltx, ltxVideo };
export { flux, fluxEdit, fluxPicture, qwen, qwenEdit, qwenPicture };
export { ltxCanvas, ltxFrames, LTX_FPS } from "./ltx/family";
export { LTX_REFINE_SIGMAS, LTX_SIGMAS } from "./ltx/video";
export type { LtxVideo } from "./ltx/video";
export type { WanVideo } from "./wan/video";
export { h3Canvas, h3Frames, H3_FPS } from "./h3/family";
export { h3Prompt, h3ReferencePrompt, isH3Layout } from "./h3/prompt";
export { introduce, kleinSize } from "./klein/common";
export { padsFor } from "./klein/recipes";
export type { H3Video } from "./h3/video";
export type { SdxlTextToPicture } from "./sdxl/text-to-picture";
