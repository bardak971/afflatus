import type { InputSpec } from "@afflatus/core";
import { flowKit, FLOW_SHAPES, type FlowSpec } from "../flow/kit";
import { noGuide } from "../shared/pictureForm";

/** Which Krea 2 model: Turbo, or a fine-tune of it. The form starts on the one found by name. */
const krea2Model: InputSpec = {
  id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["krea.?2", "(^|[^a-z0-9])k2([^a-z0-9]|$)"],
  note: "Krea 2 Turbo, or a fine-tune of it",
};

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
  sampling: { steps: 8, stepsNote: "8 for Turbo and its fine-tunes", cfg: 1, cfgNote: "1 for Turbo. Above 1 the negative prompt acts and every step takes twice as long", sampler: "euler", scheduler: "simple" },
  // a 1.5× pass that redraws little in Turbo's own few steps: more redraw than 0.35 starts to change the picture
  hires: { scale: 1.5, denoise: 0.35, steps: 4 },
  // its own inputs: no weight precision (drops says why), and the lower maxima of its template
  rows: { omit: ["precision"], max: { steps: 60, cfg: 10 } },
  hardInpaint: true,
  drops: {
    precision: "Krea 2 Turbo comes as an fp8_scaled file, which UNETLoader reads as it is: its own inputs leave the weight precision out",
    // read on Hugging Face, 2026-11-04 (card #277)
    ...noGuide("no union ControlNet ComfyUI's own nodes load is made for Krea 2: the ones on Hugging Face are single-kind community files (pose, depth)"),
  },
  shapes: FLOW_SHAPES,
  megapixels: 1.6,
  presets: [
    {
      // RAW is the undistilled model Turbo was made from: the many steps and the real CFG of Krea's own settings,
      // and a hires pass of half as many steps, as the other undistilled models have (Turbo's 4 would leave it rough). A file
      // named Turbo is not it, "Raw" in its name or not: DasiwaKrea2TurboRaw is distilled, and at 52 steps and CFG 3.5 it
      // gave pure grain on a pod (card #275's render test)
      match: "^(?!.*turbo).*krea.?2.*raw",
      values: { steps: 52, cfg: 3.5, hiresSteps: 26 },
      note: "Krea 2 RAW: not distilled, 52 steps at CFG 3.5 as Krea gives it; the negative prompt acts",
    },
  ],
  placeholder: "A photograph of a woman in a linen shirt drinking coffee on a terrace at sunrise, soft warm light from the left, waist up.",
  files: { unet: "krea2_turbo_fp8_scaled.safetensors", clip: "qwen3vl_4b_fp8_scaled.safetensors", vae: "qwen_image_vae.safetensors" },
  fineTune: "someone_krea2.safetensors",
};

export const krea2Kit = flowKit(krea2Spec);
