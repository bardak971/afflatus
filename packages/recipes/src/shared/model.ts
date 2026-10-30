import { pickedFile, sameLora, type BuildContext, type GraphBuilder, type LoraValue, type Ref } from "@afflatus/core";

/** The model with the LoRAs put on it in order, each at its weight; one at 0 is left out. */
export function applyLoras(g: GraphBuilder, model: Ref, loras: LoraValue[]): Ref {
  for (const l of loras) if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
  return model;
}

/**
 * A LoRA the recipe adds itself (Turbo's, a distilled LoRA: card #160), as its row in the LoRA list says: the file picked
 * there, else the recipe's own (`file`); the row's weight, 1 for a draft saved before it had one (`usual` where the recipe
 * put it on at another). A row of the same file in the user's list gives the weight and leaves that list: one loader, never
 * two (Turbo's at 1 and the same file at 0.8 by hand made 1.8). A hand row at 0 is not folded: it stays in the list at 0
 * (loaded by nobody) and the row keeps its own weight, as before card #160 (an older draft with Turbo on and the turbo LoRA
 * by hand at 0 loaded it at 1; folded, it lost the LoRA and was sampled at Turbo's few steps without it). `lora` is null
 * without a file; at weight 0 it is not loaded (put), the clip still read as made with it where a recipe counts on that
 * (Turbo's steps).
 */
export function addedLora(file: string | undefined, picked: unknown, weight: unknown, loras: LoraValue[], usual = 1): { lora: LoraValue | null; put: boolean; loras: LoraValue[] } {
  const chosen = pickedFile(picked) ?? file;
  if (!chosen) return { lora: null, put: false, loras };
  const hand = loras.find((l) => l.weight !== 0 && sameLora(l.file, chosen));
  const w = hand ? hand.weight : typeof weight === "number" && Number.isFinite(weight) ? weight : usual;
  return { lora: { file: chosen, weight: w }, put: w !== 0, loras: hand ? loras.filter((l) => l !== hand) : loras };
}

/** The model with a LoRA the recipe adds itself (addedLora) put on it, unless its weight is 0. */
export const putAdded = (g: GraphBuilder, model: Ref, added: { lora: LoraValue | null; put: boolean }): Ref =>
  added.lora && added.put ? g.out("LoraLoaderModelOnly", { model, lora_name: added.lora.file, strength_model: added.lora.weight }) : model;

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
