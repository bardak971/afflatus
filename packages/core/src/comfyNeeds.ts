import { parseInput, type Family, type Recipe } from "./recipe";
import { compareVersions } from "./versions";

/**
 * ComfyUI's own node types the built-in forms use, by the release that brought each (its first tag whose nodes.py or
 * comfy_extras registers it, read from ComfyUI's git history up to v0.42.5, 2026-10-28). "0.0.1" is the first tag: there
 * since before ComfyUI had versions. No custom node pack brings these: a ComfyUI that lacks one is updated, not given a
 * pack (a test holds the list against the node catalog in reference/, by each node's python_module).
 */
const CORE_SINCE_TABLE: Array<[string, string[]]> = [
  ["0.0.1", ["BasicGuider", "BasicScheduler", "CFGGuider", "CLIPLoader", "CLIPSetLastLayer", "CLIPTextEncode", "CLIPVisionEncode", "CLIPVisionLoader", "Canny", "CheckpointLoaderSimple", "ConditioningZeroOut", "ControlNetApplyAdvanced", "ControlNetLoader", "CropMask", "DifferentialDiffusion", "DisableNoise", "DualCLIPLoader", "EmptyLatentImage", "EmptySD3LatentImage", "GrowMask", "ImageBatch", "ImageBlend", "ImageBlur", "ImageCompositeMasked", "ImageCrop", "ImageFromBatch", "ImagePadForOutpaint", "ImageScale", "ImageScaleToTotalPixels", "ImageToMask", "ImageUpscaleWithModel", "InvertMask", "JoinImageWithAlpha", "KSampler", "KSamplerAdvanced", "KSamplerSelect", "KarrasScheduler", "LatentCompositeMasked", "LatentUpscale", "LoadAudio", "LoadImage", "LoadImageMask", "LoraLoader", "LoraLoaderModelOnly", "MaskComposite", "MaskToImage", "ModelSamplingAuraFlow", "ModelSamplingDiscrete", "ModelSamplingSD3", "PreviewImage", "RandomNoise", "RebatchImages", "RepeatImageBatch", "RescaleCFG", "SamplerCustom", "SamplerCustomAdvanced", "SetLatentNoiseMask", "SolidMask", "SplitSigmas", "SplitSigmasDenoise", "StyleModelApply", "StyleModelLoader", "UNETLoader", "UpscaleModelLoader", "VAEDecode", "VAEDecodeAudio", "VAEDecodeTiled", "VAEEncode", "VAEEncodeForInpaint", "VAEEncodeTiled", "VAELoader"]],
  ["0.0.3", ["SetUnionControlNetType"]],
  ["0.0.4", ["FluxGuidance", "ModelSamplingFlux"]],
  ["0.2.3", ["TorchCompileModel"]],
  ["0.2.4", ["LatentApplyOperationCFG", "LatentOperationSharpen"]],
  ["0.3.2", ["EmptyLTXVLatentVideo", "LTXVConditioning", "LTXVScheduler"]],
  ["0.3.8", ["EmptyHunyuanLatentVideo"]],
  ["0.3.16", ["WanImageToVideo"]],
  ["0.3.20", ["LTXVAddGuide", "LTXVCropGuides", "LTXVPreprocess"]],
  ["0.3.29", ["WanFirstLastFrameToVideo"]],
  ["0.3.31", ["CreateVideo", "GetVideoComponents", "LoadVideo", "SaveVideo"]],
  ["0.3.35", ["ImageAddNoise"]],
  ["0.3.42", ["FluxKontextImageScale", "ReferenceLatent"]],
  ["0.3.45", ["CFGNorm"]],
  ["0.3.51", ["FluxKontextMultiReferenceLatentMethod"]],
  ["0.3.52", ["ModelPatchLoader"]],
  ["0.3.60", ["TextEncodeQwenImageEditPlus"]],
  ["0.3.61", ["AudioAdjustVolume", "AudioConcat", "AudioMerge", "EmptyAudio", "TrimAudioDuration"]],
  ["0.3.71", ["LatentUpscaleModelLoader"]],
  ["0.3.72", ["EmptyFlux2LatentImage", "Flux2Scheduler"]],
  ["0.5.0", ["ZImageFunControlnet"]],
  ["0.7.0", ["ManualSigmas"]],
  ["0.8.0", ["LTXAVTextEncoderLoader", "LTXVAudioVAEDecode", "LTXVAudioVAEEncode", "LTXVAudioVAELoader", "LTXVConcatAVLatent", "LTXVEmptyLatentAudio", "LTXVImgToVideoInplace", "LTXVLatentUpsampler", "LTXVSeparateAVLatent", "ResizeImageMaskNode"]],
  ["0.15.0", ["ImageMergeTileList", "SplitImageToTileList"]],
  ["0.16.0", ["SDPoseDrawKeypoints", "SDPoseKeypointExtractor", "WanSCAILToVideo"]],
  ["0.19.0", ["RTDETR_detect"]],
  ["0.20.0", ["ColorTransfer", "FrameInterpolate", "FrameInterpolationModelLoader", "SAM3_VideoTrack"]],
  ["0.21.0", ["LoadBackgroundRemovalModel", "RemoveBackground"]],
  ["0.25.0", ["SCAIL2ColoredMask"]],
  ["0.28.0", ["SeedVR2Conditioning", "SeedVR2PostProcessing", "SeedVR2Preprocess", "SeedVR2TemporalChunk", "SeedVR2TemporalMerge"]],
  ["0.30.0", ["MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "MiniMaxH3SigmaShift"]],
  ["0.32.0", ["LTXVDualCFGGuider", "ModelAttentionBackend"]],
  ["0.34.0", ["MiniMaxH3AddGuide"]],
  ["0.35.0", ["LTXVAddLatentGuide", "MiniMaxH3FunControlNetApply"]],
  ["0.37.0", ["QwenImage21Cache", "TextEncodeQwenImage21"]],
];

const CORE_SINCE = new Map(CORE_SINCE_TABLE.flatMap(([since, nodes]) => nodes.map((n) => [n, since] as const)));

/** Whether a node type is one of ComfyUI's own (a form's that ComfyUI itself registers), as opposed to a custom node pack's. */
export const isCoreNode = (node: string): boolean => CORE_SINCE.has(node);

/** The newest of some releases. */
const newest = (versions: string[]): string => versions.reduce((a, v) => ((compareVersions(v, a) ?? 0) > 0 ? v : a));

/** The ComfyUI release that brought these node types (the newest of theirs); null when none of them is ComfyUI's own. */
export function comfySince(nodes: string[]): string | null {
  const known = nodes.flatMap((n) => CORE_SINCE.get(n) ?? []);
  return known.length ? newest(known) : null;
}

/**
 * Whether a ComfyUI that says this version is older than `min`. Only a plain release (0.3.10, v0.41.2) is judged: "unknown",
 * a fork's own scheme or a build's suffix says nothing, and is taken as new enough (the node list still says what is missing).
 */
export function comfyOlderThan(version: string | null | undefined, min: string): boolean {
  if (!version || !/^v?\d+\.\d+\.\d+$/.test(version.trim())) return false;
  return compareVersions(version.trim(), min) === -1;
}

/** Each recipe's ComfyUI release, from the nodes its plainest form needs (its first variant), worked out once. */
const needsKept = new WeakMap<Recipe<any>, string | null>();
export function recipeComfySince(r: Recipe<any>): string | null {
  if (needsKept.has(r)) return needsKept.get(r)!;
  let since: string | null = null;
  try {
    since = comfySince(r.variants[0] ? r.nodes(parseInput(r, r.variants[0].input)) : []);
  } catch {
    // a recipe that cannot say its nodes (a saved workflow gone wrong) says nothing of ComfyUI's version
  }
  needsKept.set(r, since);
  return since;
}

/** What a ComfyUI too old for some families cannot run, and the release that runs them all. */
export interface ComfyTooOld {
  /** The release every family listed needs (the newest of theirs). */
  needs: string;
  /** Each family that cannot run here, or only in part: `only`, the titles of its forms that cannot (null: none of them can). */
  families: Array<{ id: string; name: string; needs: string; only: string[] | null; /** How many forms the family shows in all. */ of: number }>;
}

/**
 * The families a ComfyUI of this version cannot run, because ComfyUI's own nodes they need came with a later release; null
 * when it runs them all, or when its version cannot be judged (comfyOlderThan). Hidden recipes and imported workflows are
 * left out: the one is not offered, the other's nodes are the user's own choice.
 */
export function comfyTooOld(version: string | null | undefined, families: Family[], recipes: Recipe<any>[]): ComfyTooOld | null {
  const shown = recipes.filter((r) => !r.hidden && !r.imported);
  const out: ComfyTooOld["families"] = [];
  for (const f of families) {
    const own = shown.filter((r) => r.family === f.id);
    const blocked = own.map((r) => ({ r, since: recipeComfySince(r) })).filter((x) => x.since && comfyOlderThan(version, x.since));
    if (!blocked.length) continue;
    out.push({ id: f.id, name: f.name, needs: newest(blocked.map((x) => x.since!)), only: blocked.length === own.length ? null : blocked.map((x) => x.r.title), of: own.length });
  }
  if (!out.length) return null;
  return { needs: newest(out.map((f) => f.needs)), families: out };
}

/**
 * The families a ComfyUI is too old for, by name, as every screen says them: a family it runs in part says which of its forms
 * it cannot ("MiniMax H3 (Motion transfer)"), or how many past two ("FLUX.2 Klein (6 of 7 forms)").
 */
export const tooOldSaid = (t: ComfyTooOld): string =>
  t.families.map((f) => (!f.only ? f.name : `${f.name} (${f.only.length > 2 ? `${f.only.length} of ${f.of} forms` : f.only.join(", ")})`)).join(", ");

/** The PyTorch a ComfyUI runs on, read from its /system_stats ("2.10.0+cu130"): its version, and the CUDA it was built for. */
export interface TorchBuild {
  torch: string;
  /** "13.0", "12.8"; null for a build for something else (ROCm, the CPU) or one that does not say. */
  cuda: string | null;
}

export function torchBuild(pytorch: string | null | undefined): TorchBuild | null {
  const m = /^(\d+\.\d+(?:\.\d+)?)[^+]*(?:\+(.+))?$/.exec(pytorch?.trim() ?? "");
  if (!m) return null;
  const cu = /^cu(\d+)(\d)$/.exec(m[2] ?? "");
  return { torch: m[1]!, cuda: cu ? `${Number(cu[1])}.${cu[2]}` : null };
}

/**
 * Whether ComfyUI runs its quantized files without its CUDA kernels on this build: since v0.8.0 it turns comfy-kitchen's CUDA
 * backend off under a PyTorch built for CUDA older than 13 (comfy/quant_ops.py: "You need pytorch with cu130 or higher to use
 * optimized CUDA operations"), and the int8 (convrot) and NVFP4 files then run on its plain PyTorch path, slower.
 */
export const slowQuantKernels = (build: TorchBuild | null): boolean => Boolean(build?.cuda && Number(build.cuda.split(".")[0]) < 13);
