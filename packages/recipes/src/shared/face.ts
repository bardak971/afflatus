import type { BuildContext, BuiltGraph, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

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

/**
 * The cast person's picture a take is scored against, on a model that takes no reference pictures of its own (LTX 2.3, Wan):
 * the cast fills it (compose), the render never sees it. Without it, the take is scored against its first frame's picture.
 */
export const FACE_PHOTO: InputSpec = {
  id: "facePhoto", type: "image", role: "face", label: "Face to score against", optional: true, internal: true,
  note: "the cast person's picture, set by the app: the face along the take is scored against it (Face Match), nothing in the render follows it",
};

/** A picture loaded once: the LoadImage of that file the graph has already (the first frame the clip opens on), else a new one. */
function loadedOnce(g: GraphBuilder, image: string): Ref {
  const had = Object.entries(g.graph).find(([, n]) => n.class_type === "LoadImage" && n.inputs.image === image)?.[0];
  return had ? [had, 0] : g.out("LoadImage", { image });
}

/**
 * Who a take that is not H3's is scored against (LTX, Wan): its people's reference pictures where the form takes them (LTX
 * 2.5's), else the cast person's picture (FACE_PHOTO), else the picture it opens on (`opens`: none for a clip that carries
 * on from another, the clip before's last frame is no photo of anyone). Given what the form has of them, read by the
 * recipe: a form reads only the inputs it has.
 */
export function facePhotos(g: GraphBuilder, ctx: Pick<BuildContext, "uploads">, of: { references?: Array<{ role: string }>; facePhoto?: string; opens?: boolean }): Ref[] {
  const people = (of.references ?? []).flatMap((r, i) => (r.role === "person" && ctx.uploads[`references.${i}`] ? [ctx.uploads[`references.${i}`]!] : []));
  const files = people.length ? people : of.facePhoto && ctx.uploads.facePhoto ? [ctx.uploads.facePhoto] : of.opens && ctx.uploads.start ? [ctx.uploads.start] : [];
  return files.map((image) => loadedOnce(g, image));
}
