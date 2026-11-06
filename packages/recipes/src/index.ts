import type { Family, Recipe } from "@afflatus/core";
import { flux, fluxEdit, fluxFixFace, fluxOutpaint, fluxPaintOver, fluxPicture, fluxRedraw, fluxSharper } from "./flux";
import { h3 } from "./h3/family";
import { h3LipSync } from "./h3/lipsync";
import { h3Swap } from "./h3/swap";
import { h3MotionTransfer } from "./h3/motionTransfer";
import { h3Video } from "./h3/video";
import { klein } from "./klein/family";
import { ltx } from "./ltx/family";
import { ltxLipSync, ltxVideo } from "./ltx/video";
import { ltx25 } from "./ltx25/family";
import { ltx25LipSync, ltx25Video } from "./ltx25/video";
import { krea2 } from "./krea2/family";
import { krea2FixFace, krea2Outpaint, krea2PaintOver, krea2Picture, krea2Redraw, krea2Sharper } from "./krea2/recipes";
import { kleinEdit, kleinFixFace, kleinPaintOver, kleinPicture, kleinRedraw, kleinReshape, kleinSharper, kleinVariation } from "./klein/recipes";
import { sdxl } from "./sdxl/family";
import { sdxlTextToPicture } from "./sdxl/text-to-picture";
import { sdxlFixFace, sdxlOutpaint, sdxlPaintOver, sdxlRedraw, sdxlSharper } from "./sdxl/tools";
import { qwen, qwenEdit, qwenFixFace, qwenOutpaint, qwenPaintOver, qwenPicture, qwenRedraw, qwenSharper } from "./qwen";
import { qwen21, qwen21Edit, qwen21FixFace, qwen21MotionPicture, qwen21Outpaint, qwen21PaintOver, qwen21Picture, qwen21Redraw, qwen21Sharper } from "./qwen21";
import { scail } from "./scail/family";
import { scailMotion, scailMotion24 } from "./scail/motion";
import { removeBackground, seedvrPicture, tools } from "./tools";
import { findMask } from "./tools/findMask";
import { wan } from "./wan/family";
import { wanVideo } from "./wan/video";
import { zimage, zimageFixFace, zimageOutpaint, zimagePaintOver, zimagePicture, zimageRedraw, zimageSharper } from "./zimage";
import { moss, mossPicture } from "./moss";
import { areaSize, inBox, kontextSize } from "./shared/boxEdit";

/**
 * The instruction editors' Edit in box (card #284), in the order Settings and the Stage's bar offer them, each named as
 * they say it and reading its crop at the size it would bring a picture to itself: Kontext's sizes for Kontext and Qwen
 * Image Edit (both read through FluxKontextImageScale), a megapixel on a grid of 16 for Klein, the Working size on a grid
 * of 32 for Qwen Image 2.1 (a megapixel at its 0, "as it is", which a small crop is not).
 */
export const editsInBox = [
  inBox(qwen21Edit, { name: "Qwen Image 2.1" }, (input) => areaSize((input.resolution > 0 ? input.resolution : 1024) ** 2, 32)),
  // the default, Turbo on. The pod A/B of card #284 (2026-11-04, an A40: a deer, a bicycle, a lamp removed, three boxes in
  // one go): Qwen Image Edit with its Lightning LoRA put each thing in its box in the scene's light, removed the lamp, and
  // took 14 to 25 s a box; Qwen Image 2.1 left the lamp where it was, Klein's deer looked cut out, Qwen Image Edit's full
  // 40 steps took about 170 s
  inBox(qwenEdit, { name: "Qwen Image Edit", default: true }, () => kontextSize, { fast: true }),
  inBox(kleinEdit, { name: "FLUX.2 Klein" }, () => areaSize(1024 * 1024, 16)),
  inBox(fluxEdit, { name: "FLUX.1 Kontext" }, () => kontextSize),
];

export const families: Family[] = [sdxl, klein, krea2, flux, qwen, qwen21, zimage, moss, h3, wan, scail, ltx, ltx25, tools];

/** Every built-in recipe. Imported workflows are added to this list at run time by the server. */
export const recipes: Recipe<any>[] = [
  sdxlTextToPicture, sdxlRedraw, sdxlPaintOver, sdxlOutpaint, sdxlSharper, sdxlFixFace,
  kleinPicture, kleinEdit, kleinRedraw, kleinVariation, kleinPaintOver, kleinReshape, kleinSharper, kleinFixFace,
  krea2Picture, krea2Redraw, krea2PaintOver, krea2Outpaint, krea2Sharper, krea2FixFace,
  fluxPicture, fluxEdit, fluxRedraw, fluxPaintOver, fluxOutpaint, fluxSharper, fluxFixFace,
  qwenPicture, qwenEdit, qwenRedraw, qwenPaintOver, qwenOutpaint, qwenSharper, qwenFixFace,
  qwen21Picture, qwen21Edit, qwen21Redraw, qwen21PaintOver, qwen21Outpaint, qwen21Sharper, qwen21FixFace, qwen21MotionPicture,
  zimagePicture, zimageRedraw, zimagePaintOver, zimageOutpaint, zimageSharper, zimageFixFace,
  mossPicture,
  h3Video,
  h3LipSync,
  h3Swap,
  h3MotionTransfer,
  wanVideo,
  scailMotion,
  scailMotion24,
  ltxVideo,
  ltxLipSync,
  ltx25Video,
  ltx25LipSync,
  removeBackground, seedvrPicture, findMask,
  ...editsInBox,
];

export const familyById = (id: string) => families.find((f) => f.id === id);
export const recipeById = (id: string) => recipes.find((r) => r.id === id);

export { h3, h3Video, klein, krea2, krea2Picture, sdxl, sdxlTextToPicture, tools, wan, wanVideo };
export { wanCanvas, wanFrames, WAN_FPS } from "./wan/family";
export { ltx, ltxLipSync, ltxVideo, ltx25, ltx25LipSync, ltx25Video };
export { scail, scailMotion, scailMotion24 };
export { flux, fluxEdit, fluxPicture, qwen, qwenEdit, qwenPicture, qwen21, qwen21Edit, qwen21Picture, zimage, zimagePicture };
export { ltxCanvas, ltxFrames, ltxFramesAt, LTX_FPS } from "./ltx/family";
export { LTX25_FPS } from "./ltx25/family";
export { LTX_REFINE_SIGMAS, LTX_SIGMAS } from "./ltx/video";
export type { LtxVideo } from "./ltx/video";
export type { WanVideo } from "./wan/video";
export { h3Canvas, h3Frames, H3_FPS } from "./h3/family";
export { FIND_MASK, pointsText } from "./tools/findMask";
export { isSeedvr7b, pixelUpscale, RTX_NODES, seedvrChunk, seedvrWindow, sharpened, UPSCALE, upscaleNodes } from "./video/upscale";
export { saveVideo } from "./shared/out";
export { AUDIO_LOCK, FACE_REFINE_MASK, FACE_REFINE_NODES, faceModelOf, faceRefined, faceRefineNeeds, faceRefineSkipped } from "./h3/faceRefine";
export { h3Prompt, h3ReferencePrompt, isH3Layout } from "./h3/prompt";
export { introduce, kleinSize } from "./klein/common";
export { padsFor } from "./shared/outpaint";
export type { H3Video } from "./h3/video";
export type { SdxlTextToPicture } from "./sdxl/text-to-picture";
export { RIFE_GET } from "./shared/finish";
