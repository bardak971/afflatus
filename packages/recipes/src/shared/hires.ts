import type { InputSpec } from "@afflatus/core";
import { tileInputs } from "./tiles";

/** A hires second pass with the sampler and the scheduler of the first, unless others are picked. */
export const SAME_PASS = "As the first pass";
export interface HiresPass {
  hiresSampler: string;
  hiresScheduler: string;
}
export const HIRES_PASS_INPUTS: InputSpec[] = [
  { id: "hiresSampler", type: "choice", label: "Hires sampler", options: { node: "KSampler", input: "sampler_name" }, extra: [SAME_PASS], default: SAME_PASS, showWhen: "hires", advanced: true, perModel: true },
  { id: "hiresScheduler", type: "choice", label: "Hires scheduler", options: { node: "KSampler", input: "scheduler" }, extra: [SAME_PASS], default: SAME_PASS, showWhen: "hires", advanced: true, perModel: true },
];
/**
 * txt2img's hires fix rows, in the order every picture form has them: the switch, how much it enlarges, the upscaler, how much
 * and in how many steps the second pass redraws, its sampler and scheduler (`pass`: a family whose sampler is another node's
 * gives its own), and its tiles. What a family says otherwise is its defaults and its notes.
 */
export function hiresInputs(o: {
  scale: number; scaleNote?: string; denoise: number; denoiseNote: string; steps: number; stepsNote?: string;
  upscaler?: { default: string; extra?: string[] }; pass?: InputSpec[];
}): InputSpec[] {
  return [
    { id: "hires", type: "toggle", label: "Hires fix", note: "upscale, then a second pass over the larger picture", default: false, advanced: true, perModel: true },
    { id: "hiresScale", type: "number", label: "Upscale by", note: o.scaleNote ?? "past 2×, the second pass is redrawn in tiles (see Redraw)", min: 1.1, max: 4, step: 0.05, default: o.scale, unit: "×", showWhen: "hires", advanced: true, perModel: true },
    {
      id: "hiresUpscaler", type: "choice", label: "Upscaler", note: "from your upscale models", showWhen: "hires", advanced: true, perModel: true,
      options: { node: "UpscaleModelLoader", input: "model_name" }, ...(o.upscaler?.extra ? { extra: o.upscaler.extra } : {}), default: o.upscaler?.default ?? "RealESRGAN_x4plus.pth", prefer: UPSCALER_PREFER,
    },
    { id: "hiresDenoise", type: "number", label: "Denoising strength", note: o.denoiseNote, min: 0.05, max: 0.9, step: 0.05, default: o.denoise, showWhen: "hires", advanced: true, perModel: true },
    { id: "hiresSteps", type: "number", label: "Hires steps", ...(o.stepsNote ? { note: o.stepsNote } : {}), min: 1, max: 60, step: 1, default: o.steps, showWhen: "hires", advanced: true, perModel: true },
    ...(o.pass ?? HIRES_PASS_INPUTS),
    ...tileInputs("hires"),
  ];
}
/** What the second pass samples with, over what the first pass used. */
export const hiresPass = (input: HiresPass) => ({
  ...(input.hiresSampler !== SAME_PASS ? { sampler_name: input.hiresSampler } : {}),
  ...(input.hiresScheduler !== SAME_PASS ? { scheduler: input.hiresScheduler } : {}),
});

/**
 * The upscale model Upscale and SDXL's hires fix start on: Phips's 4xNomos8kSC (photos, CC BY 4.0), as a safetensors (not a
 * pickle) at the commit its hash was read from (2026-11-04). 4x-UltraSharp.pth, the start before, has a dozen copies under
 * its name on Hugging Face and none Afflatus can tell is the one: a fresh pod could not fetch it (the pod test, card #280).
 */
export const UPSCALER_DEFAULT = "4xNomos8kSC.safetensors";

/**
 * The two upscale models the picture forms start on, as downloads (Settings › Models) and as the sources a pod fetches them
 * from: 4xNomos8kSC, and RealESRGAN x4plus, where the flow families' hires fix starts (pinned as podSources' USUAL_COPIES is).
 */
export const UPSCALER_SLOTS = [
  {
    id: "upscaler", label: "Upscaler (Upscale, SDXL hires fix)", folder: "upscale_models", detect: ["nomos8ksc"], optional: true,
    hint: `Optional, 33 MB: the upscale model Upscale and SDXL's hires fix start on, in ComfyUI's models/upscale_models folder. Any other there can be picked in the form.`,
    get: { file: UPSCALER_DEFAULT, url: `https://huggingface.co/Phips/4xNomos8kSC/resolve/623bdf3d1ec5bccb02548a79eec1b62d32ff86fd/${UPSCALER_DEFAULT}`, sha256: "9e158a603ceb1a21de7159cbdf32c402d1d68d03397f3d6d473d0152fc12122c" },
  },
  {
    id: "upscalerGeneral", label: "Upscaler (hires fix)", folder: "upscale_models", detect: ["realesrgan_x4plus(?!.*anime)"], optional: true,
    hint: "Optional, 64 MB: RealESRGAN x4plus, the upscale model the hires fix of FLUX.1, Klein, Krea 2, Qwen and Z-Image starts on, in ComfyUI's models/upscale_models folder.",
    get: { file: "RealESRGAN_x4plus.pth", url: "https://huggingface.co/lllyasviel/Annotators/resolve/982e7edaec38759d914a963c48c4726685de7d96/RealESRGAN_x4plus.pth", sha256: "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1" },
  },
];

/** Which upscale model a picture recipe starts on when its default is not there: Nomos8kSC (photos), else a general one, an anime one last. */
export const UPSCALER_PREFER = ["nomos8ksc", "clearreality", "ultrasharp", "x4plus(?!.*anime)", "nomosuni", "remacri|nmkd|siax|foolhardy", "^(?!.*anime)", "."];
