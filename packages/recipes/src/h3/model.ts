import { type BuildContext, type GraphBuilder, type Ref } from "@afflatus/core";
import { loadUnet } from "../shared/unet";
import type { H3Video } from "./inputs";

/** The sampler left to the recipe: the one that suits the steps (euler for a turbo's few, res_multistep otherwise). */
export const AUTO_SAMPLER = "Auto";

/** What a model other than the usual one is, as far as its file name says: fine-tunes are named for it ("…HybridTurboV3"). */
export const namedFor = { turbo: /turbo|distill|lightning|(^|[^a-z0-9])\d+[ _-]?steps?/i, hybrid: /hybrid/i };

/**
 * The model the clip is made with, and what it is. The usual files are MiniMax's own: one model for
 * first and last frames, another for references, and a turbo LoRA for few steps. A fine-tune can be all
 * of that in one file: a hybrid follows references itself, a turbo (distilled) one needs no LoRA.
 */
export const modelOf = (input: H3Video, slots: Record<string, string>) => {
  // the usual file can itself be a fine-tune, where MiniMax's own is not installed: what a file is is read from its name either way
  const file = input.model ?? slots.unet;
  const name = file?.split(/[\\/]/).pop() ?? "";
  const is = (said: string, named: RegExp) => said === "Yes" || (said !== "No" && named.test(name));
  return { file, turbo: is(input.turboIn, namedFor.turbo), hybrid: is(input.hybrid, namedFor.hybrid) };
};
export type H3Model = ReturnType<typeof modelOf>;

/**
 * Which way the clip is made. With reference pictures or a voice, the reference model is used: the
 * pictures say who and what is in the clip without being frames of it, and the voice is the one the
 * person speaks with. Otherwise the pictures are the clip's first and last frame.
 */
export const uses = (input: H3Video) => {
  const reference = input.references.length > 0 || input.refVideos.length > 0 || Boolean(input.voice);
  return {
    reference,
    start: Boolean(input.start && !input.previous),
    // a clip to arrive at says more than a picture: with both, the clip is followed. The reference model has no last frame.
    end: Boolean(input.end && !input.next && !reference),
  };
};
export type H3Uses = ReturnType<typeof uses>;

/**
 * The model chain the clip is sampled with: the right file for the way the clip is made, the step cache,
 * the attention and precision patches, the turbo LoRA and the user's LoRAs, the sigma shift, and the
 * live preview. With it, what the chain is (turbo or not, with which LoRA) and how many steps it takes.
 */
export function loadH3Model(g: GraphBuilder, ctx: BuildContext, input: H3Video, picked: H3Model, how: H3Uses, audioVae: Ref): { model: Ref; turbo: boolean; steps: number; lora: string | undefined; distilled: boolean; unet: string | undefined } {
  const { slots } = ctx;
  // references: a hybrid model follows them itself, any other hands those clips to MiniMax's reference model
  const own = !how.reference || picked.hybrid;
  const unet = own ? picked.file : slots.refUnet;
  // the reference model has a turbo LoRA of its own when one is installed; without it the usual one is
  // used, as the model author's own H3 workflow does (one turbo LoRA after whichever model the clip needs)
  const turboFile = how.reference && !picked.hybrid ? slots.refTurbo ?? slots.turbo : slots.turbo;
  // a turbo model is made for few steps as it is: the LoRA on top of it would be the same thing twice
  const distilled = own ? picked.turbo : namedFor.turbo.test(unet?.split(/[\\/]/).pop() ?? "");
  const lora = input.fast && !distilled ? turboFile : undefined;
  const turbo = distilled || Boolean(lora);
  // how many steps a turbo render takes: typed, else what the LoRA (or a distilled model) is named for, else 8
  const namedSteps = /(\d+)[ _-]?step/i.exec((lora ?? (distilled ? unet : "") ?? "").split(/[\\/]/).pop() ?? "");
  const turboSteps = input.turboSteps > 0 ? input.turboSteps : namedSteps ? Number(namedSteps[1]) : 8;
  let model = loadUnet(g, ctx, unet);
  // the step cache is for full renders: with the turbo LoRA's 8 steps there is nothing to skip, and it hurts
  if (input.cache && !turbo && ctx.has("MiniMaxH3Cache")) {
    model = g.out("MiniMaxH3Cache", { model, reuse_threshold: input.cacheThreshold, start_percent: Math.min(input.cacheStart, input.cacheEnd), end_percent: input.cacheEnd, max_steps: input.cacheSteps, device: "auto", verbose: false });
  }
  if (input.quick) model = g.out("ModelAttentionBackend", { model, attention: "comfy kitchen attention" });
  if (ctx.has("ModelPatchTorchSettings")) model = g.out("ModelPatchTorchSettings", { model, enable_fp16_accumulation: true });
  if (lora) model = g.out("LoraLoaderModelOnly", { model, lora_name: lora, strength_model: 1 });
  for (const l of input.loras) {
    if (l.weight !== 0) model = g.out("LoraLoaderModelOnly", { model, lora_name: l.file, strength_model: l.weight });
  }
  // the shifts typed in, else the ones that suit the steps: the turbo LoRAs were trained at 12/3 (8 steps) and 6/3 (4 steps)
  model = g.out("MiniMaxH3SigmaShift", { model, shift_video: input.shiftVideo > 0 ? input.shiftVideo : turbo ? (turboSteps <= 4 ? 6 : 12) : 11, shift_audio: input.shiftAudio > 0 ? input.shiftAudio : turbo ? 3 : 4 });
  // the live preview: each step, a few frames of the latent decoded small (with the tiny VAE when it is there)
  // and the sound so far, sent as a short clip to whoever queued the prompt: what ComfyUI itself shows
  if (input.livePreview && ctx.has("ModelPreviewOverrideKJ")) {
    model = g.out("ModelPreviewOverrideKJ", {
      model, max_resolution: 512, jpeg_quality: 75, suppress_default_preview: true, preview_frames: 16, preview_fps: 12,
      tiny_vae: slots.tinyVae ?? "none", audio_vae: audioVae,
    });
  }
  // a turbo model with Fast off takes the steps typed (4 to 8 are what it is made for)
  const steps = lora || (distilled && input.fast) ? turboSteps : input.steps;
  return { model, turbo, steps, lora, distilled, unet };
}
