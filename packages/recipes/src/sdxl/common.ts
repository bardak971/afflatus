import { roundTo, withQuality, type BuildContext, type GraphBuilder, type InputSpec, type LoraValue, type Ref } from "@afflatus/core";
import { DEFAULT_NEGATIVE, SDXL_NETS, SDXL_UNION } from "./family";

/** What every SDXL recipe that works on a picture asks for besides its own inputs. */
export interface SdxlBase {
  /** Tags put in front of the prompt on every render with this model. */
  quality: string;
  negative: string;
  checkpoint: string;
  loras: LoraValue[];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  prediction: string;
  rescale: number;
  seed: number;
}

const PREDICTION_AUTO = "Auto";
const V_PRED = "v-prediction (zsnr)";
/** Whether a checkpoint is a v-prediction one: said on the form, else read from its name (NoobAI's v-pred files say so). */
export const isVPred = (input: Pick<SdxlBase, "checkpoint" | "prediction">) => input.prediction === V_PRED || (input.prediction === PREDICTION_AUTO && /v.?pred/i.test(input.checkpoint.split(/[\\/]/).pop() ?? ""));
/** The nodes a v-prediction checkpoint is sampled through. */
export const PREDICTION_NODES = ["ModelSamplingDiscrete", "RescaleCFG"];

/** The sampling rows of the picture forms (pictureForm) that SDXL's do not take. */
export const SDXL_DROPS = {
  shift: "an SDXL checkpoint is not a flow model: it has no shift",
  precision: "a checkpoint is loaded whole by CheckpointLoaderSimple, which has no weight precision",
};
/**
 * A v-prediction checkpoint (NoobAI v-pred and merges of it) sampled as one: ComfyUI only knows when the
 * file says so in its metadata, and many merges do not, which comes out as a grey, washed picture. The
 * CFG is rescaled as those checkpoints' authors recommend.
 */
function withPrediction(g: GraphBuilder, model: Ref, input: Pick<SdxlBase, "checkpoint" | "prediction" | "rescale">): Ref {
  if (!isVPred(input)) return model;
  model = g.out("ModelSamplingDiscrete", { model, sampling: "v_prediction", zsnr: true });
  return input.rescale > 0 ? g.out("RescaleCFG", { model, multiplier: input.rescale }) : model;
}

/** The model and the LoRAs: what is asked up front. */
export const modelInputs: InputSpec[] = [
  { id: "checkpoint", type: "model", label: "Checkpoint", folder: "checkpoints" },
  { id: "loras", type: "loras", label: "LoRAs", max: 8 },
];

/** How it samples: folded into "All settings", remembered per model. */
export const samplingInputs = (steps = 28): InputSpec[] => [
  { id: "negative", type: "prompt", label: "Negative prompt", style: "tags", optional: true, default: DEFAULT_NEGATIVE, advanced: true, perModel: true },
  { id: "quality", type: "prompt", label: "Quality tags", note: "put in front of the prompt on every render with this checkpoint", style: "tags", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", min: 1, max: 100, step: 1, default: steps, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "CFG scale", note: "how closely it follows the prompt", min: 1, max: 20, step: 0.5, default: 5, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler_ancestral", advanced: true, perModel: true },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "normal", advanced: true, perModel: true },
  { id: "clipSkip", type: "number", label: "Clip skip", note: "1 = SDXL's own, which is already the second-last layer: what Civitai calls \"clip skip 2\" (Pony, Illustrious). Only raise it when a checkpoint's card asks for more than that", min: 1, max: 4, step: 1, default: 1, advanced: true, perModel: true },
  ...PREDICTION_INPUTS,
  { id: "seed", type: "seed", label: "Seed" },
];

/** Which prediction a checkpoint was trained for: read from its name, or said. */
const PREDICTION_INPUTS: InputSpec[] = [
  {
    id: "prediction", type: "choice", label: "Prediction", options: [PREDICTION_AUTO, "epsilon", V_PRED], default: PREDICTION_AUTO, advanced: true, perModel: true,
    note: "v-prediction for NoobAI v-pred and its merges (Auto reads \"vpred\" in the file name): without it they come out grey and washed. Epsilon is every other SDXL checkpoint",
  },
  { id: "rescale", type: "number", label: "Rescale CFG", min: 0, max: 1, step: 0.05, default: 0.7, showWhen: { input: "prediction", in: [V_PRED] }, advanced: true, perModel: true, note: "0.7 is what the v-pred checkpoints' authors recommend; 0 turns it off" },
];

