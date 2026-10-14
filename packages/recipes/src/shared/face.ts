import type { BuildContext, BuiltGraph, GraphBuilder, Ref } from "@afflatus/core";

/**
 * How much the face in what a recipe made is the person it is of (the Afflatus node pack's Face Match: InsightFace's ArcFace,
 * on the CPU): a picture, or a clip read at a few of its frames (the median and the lowest). Against `photos`: a Motion
 * transfer's Picture, an H3 clip's people. Nothing when the node is not there (no insightface in that ComfyUI) or there is no
 * one to compare with: the render is the same either way. Afflatus keeps the figure with the take (queueStore.ts faceOf).
 */
export const FACE_NODE = "AfflatusFaceMatch";

export function faceScore(g: GraphBuilder, ctx: BuildContext, images: Ref, photos: Ref[]): BuiltGraph["outputs"] {
  if (!ctx.has(FACE_NODE) || !photos.length) return [];
  const node = g.add(FACE_NODE, { image: images, samples: 8, ...Object.fromEntries(photos.slice(0, 3).map((photo, i) => [`photo_${i + 1}`, photo])) });
  return [{ node, kind: "image", role: "score" }];
}
