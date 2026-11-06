import type { GraphBuilder, InputSpec, MediaFacts, Ref } from "@afflatus/core";

/** How far an outpaint extends the picture on each side, and how softly the new part meets it. */
export interface OutpaintSettings {
  /** The aspect ratio the picture is extended to, the picture in the middle; CUSTOM: by the sides as they are set. */
  shape?: string;
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  feathering: number;
}
/** The outpaint's shape that extends the picture by the sides set, not to an aspect ratio. */
const CUSTOM_SHAPE = "Custom";
/** The aspect ratios an outpaint extends a picture to (Klein's, card #275: every family's now). */
export const OUTPAINT_SHAPES = ["Portrait 2:3", "Square 1:1", "Landscape 3:2", "Widescreen 16:9", "Portrait 9:16"];
/**
 * The aspect ratio row: an outpaint extends a picture by the sides (A1111's way) or to a shape (Klein's), and every family does
 * both (card #275). Each starts on what it did before: Klein on 16:9, the others on the sides.
 */
export const shapeInput = (start: string): InputSpec => ({
  id: "shape", type: "choice", label: "Aspect ratio", options: [CUSTOM_SHAPE, ...OUTPAINT_SHAPES], default: start,
  note: "the shape the picture is extended to, the picture staying in the middle. Custom: by the sides set below",
});
const bySides = { input: "shape", in: [CUSTOM_SHAPE] };
export const OUTPAINT_INPUTS: InputSpec[] = [
  shapeInput(CUSTOM_SHAPE),
  { id: "padLeft", type: "number", label: "Extend left", min: 0, max: 1024, step: 8, default: 192, unit: " px", showWhen: bySides },
  { id: "padRight", type: "number", label: "Extend right", min: 0, max: 1024, step: 8, default: 192, unit: " px", showWhen: bySides },
  { id: "padTop", type: "number", label: "Extend up", min: 0, max: 1024, step: 8, default: 0, unit: " px", showWhen: bySides },
  { id: "padBottom", type: "number", label: "Extend down", min: 0, max: 1024, step: 8, default: 0, unit: " px", showWhen: bySides },
  { id: "feathering", type: "number", label: "Feathering", note: "how far into the picture the new part may blend: more hides the seam, less keeps the picture exact", min: 0, max: 256, step: 8, default: 40, unit: " px", advanced: true },
];
/** The room to add around a picture to bring it to a shape ("Widescreen 16:9"), the picture staying in the middle. */
export function padsFor(width: number, height: number, shape: string) {
  const [a, b] = (/(\d+):(\d+)/.exec(shape)?.slice(1) ?? ["1", "1"]).map(Number) as [number, number];
  const r = a / b;
  if (width / height < r) {
    const add = Math.round(height * r) - width;
    return { left: Math.floor(add / 2), right: Math.ceil(add / 2), top: 0, bottom: 0, width: width + add, height };
  }
  const add = Math.round(width / r) - height;
  return { left: 0, right: 0, top: Math.floor(add / 2), bottom: Math.ceil(add / 2), width, height: height + add };
}
/**
 * An outpaint's sides as it is built: those set (Custom, or a form saved before the shape row), or those that bring the
 * picture to the shape picked. A picture already of that shape gets none, which the build says.
 */
function outpaintSides<T extends Omit<OutpaintSettings, "feathering">>(input: T, of: { width?: number; height?: number } | undefined): T {
  if (!input.shape || input.shape === CUSTOM_SHAPE) return input;
  const p = padsFor(of?.width || 1024, of?.height || 1024, input.shape);
  return { ...input, padLeft: p.left, padRight: p.right, padTop: p.top, padBottom: p.bottom };
}
/** What an outpaint says when there is nothing to extend. */
const nothingToExtend = (input: Pick<OutpaintSettings, "shape">) =>
  input.shape && input.shape !== CUSTOM_SHAPE ? `Nothing to extend: the picture is ${input.shape} already.` : "Nothing to extend: set how far the picture grows on at least one side.";
/**
 * How every outpaint starts: its sides (outpaintSides), the picture's size (1024 square when it is not known) and the whole
 * canvas's once grown; nothing to extend is said as the build's error.
 */
