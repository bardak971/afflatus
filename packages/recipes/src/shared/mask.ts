import { clampBox, type GraphBuilder, type InputSpec, type MediaFacts } from "@afflatus/core";

/**
 * The part of a picture a mask covers, or all of it when nothing says. The box comes with room around
 * the paint already (the server reads the mask and adds 35 %, at least 48 px, each side): that room is
 * what lets the model see what the new part has to join.
 */
export function boxOf(picture: MediaFacts | undefined, mask: MediaFacts | undefined) {
  const width = picture?.width || mask?.width || 1024;
  const height = picture?.height || mask?.height || 1024;
  const b = mask?.box;
  if (!b) return { x: 0, y: 0, width, height };
  return clampBox(b, { width, height });
}

/**
 * The mask of the part being redone, cut to the box, and a soft version of it for putting the result
 * back: grown a little and blurred, so no seam shows. (Blur works on pictures, hence the round trip.)
 */
export function maskParts(g: GraphBuilder, maskFile: string, box: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }, edge: Partial<MaskSettings> = {}) {
  const mask = g.out("LoadImageMask", { image: maskFile, channel: "red" });
  const cut = g.out("CropMask", { mask, x: box.x, y: box.y, width: box.width, height: box.height });
  const asPicture = g.out("MaskToImage", { mask: cut });
  const sized = g.out("ImageScale", { image: asPicture, upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" });
  const forLatent = g.out("ImageToMask", { image: sized, channel: "red" });
  // left to itself the edge follows the size of the part: about 2% of it, blurred, and grown by half of that
  const picked = Math.min(31, Math.max(4, Math.round(Math.max(box.width, box.height) * 0.02)));
  const feather = edge.maskBlur && edge.maskBlur > 0 ? Math.min(31, Math.round(edge.maskBlur)) : picked;
  const grown = g.out("GrowMask", { mask: cut, expand: edge.maskGrow && edge.maskGrow > 0 ? Math.round(edge.maskGrow) : Math.round(picked / 2), tapered_corners: true });
  const grownPicture = g.out("MaskToImage", { mask: grown });
  const blurred = g.out("ImageBlur", { image: grownPicture, blur_radius: feather, sigma: Math.min(10, feather / 2) });
  const soft = g.out("ImageToMask", { image: blurred, channel: "red" });
  // the same soft edge at the size the part is redrawn at: with Differential Diffusion the model fades the new part in by it
  const softForLatent = g.out("ImageToMask", { image: g.out("ImageScale", { image: blurred, upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" }), channel: "red" });
  return { forLatent, soft, softForLatent };
}
/** How the part that was redone is put back: how far past the mask it reaches, and how soft its edge is. */
export interface MaskSettings {
  maskGrow: number;
  maskBlur: number;
}
export const MASK_INPUTS: InputSpec[] = [
  { id: "maskGrow", type: "number", label: "Mask grow (dilate)", note: "how far past what you painted the new part reaches when it is put back. 0 picks it from the size of the part", min: 0, max: 64, step: 1, default: 0, unit: " px", advanced: true },
  { id: "maskBlur", type: "number", label: "Mask blur", note: "how wide the blend between the new part and the picture is: more hides a seam, less keeps the new part exact. 0 picks it from the size of the part", min: 0, max: 31, step: 1, default: 0, unit: " px", advanced: true },
];

export const MASK_NODES = ["LoadImageMask", "CropMask", "MaskToImage", "ImageToMask", "GrowMask", "ImageBlur", "ImageCrop", "ImageScale", "ImageCompositeMasked", "SetLatentNoiseMask"];
