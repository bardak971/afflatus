import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

/**
 * A guide picture (ControlNet): the new picture follows the edges, the depth or the pose of another one. The same rows on
 * every family that has one (card #277), in the same words: up front the picture, what to follow, how strongly; under All
 * settings when in the sampling it holds, the edge thresholds, the ControlNet file. Edges are found by ComfyUI itself, depth
 * and pose by the comfyui_controlnet_aux pack; a picture that is already a guide map is taken as it is.
 *
 * What differs between families is how the ControlNet is put on (a GuideWay): a ControlNet on both texts (SDXL's xinsir
 * Union, told which kind by SetUnionControlNetType; FLUX.1's Union Pro 2.0 and Qwen Image's InstantX Union, which read the
 * kind from the picture), or a model patch on the model (Z-Image's Fun ControlNet Union).
 */
export interface GuideSettings {
  guide?: string;
  guideFollows: string;
  guideStrength: number;
  guideStart: number;
  guideEnd: number;
  guideLow: number;
  guideHigh: number;
  guideModel: string;
}

/** How a family puts its ControlNet on, and the file it starts on (its slot's download, so that a pod is sent it). */
export interface GuideWay {
  /** "controlnet": ControlNetApplyAdvanced on both texts; "patch": ZImageFunControlnet on the model. */
  kind: "controlnet" | "patch";
  /** A union ControlNet told which kind it follows by SetUnionControlNetType (xinsir's SDXL Union); the others need not be told. */
  union?: true;
  /** The family's slot for it, and its file's name. */
  slot: string;
  file: string;
  /** Which file of the folder it starts on when its own is not there: the family's, never another family's. */
  prefer: string[];
  /** What to put where when there is none. */
  missing: string;
  /** Where its strength and its end start, when its authors give others than 0.7 and 0.8. */
  strength?: number;
  end?: number;
}

const FOLLOW_EDGES = "Edges";
const FOLLOW_DEPTH = "Depth";
const FOLLOW_POSE = "Pose";
export const FOLLOW_MAP = "Already a guide map";
/** What each kind is called by SetUnionControlNetType. */
const UNION_TYPE: Record<string, string> = {
  [FOLLOW_EDGES]: "canny/lineart/anime_lineart/mlsd",
  [FOLLOW_DEPTH]: "depth",
  [FOLLOW_POSE]: "openpose",
  [FOLLOW_MAP]: "auto",
};
/** comfyui_controlnet_aux's one node for all its preprocessors, and the one it runs for each kind. */
export const AUX_NODE = "AIO_Preprocessor";
const AUX_PREPROCESSOR: Record<string, string> = { [FOLLOW_DEPTH]: "DepthAnythingV2Preprocessor", [FOLLOW_POSE]: "DWPreprocessor" };
const AUX_NEEDED = (what: string) => `Following the ${what.toLowerCase()} of a picture needs the comfyui_controlnet_aux pack, which finds it. Install it with ComfyUI-Manager, follow its edges instead, or give a picture that is already a ${what.toLowerCase()} map.`;

/** The guide rows, for a family's way of putting its ControlNet on. */
export const guideInputs = (way: GuideWay): InputSpec[] => [
  { id: "guide", type: "image", role: "guide", label: "Control image", optional: true, note: "the new picture follows its edges, depth or pose (ControlNet)" },
  { id: "guideFollows", type: "choice", label: "Follow", options: [FOLLOW_EDGES, FOLLOW_DEPTH, FOLLOW_POSE, FOLLOW_MAP], default: FOLLOW_EDGES, showWhen: "guide", note: "edges keep shapes and outlines; depth keeps what is near and far; pose keeps how people stand" },
  { id: "guideStrength", type: "number", label: "ControlNet strength", note: "how closely it is followed: 0.5 leaves room, 1 holds tight", min: 0.1, max: 1.5, step: 0.05, default: way.strength ?? 0.7, showWhen: "guide" },
  { id: "guideStart", type: "number", label: "ControlNet start %", note: "start_percent / end_percent: the part of the sampling it holds. Ending early lets the model finish the details freely", min: 0, max: 1, step: 0.05, default: 0, showWhen: "guide", advanced: true },
  { id: "guideEnd", type: "number", label: "ControlNet end %", min: 0, max: 1, step: 0.05, default: way.end ?? 0.8, showWhen: "guide", advanced: true },
  { id: "guideLow", type: "number", label: "Edge low threshold", note: "lower finds fainter edges", min: 0.01, max: 0.99, step: 0.01, default: 0.4, showWhen: { input: "guideFollows", in: [FOLLOW_EDGES] }, advanced: true },
  { id: "guideHigh", type: "number", label: "Edge high threshold", min: 0.01, max: 0.99, step: 0.01, default: 0.8, showWhen: { input: "guideFollows", in: [FOLLOW_EDGES] }, advanced: true },
  {
    id: "guideModel", type: "choice", label: "ControlNet", note: "a union ControlNet does every kind; another follows only what it was made for",
    options: way.kind === "patch" ? { node: "ModelPatchLoader", input: "name" } : { node: "ControlNetLoader", input: "control_net_name" },
    default: way.file, prefer: way.prefer, showWhen: "guide", advanced: true,
  },
];

