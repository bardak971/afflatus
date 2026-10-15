import type { Variant } from "@afflatus/core";
import { ltxRecipe, type LtxVideo } from "./recipe";
import { LTX_FPS } from "./family";

// the recipe's workings are shared with LTX 2.5 (recipe.ts); its input type and its schedules are still had from here
export type { LtxVideo } from "./recipe";
export { LTX_REFINE_SIGMAS, LTX_SIGMAS } from "./recipe";

/** LTX 2.3: the one checkpoint (or split files with their text projection), `euler`, CFG on the conditioning, 25 frames a second. */
export const ltxVideo = ltxRecipe({
  id: "ltx.video",
  family: "ltx",
  name: "LTX 2.3",
  title: "Video with audio",
  summary: "t2v, or i2v from a first frame or a first and last frame, a keyframe between if wanted. Audio generated with it.",
  fps: LTX_FPS,
  loader: "checkpoint",
  guider: "cfg",
  sampler: "euler",
  decode: { tile: 768, frames: 4096, overlap: 4 },
  modelMatch: ["ltx.?2[._]?3", "ltx"],
  nag: true,
  temporalFile: "ltx-2.3-temporal-upscaler-x2-*.safetensors",
  missing: {
    model: "LTX 2.3 was not found: put its checkpoint in ComfyUI's models/checkpoints folder, or a diffusion model in models/diffusion_models with its two VAEs and its text projection.",
    parts: "A diffusion model in a file of its own needs LTX 2.3's other parts: the video VAE and the audio VAE in ComfyUI's models/vae folder, and the text projection in models/text_encoders.",
  },
  variants: ((): Variant<LtxVideo>[] => {
    const one = { checkpoint: "ltx-2.3-22b-distilled-fp8.safetensors", clip: "gemma_3_12B_it.safetensors" };
    const parts = { unet: "SomeoneLTX23_v4.safetensors", videoVae: "LTX23_video_vae.safetensors", audioVae: "LTX23_audio_vae.safetensors", projection: "ltx-2.3_text_projection.safetensors", clip: "gemma_3_12B_it.safetensors" };
    const extras = { upscaler: "ltx-2.3-spatial-upscaler-x2.safetensors", turbo: "ltx_2.3_distilled_lora.safetensors", rife: "rife49.pth" };
    const temporal = { ...extras, temporal: "ltx-2.3-temporal-upscaler-x2-1.0.safetensors" };
    const picture = { width: 832, height: 1216 };
    return [
      { name: "from words, the one checkpoint, one pass (no upscaler)", input: { prompt: "a" }, slots: one },
      { name: "from words, the one checkpoint, two passes", input: { prompt: "a", seconds: 3 }, slots: { ...one, ...extras } },
      { name: "opens on a picture, in separate files, two passes, smooth", input: { prompt: "a", start: "p1", smooth: true }, slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture } },
      {
        name: "carries on from a clip: its last second opens the clip, a first frame set aside",
        input: { prompt: "a", previous: { asset: "c1" }, start: "ignored" },
        slots: { ...one, ...extras }, uploads: { previous: "a.mp4", start: "a.png" }, media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX_FPS, hasSound: true } },
      },
      { name: "carries on from a short clip, in one pass with a last picture", input: { prompt: "a", previous: { asset: "c1" }, end: "p2" }, slots: one, uploads: { previous: "a.mp4", end: "b.png" }, media: { previous: { width: 704, height: 1280, frames: 9, fps: LTX_FPS, hasSound: false }, end: picture } },
      {
        name: "from a first to a last picture: one pass, a LoRA",
        input: { prompt: "a", start: "p1", end: "p2", loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }] },
        slots: { ...parts, ...extras }, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      { name: "a keyframe in the middle, two passes", input: { prompt: "a", start: "p1", mid: "p3", midAt: 2.5 }, slots: { ...one, ...extras }, uploads: { start: "a.png", mid: "c.png" }, media: { start: picture, mid: picture } },
      {
        name: "first, keyframe and last picture: one pass",
        input: { prompt: "a", start: "p1", mid: "p3", midAt: 3, midStrength: 0.6, end: "p2" },
        slots: { ...one, ...extras }, uploads: { start: "a.png", mid: "c.png", end: "b.png" }, media: { start: picture, mid: picture, end: picture },
      },
      { name: "ends on a picture only", input: { prompt: "a", end: "p2", endStrength: 0.9 }, slots: one, uploads: { end: "b.png" }, media: { end: picture } },
      { name: "SageAttention, an fp8 kernel", input: { prompt: "a", sage: true, sageKernel: "sageattn_qk_int8_pv_fp8_cuda" }, slots: { ...one, ...extras } },
      {
        // the full model: the distilled LoRA goes on it; a schedule of the user's own
        name: "the full model with the distilled LoRA, by steps with a shift, on a timeline's canvas",
        input: { prompt: "a", start: "p1", model: "ltx-2.3-22b-dev.safetensors", schedule: "By steps", steps: 10, maxShift: 2.5, terminal: 0.05, cfg: 3, negative: "blurry" },
        slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture }, canvas: { width: 1024, height: 576 },
      },
      { name: "opens on a picture, one pass asked for, by steps unstretched", input: { prompt: "a", start: "p1", twoPass: false, schedule: "By steps", stretch: false }, slots: { ...one, ...extras }, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "twice the frames with LTX's temporal upscaler, two passes", input: { prompt: "a", start: "p1", smooth: true }, slots: { ...parts, ...temporal }, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "twice the frames with LTX's temporal upscaler, one pass with a last picture", input: { prompt: "a", end: "p2", smooth: true, smoothWith: "LTX temporal (latent)" }, slots: { ...one, ...temporal }, uploads: { end: "b.png" }, media: { end: picture } },
      { name: "RIFE asked for although the temporal upscaler is there", input: { prompt: "a", smooth: true, smoothWith: "RIFE (pixels)" }, slots: { ...one, ...temporal } },
      { name: "a GGUF diffusion model, ComfyUI's own video output", input: { prompt: "a", model: "ltx-2.3-22b-dev-Q4_K_M.gguf" }, slots: { ...parts, ...extras }, has: (n: string) => n !== "VHS_VideoCombine" },
    ];
  })(),
});
