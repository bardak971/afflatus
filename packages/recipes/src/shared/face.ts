import type { BuildContext, BuiltGraph, GraphBuilder, Ref } from "@afflatus/core";

/**
 * How much the face in what a recipe made is the person it is of (the Afflatus node pack's Face Match: InsightFace's ArcFace,
 * on the CPU): a picture, or a clip read at a few of its frames (the median and the lowest). Against `photos`: a Motion
 * transfer's Picture, an H3 clip's people. Nothing when the node is not there (no insightface in that ComfyUI) or there is no
 * one to compare with: the render is the same either way. Afflatus keeps the figure with the take (queueStore.ts faceOf).
 */
export const FACE_NODE = "AfflatusFaceMatch";
/**
 * The same for a picture made from a frame (pack 0.17.0 on): the face where the frame's main person stands, and how many
 * copies of the person are elsewhere. Face Match's best face anywhere ranked a picture with the person pasted in beside the
 * one kept as a good one (HANDOVER-motion-picture-report.md).
 */
export const FACE_AT_NODE = "AfflatusFaceAt";

export function faceScore(g: GraphBuilder, ctx: BuildContext, images: Ref, photos: Ref[], frame?: Ref): BuiltGraph["outputs"] {
  if (!photos.length) return [];
  const asPhotos = Object.fromEntries(photos.slice(0, 3).map((photo, i) => [`photo_${i + 1}`, photo]));
  // an older pack has Face Match only: the best face anywhere, as before
  if (frame && ctx.has(FACE_AT_NODE)) return [{ node: g.add(FACE_AT_NODE, { image: images, frame, ...asPhotos }), kind: "image", role: "score" }];
  if (!ctx.has(FACE_NODE)) return [];
  return [{ node: g.add(FACE_NODE, { image: images, samples: 8, ...asPhotos }), kind: "image", role: "score" }];
}