/** The nodes a guide brings in. */
export function guideNodes(input: GuideSettings, way: GuideWay): string[] {
  if (!input.guide) return [];
  const finds = input.guideFollows === FOLLOW_EDGES ? ["Canny"] : AUX_PREPROCESSOR[input.guideFollows] ? [AUX_NODE] : [];
  const puts = way.kind === "patch" ? ["ModelPatchLoader", "ZImageFunControlnet"] : ["ControlNetLoader", ...(way.union ? ["SetUnionControlNetType"] : []), "ControlNetApplyAdvanced"];
  return ["LoadImage", "ImageScale", ...puts, ...finds];
}

/**
 * The guide picture's ControlNet file, as a machine is sent it (Recipe.needsWith): the family's slot when the row is left on
 * its download's name. Another file picked in the row is a file of the user's own, sent as picked.
 */
export const guideNeeds = (input: Partial<GuideSettings>, way: GuideWay): string[] => (input.guide && (!input.guideModel || input.guideModel === way.file) ? [way.slot] : []);

/**
 * The model and both texts guided by the picture, drawn at `size`: a ControlNet on the texts, or a patch on the model. All
 * three unchanged without a guide, and nothing loaded.
 */
export function applyGuide(g: GraphBuilder, ctx: BuildContext, way: GuideWay, at: { model: Ref; positive: Ref; negative: Ref }, vae: Ref, size: { width: number; height: number }, input: GuideSettings): { model: Ref; positive: Ref; negative: Ref; loads: string[] } {
  if (!input.guide) return { ...at, loads: [] };
  const file = (input.guideModel === way.file ? ctx.slots[way.slot] : undefined) || input.guideModel || ctx.slots[way.slot];
  if (!file) throw new Error(way.missing);
  const loaded = g.out("LoadImage", { image: ctx.uploads.guide ?? input.guide });
  let picture = g.out("ImageScale", { image: loaded, upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" });
  // the guide map worked out from the picture: the status says Processing, not Loading model, while it runs
  const was = g.at;
  g.phase("processing");
  if (input.guideFollows === FOLLOW_EDGES) picture = g.out("Canny", { image: picture, low_threshold: input.guideLow, high_threshold: Math.max(input.guideHigh, input.guideLow) });
  else if (AUX_PREPROCESSOR[input.guideFollows]) {
    if (!ctx.has(AUX_NODE)) throw new Error(AUX_NEEDED(input.guideFollows));
    picture = g.out(AUX_NODE, { image: picture, preprocessor: AUX_PREPROCESSOR[input.guideFollows], resolution: Math.min(2048, Math.round(Math.min(size.width, size.height) / 64) * 64) });
  }
  g.phase(was);
  const hold = { start_percent: input.guideStart, end_percent: Math.max(input.guideEnd, input.guideStart) };
  if (way.kind === "patch") {
    // Z-Image's Fun ControlNet reads the picture beside the model, as ComfyUI's template for it has it
    const model = g.out("ZImageFunControlnet", { model: at.model, model_patch: g.out("ModelPatchLoader", { name: file }), vae, strength: input.guideStrength, image: picture, ...hold });
    return { model, positive: at.positive, negative: at.negative, loads: [`model_patches/${file}`] };
  }
  const loadedNet = g.out("ControlNetLoader", { control_net_name: file });
  const net = way.union ? g.out("SetUnionControlNetType", { control_net: loadedNet, type: UNION_TYPE[input.guideFollows] ?? "auto" }) : loadedNet;
  const applied = g.add("ControlNetApplyAdvanced", { positive: at.positive, negative: at.negative, control_net: net, image: picture, vae, strength: input.guideStrength, ...hold });
  return { model: at.model, positive: [applied, 0], negative: [applied, 1], loads: [`controlnet/${file}`] };
}