/** The node classes loadSdxl() uses for these inputs. */
export const modelNodes = (input: SdxlBase) => [
  "CheckpointLoaderSimple", "CLIPTextEncode",
  ...(input.loras.some((l) => l.weight !== 0) ? ["LoraLoader"] : []),
  ...(input.clipSkip > 1 ? ["CLIPSetLastLayer"] : []),
  ...(isVPred(input) ? (input.rescale > 0 ? PREDICTION_NODES : ["ModelSamplingDiscrete"]) : []),
];

/** Checkpoint, LoRAs, clip skip, and both texts read. */
export function loadSdxl(g: GraphBuilder, input: SdxlBase, prompt: string) {
  const ckpt = g.add("CheckpointLoaderSimple", { ckpt_name: input.checkpoint });
  let model: Ref = [ckpt, 0];
  let clip: Ref = [ckpt, 1];
  const vae: Ref = [ckpt, 2];
  for (const l of input.loras) {
    if (l.weight === 0) continue;
    const n = g.add("LoraLoader", { model, clip, lora_name: l.file, strength_model: l.weight, strength_clip: l.weight });
    model = [n, 0];
    clip = [n, 1];
  }
  // N = stop at the Nth-last layer; SDXL's own default is already the second-last
  if (input.clipSkip > 1) clip = g.out("CLIPSetLastLayer", { clip, stop_at_clip_layer: -input.clipSkip });
  model = withPrediction(g, model, input);
  const positive = g.out("CLIPTextEncode", { text: withQuality(input.quality, prompt), clip });
  const negative = g.out("CLIPTextEncode", { text: input.negative, clip });
  return { model, clip, vae, positive, negative };
}

/** What a KSampler takes from the form, besides its latent, steps and strength. */
export const samplerOf = (input: SdxlBase, m: ReturnType<typeof loadSdxl>, ctx: BuildContext) => ({
  model: m.model, positive: m.positive, negative: m.negative, seed: ctx.seed, cfg: input.cfg, sampler_name: input.sampler, scheduler: input.scheduler,
});

/** SDXL draws best near 1024 × 1024: a picture is worked on at its own shape, at about that many pixels. */
export const SDXL_AREA = 1024 * 1024;

/** The size a picture (or a part of one) is redrawn at: its shape, at about `area` pixels, enlarged at most `maxScale` times. */
export function workSize(of: { width: number; height: number } | undefined, area = SDXL_AREA, maxScale = 3) {
  if (!of?.width || !of.height) return { width: 1024, height: 1024 };
  const ideal = Math.min(maxScale, Math.max(0.25, Math.sqrt(area / (of.width * of.height))));
  // already about that size: left as it is, a resize of a few percent only softens it
  const s = ideal > 0.9 && ideal < 1.12 ? 1 : ideal;
  return { width: roundTo(of.width * s, 8, 64), height: roundTo(of.height * s, 8, 64) };
}

/** A union ControlNet's repaint mode (xinsir's ProMax), which guides a part that is painted in to fit the picture around it. */
export interface RepaintSettings {
  repaint: boolean;
  repaintModel: string;
}
export const repaintInputs = (note: string): InputSpec[] => [
  { id: "repaint", type: "toggle", label: "ControlNet repaint", default: true, advanced: true, note },
  { id: "repaintModel", type: "choice", label: "ControlNet", options: { node: "ControlNetLoader", input: "control_net_name" }, default: SDXL_UNION, prefer: SDXL_NETS.slice(0, 2), showWhen: "repaint", advanced: true },
];
/** The nodes the repaint guidance brings in: optional, a recipe draws without it when they are not there. */
export const REPAINT_NODES = ["ControlNetLoader", "SetUnionControlNetType", "InpaintPreprocessor", "ControlNetApplyAdvanced"];
/** Only a union ControlNet has a repaint mode, and the aux pack marks the part to paint the way xinsir's expects. */
export const repaints = (input: Partial<RepaintSettings>, ctx: BuildContext) =>
  !!input.repaint && /union/i.test(input.repaintModel ?? "") && ctx.has("InpaintPreprocessor") && ctx.has("SetUnionControlNetType");
/**
 * The prompt's conditioning guided by the union ControlNet in repaint mode. The hint is the picture the model
 * works on with the part to paint blacked out, at the size it is drawn at and never scaled after: a scaled
 * black edge rings, and is drawn as a line (learned on outpaint). `mask` is the hard mask at that size.
 */
