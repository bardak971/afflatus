import type { Family, Recipe } from "@afflatus/core";
import { flux, fluxEdit, fluxFixFace, fluxOutpaint, fluxPaintOver, fluxPicture, fluxRedraw, fluxSharper } from "./flux";
import { h3 } from "./h3/family";
import { h3LipSync } from "./h3/lipsync";
import { h3Swap } from "./h3/swap";
import { h3SwapMotion } from "./h3/swapMotion";
import { h3MotionTransfer } from "./h3/motionTransfer";
import { h3Video } from "./h3/video";
import { klein } from "./klein/family";
import { ltx } from "./ltx/family";
import { ltxVideo } from "./ltx/video";
import { ltx25 } from "./ltx25/family";
import { ltx25Video } from "./ltx25/video";
import { krea2 } from "./krea2/family";
import { krea2FixFace, krea2PaintOver, krea2Picture, krea2Redraw, krea2Sharper } from "./krea2/recipes";
import { kleinEdit, kleinFixFace, kleinPaintOver, kleinPicture, kleinReshape, kleinSharper, kleinVariation } from "./klein/recipes";
import { sdxl } from "./sdxl/family";
import { sdxlTextToPicture } from "./sdxl/text-to-picture";
import { sdxlFixFace, sdxlOutpaint, sdxlPaintOver, sdxlRedraw, sdxlSharper } from "./sdxl/tools";
import { qwen, qwenEdit, qwenFixFace, qwenOutpaint, qwenPaintOver, qwenPicture, qwenRedraw, qwenSharper } from "./qwen";
import { qwen21, qwen21Edit, qwen21MotionPicture, qwen21Picture } from "./qwen21";
import { scail } from "./scail/family";
import { scailMotion, scailMotion24 } from "./scail/motion";
import { removeBackground, seedvrPicture, tools } from "./tools";
import { wan } from "./wan/family";
import { wanVideo } from "./wan/video";
import { zimage, zimageFixFace, zimageOutpaint, zimagePaintOver, zimagePicture, zimageRedraw, zimageSharper } from "./zimage";

export const families: Family[] = [sdxl, klein, krea2, flux, qwen, qwen21, zimage, h3, wan, scail, ltx, ltx25, tools];

/** Every built-in recipe. Imported workflows are added to this list at run time by the server. */
export const recipes: Recipe<any>[] = [
  sdxlTextToPicture, sdxlRedraw, sdxlPaintOver, sdxlOutpaint, sdxlSharper, sdxlFixFace,
  kleinPicture, kleinEdit, kleinVariation, kleinPaintOver, kleinReshape, kleinSharper, kleinFixFace,
  krea2Picture, krea2Redraw, krea2PaintOver, krea2Sharper, krea2FixFace,
  fluxPicture, fluxEdit, fluxRedraw, fluxPaintOver, fluxOutpaint, fluxSharper, fluxFixFace,
  qwenPicture, qwenEdit, qwenRedraw, qwenPaintOver, qwenOutpaint, qwenSharper, qwenFixFace,
  qwen21Picture, qwen21Edit, qwen21MotionPicture,
  zimagePicture, zimageRedraw, zimagePaintOver, zimageOutpaint, zimageSharper, zimageFixFace,
  h3Video,
  h3LipSync,
  h3Swap,
  h3SwapMotion,
  h3MotionTransfer,
  wanVideo,
  scailMotion,
  scailMotion24,
  ltxVideo,
  ltx25Video,
  removeBackground, seedvrPicture,
];

export const familyById = (id: string) => families.find((f) => f.id === id);
export const recipeById = (id: string) => recipes.find((r) => r.id === id);

export { h3, h3Video, klein, krea2, krea2Picture, sdxl, sdxlTextToPicture, tools, wan, wanVideo };
export { wanCanvas, wanFrames, WAN_FPS } from "./wan/family";
export { ltx, ltxVideo, ltx25, ltx25Video };
export { scail, scailMotion, scailMotion24 };
export { flux, fluxEdit, fluxPicture, qwen, qwenEdit, qwenPicture, qwen21, qwen21Edit, qwen21Picture, zimage, zimagePicture };
export { ltxCanvas, ltxFrames, ltxFramesAt, LTX_FPS } from "./ltx/family";
export { LTX25_FPS } from "./ltx25/family";
export { LTX_REFINE_SIGMAS, LTX_SIGMAS } from "./ltx/video";
export type { LtxVideo } from "./ltx/video";
export type { WanVideo } from "./wan/video";
export { h3Canvas, h3Frames, H3_FPS } from "./h3/family";
export { pixelUpscale, RTX_NODES, seedvrChunk, sharpened, UPSCALE, upscaleNodes } from "./video/upscale";
export { saveVideo } from "./shared/out";
export { AUDIO_LOCK, FACE_REFINE_MASK, FACE_REFINE_NODES, faceRefined, faceRefineNeeds, faceRefineSkipped } from "./h3/faceRefine";
export { h3Prompt, h3ReferencePrompt, isH3Layout } from "./h3/prompt";
export { introduce, kleinSize } from "./klein/common";
export { padsFor } from "./klein/recipes";
export type { H3Video } from "./h3/video";
export type { SdxlTextToPicture } from "./sdxl/text-to-picture";
export { RIFE_GET } from "./shared/finish";