export function outpaintPlan<T extends Omit<OutpaintSettings, "feathering">>(form: T, source: MediaFacts | undefined): { input: T; from: { width: number; height: number }; whole: { width: number; height: number } } {
  const from = source?.width ? source : { width: 1024, height: 1024 };
  const input = outpaintSides(form, from);
  if (input.padLeft + input.padRight + input.padTop + input.padBottom === 0) throw new Error(nothingToExtend(input));
  return { input, from, whole: { width: from.width + input.padLeft + input.padRight, height: from.height + input.padTop + input.padBottom } };
}
export const OUTPAINT_NODES = ["LoadImage", "ImagePadForOutpaint", "ImageScale", "MaskToImage", "ImageToMask", "VAEDecode", "PreviewImage"];
/**
 * The picture padded on the sides asked for (grey, with a soft edge into the picture) and scaled to the size the model draws
 * at, as ComfyUI's own outpaint example pads it: the padding node, and the padded picture and its mask at the drawing size,
 * which each family encodes or reads its own way. (Its VAEEncodeForInpaint went: no family sampled it, every one starting from
 * the stretched picture or an edit, and the graph carried it unread.)
 */
export function outpaintPad(g: GraphBuilder, source: Ref, input: OutpaintSettings, size: { width: number; height: number }) {
  const padded = g.add("ImagePadForOutpaint", { image: source, left: input.padLeft, top: input.padTop, right: input.padRight, bottom: input.padBottom, feathering: input.feathering });
  const pixels = g.out("ImageScale", { image: [padded, 0], upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
  const mask = g.out("ImageToMask", { image: g.out("ImageScale", { image: g.out("MaskToImage", { mask: [padded, 1] }), upscale_method: "bilinear", width: size.width, height: size.height, crop: "disabled" }), channel: "red" });
  return { padded, pixels, mask };
}
/** The nodes `pasteBack` and `stretchedFill` bring in (GrowMask besides, for a paste with an inset). */
export const PASTE_BACK_NODES = ["ImageCompositeMasked", "InvertMask", "CropMask", "ImageBlur"];
/**
 * The picture put back over the outpainted result at its own size, faded in through the padding's feathered
 * edge widened once more: the model redraws the whole canvas, which softens the picture. `inset` pulls the
 * edge into the picture and widens the fade, for a result whose join was redrawn by a seam pass.
 */
export function pasteBack(g: GraphBuilder, drawn: Ref, source: Ref, padded: string, from: { width: number; height: number }, input: OutpaintSettings, inset = 0): Ref {
  let edge: Ref = g.out("InvertMask", { mask: [padded, 1] });
  if (inset > 0) edge = g.out("GrowMask", { mask: edge, expand: -inset, tapered_corners: true });
  let soft = g.out("ImageBlur", { image: g.out("MaskToImage", { mask: edge }), blur_radius: 31, sigma: 10 });
  if (inset > 0) soft = g.out("ImageBlur", { image: g.out("ImageBlur", { image: soft, blur_radius: 31, sigma: 10 }), blur_radius: 31, sigma: 10 });
  const own = g.out("CropMask", { mask: g.out("ImageToMask", { image: soft, channel: "red" }), x: input.padLeft, y: input.padTop, width: from.width, height: from.height });
  return g.out("ImageCompositeMasked", { destination: drawn, source, x: input.padLeft, y: input.padTop, resize_source: false, mask: own });
}
/**
 * The padded canvas the new part starts from: the picture stretched over it and blurred, the picture itself
 * on top, at the drawing size. Flat grey is read as a wall or a frame (tried on a real ComfyUI: grey drew a
 * window around the picture, the stretched picture a scene).
 */
export function stretchedFill(g: GraphBuilder, source: Ref, input: OutpaintSettings, whole: { width: number; height: number }, size: { width: number; height: number }): Ref {
  const stretched = g.out("ImageScale", { image: source, upscale_method: "bilinear", width: whole.width, height: whole.height, crop: "disabled" });
  const blurred = g.out("ImageBlur", { image: g.out("ImageBlur", { image: stretched, blur_radius: 31, sigma: 10 }), blur_radius: 31, sigma: 10 });
  const filled = g.out("ImageCompositeMasked", { destination: blurred, source, x: input.padLeft, y: input.padTop, resize_source: false });
  return g.out("ImageScale", { image: filled, upscale_method: "lanczos", width: size.width, height: size.height, crop: "disabled" });
}