export function repaintGuided(g: GraphBuilder, m: { positive: Ref; negative: Ref; vae: Ref }, input: RepaintSettings, image: Ref, mask: Ref) {
  const net = g.out("SetUnionControlNetType", { control_net: g.out("ControlNetLoader", { control_net_name: input.repaintModel }), type: "repaint" });
  const hint = g.out("InpaintPreprocessor", { image, mask, black_pixel_for_xinsir_cn: true });
  const applied = g.add("ControlNetApplyAdvanced", { positive: m.positive, negative: m.negative, control_net: net, image: hint, strength: 1, start_percent: 0, end_percent: 1, vae: m.vae });
  return { positive: [applied, 0] as Ref, negative: [applied, 1] as Ref };
}

/**
 * What a checkpoint starts on the first time it is used, by its line: the settings its authors give.
 * Pony wants its score tags and a high CFG; Illustrious and NoobAI their quality tags; a NoobAI v-pred
 * checkpoint runs on euler only, at a low CFG. Clip skip stays at 1: ComfyUI's SDXL encoders already
 * read the second-last layer, which is what these cards call "clip skip 2".
 * Few-step checkpoints (DMD2, LCM, Lightning, Hyper, Turbo merges) come first: on the usual 28 steps at
 * CFG 5 they burn. Their sampling is taken from them and the lineage's tags from the entry after; their
 * hires pass runs a few steps too, not the full model's 15.
 */
export const SDXL_PRESETS = [
  {
    match: "dmd|(^|[^a-z])lcm([^a-z]|$)",
    // sgm_uniform, as DMD2's card and ComfyUI's LCM example give it
    values: { sampler: "lcm", scheduler: "sgm_uniform", steps: 8, cfg: 1, hiresSteps: 4 },
    note: "DMD2 / LCM: few steps, lcm sgm_uniform at CFG 1",
  },
  // A Lightning or Hyper file made for 2 or 4 steps says so in its name ("sdxl_lightning_4step"): that count,
  // ahead of the 8 the line's other files take. 1 step wants a sampler of its own (TCD) and is left to the user.
  ...[2, 4].map((n) => ({
    match: `^(?=.*(lightning|hyper[\\s._-]?(sd|\\d)))(?=.*(^|[^0-9])${n}[ _-]?steps?([^a-z]|$))`,
    values: { steps: n },
    note: `a ${n}-step file: ${n} steps`,
  })),
  {
    match: "lightning|hyper[\\s._-]?(sd|\\d)",
    values: { sampler: "euler", scheduler: "sgm_uniform", steps: 8, cfg: 1, hiresSteps: 4 },
    note: "Lightning / Hyper: few steps, euler sgm_uniform at CFG 1",
  },
  {
    match: "turbo",
    values: { sampler: "dpmpp_sde", scheduler: "karras", steps: 8, cfg: 2, hiresSteps: 4 },
    note: "Turbo merge: few steps, DPM++ SDE Karras at CFG 2",
  },
  {
    match: "noob.*v.?pred|v.?pred.*noob|vpred",
    values: { sampler: "euler", scheduler: "normal", cfg: 4.5, steps: 30, quality: "masterpiece, best quality, newest, absurdres, highres", negative: `${DEFAULT_NEGATIVE}, old, early`, prediction: V_PRED },
    note: "NoobAI v-pred: euler (other samplers break on it), CFG 4 to 5, its quality tags",
  },
  {
    match: "pony|(^|[^a-z])pdxl([^a-z]|$)",
    values: { cfg: 7, sampler: "euler_ancestral", scheduler: "normal", steps: 25, quality: "score_9, score_8_up, score_7_up, score_6_up, score_5_up, score_4_up" },
    note: "Pony: its score tags up front and CFG 7, as its card says",
  },
  {
    match: "illustrious|noob|(^|[^a-z])(il[\\s._-]?xl|illu|nai[\\s._-]?xl)([^a-z]|$)",
    values: { cfg: 5.5, sampler: "euler_ancestral", scheduler: "normal", steps: 28, quality: "masterpiece, best quality, absurdres" },
    note: "Illustrious / NoobAI: euler a, CFG 5 to 7, its quality tags",
  },
  {
    match: "animagine",
    // Animagine XL 4.0's card: CFG 5 and its own quality tags (it was trained on "high score" and "great score")
    values: { cfg: 5, sampler: "euler_ancestral", scheduler: "normal", steps: 28, quality: "masterpiece, high score, great score, absurdres" },
    note: "Animagine: euler a, CFG 4 to 7, its quality tags",
  },
];
