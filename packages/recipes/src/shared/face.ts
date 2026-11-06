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

/** The face detailer's own settings: the same whichever model redraws the face. */
export interface FaceSettings {
  faceThreshold: number;
  faceCrop: number;
  faceGrow: number;
  faceSize: number;
  faceMax: number;
  faceFeather: number;
}
/**
 * The steps a face refine redraws each face in, on every family (card #275; SDXL's rule before): the form's, at least 8 and
 * at most 30. A crop redrawn at a denoise of about 0.4 runs that share of them: fewer than 8 (a distilled model's 4, Turbo's)
 * leaves it two or three steps, too few to draw a face; more than 30 (Qwen Image's 50) is time a crop does not need.
 */
export const faceSteps = (steps: number) => Math.min(30, Math.max(8, steps));
/**
 * The steps a face pass takes on a model file distilled to a few steps (FlowSpec.distilled), else faceSteps: its share of the
 * model's own steps for the denoise, rounded down, so that they are never closer together than the model was distilled for;
 * two at least, for a pass to correct its first. Qwen Image 2.1 Turbo at 0.4 on a pod (card #286): 3 steps gave clean skin,
 * as the full model's 30 did; 4 left a faint grain, 5 more, 8 (faceSteps) the most. Every face pass of a family reads this
 * one rule, Face refine's and a txt2img's Detail face alike (card #303).
 */
export const faceStepsFor = (steps: number, denoise: number, distilled: boolean) => (distilled ? Math.max(2, Math.floor(steps * denoise + 1e-9)) : faceSteps(steps));
/** What a face detailer's job says when it found no face: ComfyUI says nothing, and the picture comes out as it went in. */
export const NO_FACE = "No face found: the picture is as it was (a lower Detection threshold finds more).";
export const FACE_INPUTS: InputSpec[] = [
  { id: "faceThreshold", type: "number", label: "Detection threshold", note: "how sure the detector must be that it is a face. Lower finds more: small or turned faces, and more mistakes", min: 0.1, max: 0.95, step: 0.05, default: 0.5, advanced: true },
  { id: "faceCrop", type: "number", label: "Face crop factor", note: "how much around the face is redrawn with it, in face sizes: 3 takes in the hair and the neck", min: 1, max: 6, step: 0.5, default: 3, unit: "×", advanced: true },
  { id: "faceGrow", type: "number", label: "Face mask dilation", note: "the area that is found, made larger by this much before it is redrawn", min: 0, max: 64, step: 1, default: 10, unit: " px", advanced: true },
  { id: "faceSize", type: "number", label: "Face guide size", note: "the crop around the face (the face and its crop factor) is redrawn at this size, as ADetailer does: 1024 is what SDXL draws best; larger is slower", min: 256, max: 1536, step: 64, default: 1024, unit: " px", advanced: true },
  { id: "faceMax", type: "number", label: "Face max size", note: "a crop larger than this is brought down to it", min: 512, max: 2048, step: 64, default: 1280, unit: " px", advanced: true },
  { id: "faceFeather", type: "number", label: "Mask feather", note: "how softly the redrawn face is blended back", min: 0, max: 64, step: 1, default: 5, unit: " px", advanced: true },
];
