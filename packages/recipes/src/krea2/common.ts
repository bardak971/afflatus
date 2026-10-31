import type { InputSpec } from "@afflatus/core";
import { flowKit, type FlowSpec } from "../flow/kit";

/** Which Krea 2 model: Turbo, or a fine-tune of it. The form starts on the one found by name. */
const krea2Model: InputSpec = {
  id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["krea.?2", "(^|[^a-z0-9])k2([^a-z0-9]|$)"],
  note: "Krea 2 Turbo, or a fine-tune of it",
};

/** How it samples: the values of ComfyUI's own Krea 2 Turbo template to begin with, each kept per model once saved. */
const krea2Inputs: InputSpec[] = [
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
  { id: "negative", type: "prompt", label: "Negative prompt", note: "only acts with a CFG scale above 1", style: "sentences", optional: true, default: "", advanced: true, perModel: true },
  { id: "steps", type: "number", label: "Steps", note: "8 for Turbo and its fine-tunes", min: 1, max: 60, step: 1, default: 8, advanced: true, perModel: true },
  { id: "cfg", type: "number", label: "CFG scale", note: "1 for Turbo. Above 1 the negative prompt acts and every step takes twice as long", min: 1, max: 10, step: 0.5, default: 1, advanced: true, perModel: true },
  { id: "sampler", type: "choice", label: "Sampler", options: { node: "KSampler", input: "sampler_name" }, default: "euler", advanced: true, perModel: true },
  { id: "scheduler", type: "choice", label: "Scheduler", options: { node: "KSampler", input: "scheduler" }, default: "simple", advanced: true, perModel: true },
  { id: "shift", type: "number", label: "Shift", note: "0 leaves the model's own. Some fine-tunes ask for another (4, for example)", min: 0, max: 12, step: 0.05, default: 0, advanced: true, perModel: true },
  { id: "seed", type: "seed", label: "Seed" },
];

/**
 * Krea 2, said the way the other picture models are (see FlowSpec): built as ComfyUI's own Krea 2 Turbo template
 * builds it. Turbo has no use for a negative prompt (it runs at CFG 1): without one, the negative side is the
 * positive one emptied. Every pass keeps the model's own shift unless one is typed, whatever its size: Krea's
 * authors give Turbo one constant shift (mu 1.15) at every size, where FLUX.1's way of raising it with the size
 * would take a 1.5× hires pass to about 2.
 */
export const krea2Spec: FlowSpec = {
  family: "krea2",
  model: krea2Model,
  encoder: {
    nodes: ["CLIPLoader"],
    load: (g, slots) => g.out("CLIPLoader", { clip_name: slots.clip, type: "krea2", device: "default" }),
    files: (slots) => [`text_encoders/${slots.clip}`],
  },
  shift: { node: "ModelSamplingAuraFlow", default: 0, note: "0 leaves the model's own. Some fine-tunes ask for another (4, for example)", own: { mu: 1.15 } },
  negative: { default: "", note: "only acts with a CFG scale above 1", empty: "zero" },
  sampling: { steps: 8, stepsNote: "8 for Turbo and its fine-tunes", cfg: 1, cfgNote: "1 for Turbo", sampler: "euler", scheduler: "simple" },
  // a 1.5× pass that redraws little in Turbo's own few steps: more redraw than 0.35 starts to change the picture
  hires: { scale: 1.5, denoise: 0.35, steps: 4 },
  inputs: krea2Inputs,
  hardInpaint: true,
  shapes: [
    { id: "tall", label: "Portrait", width: 896, height: 1152 },
    { id: "square", label: "Square", width: 1024, height: 1024 },
    { id: "wide", label: "Landscape", width: 1152, height: 896 },
    { id: "tall-9-16", label: "Portrait 9:16", width: 768, height: 1360 },
    { id: "wide-16-9", label: "Landscape 16:9", width: 1360, height: 768 },
  ],
  megapixels: 1.6,
  presets: [
    {
      // RAW is the undistilled model Turbo was made from: the many steps and the real CFG of Krea's own settings,
      // and a hires pass of half as many steps, as the other undistilled models have (Turbo's 4 would leave it rough)
      match: "krea.?2.*raw",
      values: { steps: 52, cfg: 3.5, hiresSteps: 26 },
      note: "Krea 2 RAW: not distilled, 52 steps at CFG 3.5 as Krea gives it; the negative prompt acts",
    },
  ],
  placeholder: "A photograph of a woman in a linen shirt drinking coffee on a terrace at sunrise, soft warm light from the left, waist up.",
  files: { unet: "krea2_turbo_fp8_scaled.safetensors", clip: "qwen3vl_4b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" },
  fineTune: "someone_krea2.safetensors",
};

export const krea2Kit = flowKit(krea2Spec);
