import type { BuildContext, GraphBuilder, InputSpec, Ref } from "@afflatus/core";

/**
 * A guide picture (ControlNet): the new picture follows the edges, the depth or the pose of another one.
 * Up front: the picture, what to follow, how strongly. Under All settings: when in the sampling it holds,
 * the edge thresholds, the ControlNet file. One "union" ControlNet (xinsir's for SDXL) does every kind, told
 * which by ComfyUI's SetUnionControlNetType; edges are found by ComfyUI itself, depth and pose by the
 * comfyui_controlnet_aux pack; a picture that is already a guide map is taken as it is.
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

export const FOLLOW_EDGES = "Edges";
export const FOLLOW_DEPTH = "Depth";
export const FOLLOW_POSE = "Pose";
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
export const AUX_NEEDED = (what: string) => `Following the ${what.toLowerCase()} of a picture needs the comfyui_controlnet_aux pack, which finds it. Install it with ComfyUI-Manager, follow its edges instead, or give a picture that is already a ${what.toLowerCase()} map.`;
export const GUIDE_NO_MODEL = "A guide picture needs a ControlNet: put one in ComfyUI's models/controlnet folder (xinsir's ControlNet Union SDXL promax does edges, depth and pose; it can be downloaded from Settings).";
/** Which ControlNet a guide starts on: a union one first. */
export const GUIDE_PREFER = ["union.*promax", "union", "xinsir", "."];

export const guideInputs = (union: string): InputSpec[] => [
  { id: "guide", type: "image", role: "guide", label: "Guide picture", optional: true, note: "the new picture follows its edges, depth or pose (ControlNet)" },
  { id: "guideFollows", type: "choice", label: "Follow", options: [FOLLOW_EDGES, FOLLOW_DEPTH, FOLLOW_POSE, FOLLOW_MAP], default: FOLLOW_EDGES, showWhen: "guide", note: "edges keep shapes and outlines; depth keeps what is near and far; pose keeps how people stand" },
  { id: "guideStrength", type: "number", label: "Guide strength", note: "how closely it is followed: 0.5 leaves room, 1 holds tight", min: 0.1, max: 1.5, step: 0.05, default: 0.7, showWhen: "guide" },
  { id: "guideStart", type: "number", label: "Guide from", note: "the part of the sampling it holds: ending early lets the model finish the details freely", min: 0, max: 1, step: 0.05, default: 0, showWhen: "guide", advanced: true },
  { id: "guideEnd", type: "number", label: "Guide until", min: 0, max: 1, step: 0.05, default: 0.8, showWhen: "guide", advanced: true },
  { id: "guideLow", type: "number", label: "Edge low threshold", note: "lower finds fainter edges", min: 0.01, max: 0.99, step: 0.01, default: 0.4, showWhen: { input: "guideFollows", in: [FOLLOW_EDGES] }, advanced: true },
  { id: "guideHigh", type: "number", label: "Edge high threshold", min: 0.01, max: 0.99, step: 0.01, default: 0.8, showWhen: { input: "guideFollows", in: [FOLLOW_EDGES] }, advanced: true },
  { id: "guideModel", type: "choice", label: "ControlNet", note: "a union ControlNet does every kind; another follows only what it was made for", options: { node: "ControlNetLoader", input: "control_net_name" }, default: union, prefer: GUIDE_PREFER, showWhen: "guide", advanced: true },
];

/** The nodes a guide brings in. */
export function guideNodes(input: GuideSettings): string[] {
  if (!input.guide) return [];
  const finds = input.guideFollows === FOLLOW_EDGES ? ["Canny"] : AUX_PREPROCESSOR[input.guideFollows] ? [AUX_NODE] : [];
  return ["LoadImage", "ImageScale", "ControlNetLoader", "SetUnionControlNetType", "ControlNetApplyAdvanced", ...finds];
}

/** Both texts guided by the picture, at the size the picture is drawn at. Unchanged without a guide. */
export function applyGuide(g: GraphBuilder, ctx: BuildContext, cond: { positive: Ref; negative: Ref }, vae: Ref, size: { width: number; height: number }, input: GuideSettings): { positive: Ref; negative: Ref } {
  if (!input.guide) return cond;
  const model = input.guideModel || ctx.slots.controlnet;
  if (!model) throw new Error(GUIDE_NO_MODEL);
  const loaded = g.out("LoadImage", { image: ctx.uploads.guide ?? input.guide });
  let picture = g.out("ImageScale", { image: loaded, upscale_method: "lanczos", width: size.width, height: size.height, crop: "center" });
  if (input.guideFollows === FOLLOW_EDGES) picture = g.out("Canny", { image: picture, low_threshold: input.guideLow, high_threshold: Math.max(input.guideHigh, input.guideLow) });
  else if (AUX_PREPROCESSOR[input.guideFollows]) {
    if (!ctx.has(AUX_NODE)) throw new Error(AUX_NEEDED(input.guideFollows));
    picture = g.out(AUX_NODE, { image: picture, preprocessor: AUX_PREPROCESSOR[input.guideFollows], resolution: Math.min(2048, Math.round(Math.min(size.width, size.height) / 64) * 64) });
  }
  const net = g.out("SetUnionControlNetType", { control_net: g.out("ControlNetLoader", { control_net_name: model }), type: UNION_TYPE[input.guideFollows] ?? "auto" });
  const applied = g.add("ControlNetApplyAdvanced", {
    positive: cond.positive, negative: cond.negative, control_net: net, image: picture, vae,
    strength: input.guideStrength, start_percent: input.guideStart, end_percent: Math.max(input.guideEnd, input.guideStart),
  });
  return { positive: [applied, 0], negative: [applied, 1] };
}
