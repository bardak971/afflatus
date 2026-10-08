import type { BuildContext, GraphBuilder, LoraValue, Ref } from "@afflatus/core";

/** The model with the LoRAs put on it in order, each at its weight; one at 0 is left out. */
export function applyLoras(g: GraphBuilder, model: Ref, loras: LoraValue[]): Ref {
  for (const l of loras) if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
  return model;
}

/** The LoRA files a render loads (for `loads`): those not at 0. */
export const loraLoads = (loras: LoraValue[]): string[] => loras.filter((l) => l.weight !== 0).map((l) => `loras/${l.file}`);

/**
 * The live preview of a video family, when it is asked for and KJNodes' node is there: each step, a few frames
 * of the latent decoded small (with the tiny VAE when there is one) and sent as a short clip, with the sound so
 * far when the audio VAE is given (H3). ComfyUI's own preview is the first frame alone.
 */
export function livePreview(g: GraphBuilder, ctx: BuildContext, model: Ref, on: boolean, audioVae?: Ref): Ref {
  if (!on || !ctx.has("ModelPreviewOverrideKJ")) return model;
  return g.out("ModelPreviewOverrideKJ", {
    model, max_resolution: 512, jpeg_quality: 75, suppress_default_preview: true, preview_frames: 16, preview_fps: 12,
    tiny_vae: ctx.slots.tinyVae ?? "none", ...(audioVae ? { audio_vae: audioVae } : {}),
  });
}
