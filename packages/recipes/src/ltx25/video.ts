import type { Variant } from "@afflatus/core";
import { ltxRecipe, type LtxVideo } from "../ltx/recipe";
import { LTX25_FPS } from "./family";

/**
 * LTX 2.5 · Video with audio: the same two-pass graph as LTX 2.3 (ltx/recipe.ts), on 2.5's files (split, the text projection
 * inside the Gemma 4 file), at 24 frames a second, `euler_ancestral` in both passes and the dual CFG guider (video and
 * sound alike at the form's CFG), the decoder's tiles as its template sets them: ComfyUI's own `video_ltx2_5_t2v` and
 * `_i2v` templates, read 2026-10-15. NAG is not offered: KJNodes' LTX2_NAG is untried on 2.5's new blocks.
 */
export const ltx25Video = ltxRecipe({
  id: "ltx25.video",
  family: "ltx25",
  name: "LTX 2.5",
  title: "Video with audio",
  summary: "t2v, or i2v from a first frame or a first and last frame, a keyframe between if wanted; several shots in one prompt. Audio generated with it.",
  fps: LTX25_FPS,
  loader: "split",
  guider: "dual",
  sampler: "euler_ancestral",
  decode: { tile: 512, frames: 64, overlap: 16 },
  modelMatch: ["ltx.?2[._]?5"],
  nag: false,
  temporalFile: "ltx-2.5-latent-temporal-upscaler-x2-*.safetensors",
  missing: {
    model: "LTX 2.5 was not found: put its distilled transformer in ComfyUI's models/diffusion_models folder, with its two VAEs in models/vae and its Gemma 4 text encoder in models/text_encoders (Settings › Models has them; the files are gated on Hugging Face).",
    parts: "LTX 2.5's transformer needs its other parts: the video VAE and the audio VAE in ComfyUI's models/vae folder (Settings › Models has them).",
  },
  variants: ((): Variant<LtxVideo>[] => {
    const parts = { unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", videoVae: "ltx-2.5-video-vae-bf16.safetensors", audioVae: "ltx-2.5-audio-vae-bf16.safetensors" };
    const extras = { upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", turbo: "ltx-2.5-22b-distilled-lora-450-bf16.safetensors", rife: "rife49.pth" };
    const temporal = { ...extras, temporal: "ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors" };
    const picture = { width: 832, height: 1216 };
    return [
      { name: "from words, two passes", input: { prompt: "a", seconds: 3 }, slots: { ...parts, ...extras } },
      { name: "from words, one pass (no upscaler)", input: { prompt: "a" }, slots: parts },
      { name: "opens on a picture, two passes, smooth with RIFE", input: { prompt: "a", start: "p1", smooth: true }, slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture } },
      {
        name: "carries on from a clip: its last second opens the clip",
        input: { prompt: "a", previous: { asset: "c1" } },
        slots: { ...parts, ...extras }, uploads: { previous: "a.mp4" }, media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true } },
      },
      {
        name: "between two clips: the clip before's sound carried on, its chain's colour match carried on, landing on the clip after, smooth",
        input: { prompt: "a", previous: { asset: "c1" }, next: { asset: "c2", at: 0 }, smooth: true },
        slots: { ...parts, ...temporal }, uploads: { previous: "a.mp4", "previous.look": "look.png", next: "b.mp4" },
        media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true }, next: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true } },
      },
      {
        name: "from a first to a last picture through a keyframe: one pass",
        input: { prompt: "a", start: "p1", mid: "p3", midAt: 3, end: "p2" },
        slots: { ...parts, ...extras }, uploads: { start: "a.png", mid: "c.png", end: "b.png" }, media: { start: picture, mid: picture, end: picture },
      },
      {
        // the full transformer: the distilled LoRA goes on it
        name: "the dev transformer with the distilled LoRA, on a timeline's canvas",
        input: { prompt: "a", start: "p1", model: "ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors", schedule: "By steps", steps: 10, cfg: 3, negative: "blurry" },
        slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture }, canvas: { width: 1024, height: 576 },
      },
      { name: "opens on a picture, one pass asked for, by steps on LTX's scheduler", input: { prompt: "a", start: "p1", twoPass: false, schedule: "By steps" }, slots: { ...parts, ...extras }, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "twice the frames with LTX's temporal upscaler", input: { prompt: "a", start: "p1", smooth: true }, slots: { ...parts, ...temporal }, uploads: { start: "a.png" }, media: { start: picture } },
      { name: "SeedVR2 upscale, ComfyUI's own video output", input: { prompt: "a", upscale: "Video: SeedVR2 (restores)", upscaleBy: 2 }, slots: { ...parts, ...extras, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" }, has: (n: string) => n !== "VHS_VideoCombine" },
    ];
  })(),
});
