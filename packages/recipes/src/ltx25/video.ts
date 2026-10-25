import type { Variant } from "@afflatus/core";
import { ltxRecipe, type LtxSpec, type LtxVideo } from "../ltx/recipe";
import { LTX25_FPS } from "./family";

/**
 * LTX 2.5 · Video with audio: the same two-pass graph as LTX 2.3 (ltx/recipe.ts), on 2.5's files (split, the text projection
 * inside the Gemma 4 file), at 24 frames a second, `euler_ancestral` in both passes and the dual CFG guider (video and
 * sound alike at the form's CFG), the decoder's tiles as its template sets them: ComfyUI's own `video_ltx2_5_t2v` and
 * `_i2v` templates, read 2026-10-15. NAG is not offered: KJNodes' LTX2_NAG is untried on 2.5's new blocks.
 */
const spec: LtxSpec = {
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
  references: true,
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
        name: "carries on in the clip before's latent, doubled by the temporal upscaler: its join decoded alone",
        input: { prompt: "a", previous: { asset: "c1" }, smooth: true, smoothWith: "LTX temporal (latent)" },
        slots: { ...parts, ...temporal }, uploads: { previous: "a.mp4", "previous.latent": "a.safetensors" },
        media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true, latentFrames: 121, latentSize: { width: 704, height: 1280 } } },
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
      {
        name: "the cast's pictures through the MSR LoRA: a person, the clothes, the place as the background, the person's voice; two passes",
        input: { prompt: "a", references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "clothing" }, { asset: "r3", role: "place" }], voice: "v1" },
        slots: { ...parts, ...extras, msr: "LTX-2.5-Licon-MSR-V2.safetensors" }, uploads: { "references.0": "r1.png", "references.1": "r2.png", "references.2": "r3.png", voice: "v.wav" },
      },
      {
        name: "a reference picture beside a first and a last frame: one pass, the last frame kept",
        input: { prompt: "a", start: "p1", end: "p2", references: [{ asset: "r1", role: "person" }] },
        slots: { ...parts, ...extras, msr: "LTX-2.5-Licon-MSR-V2.safetensors" }, uploads: { start: "a.png", end: "b.png", "references.0": "r1.png" }, media: { start: picture, end: picture },
      },
      {
        name: "a reference picture on a clip that carries on from another",
        input: { prompt: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }] },
        slots: { ...parts, ...extras, msr: "LTX-2.5-Licon-MSR-V2.safetensors" }, uploads: { previous: "a.mp4", "references.0": "r1.png" }, media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true } },
      },
      {
        name: "a reference picture on a clip carried on in the clip before's latent: the seam decoded as one piece",
        input: { prompt: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }] },
        slots: { ...parts, ...extras, msr: "LTX-2.5-Licon-MSR-V2.safetensors" }, uploads: { previous: "a.mp4", "previous.latent": "a.safetensors", "references.0": "r1.png" },
        media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true, latentFrames: 121, latentSize: { width: 704, height: 1280 } } },
      },
      {
        name: "reference pictures without the MSR LoRA: left out, said on the job",
        input: { prompt: "a", references: [{ asset: "r1", role: "person" }] },
        slots: { ...parts, ...extras }, uploads: { "references.0": "r1.png" },
      },
      { name: "SeedVR2 upscale, ComfyUI's own video output", input: { prompt: "a", upscale: "Video: SeedVR2 (restores)", upscaleBy: 2 }, slots: { ...parts, ...extras, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" }, has: (n: string) => n !== "VHS_VideoCombine" },
      {
        name: "a sound cue pinned in its own sound",
        input: { prompt: "She claps once.", cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: { ...parts, ...extras }, uploads: { "cues.0": "clap.wav" }, media: { "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
      {
        name: "under a recording it plays over",
        input: { prompt: "a", recording: "a1", recordingSeconds: 5.9 },
        slots: { ...parts, ...extras }, uploads: { recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9, after: 4 } },
      },
    ];
  })(),
};
export const ltx25Video = ltxRecipe(spec);

/** LTX 2.5 · Lip sync (card #2): LTX 2.3's (ltx/video.ts) on 2.5's files, at 24 frames a second, the sound pinned under 2.5's dual guider. */
export const ltx25LipSync = ltxRecipe({
  ...spec,
  id: "ltx25.lipsync",
  title: "Lip sync",
  summary: "A new shot made around a recording: the mouth follows it. Continues the clip before.",
  lipSync: true,
  variants: ((): Variant<LtxVideo>[] => {
    const parts = { unet: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", clip: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", videoVae: "ltx-2.5-video-vae-bf16.safetensors", audioVae: "ltx-2.5-audio-vae-bf16.safetensors" };
    const two = { ...parts, upscaler: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors" };
    return [
      {
        name: "a recording and the picture of who speaks",
        input: { prompt: "a café terrace", start: "p1", recording: "a1", recordingSeconds: 5.9 },
        slots: two, uploads: { start: "a.png", recording: "rec.wav" }, media: { start: { width: 832, height: 1216 }, recording: { width: 0, height: 0, seconds: 5.9 } },
      },
      {
        name: "a sound cue over the recording",
        input: { prompt: "She claps once.", recording: "a1", recordingSeconds: 5.9, cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: two, uploads: { recording: "rec.wav", "cues.0": "clap.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9 }, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
      {
        name: "carrying on from a clip",
        input: { prompt: "a", previous: { asset: "c1" }, recording: "a1", recordingSeconds: 4.2 },
        slots: two, uploads: { previous: "a.mp4", recording: "rec.wav" }, media: { previous: { width: 704, height: 1280, frames: 25, fps: LTX25_FPS, hasSound: true }, recording: { width: 0, height: 0, seconds: 4.2 } },
      },
      {
        name: "the cast's picture through the MSR LoRA, the recording as the voice",
        input: { prompt: "a café terrace", references: [{ asset: "r1", role: "person" }], recording: "a1", recordingSeconds: 5.9 },
        slots: { ...two, msr: "LTX-2.5-Licon-MSR-V2.safetensors" }, uploads: { "references.0": "r1.png", recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9 } },
      },
      {
        name: "the dev transformer with the distilled LoRA, by steps in one pass (no upscaler), smooth with RIFE",
        input: { prompt: "a", recording: "a1", recordingSeconds: 5, model: "ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors", loraStrength: 0.6, smooth: true, schedule: "By steps", cfg: 3 },
        slots: { ...parts, turbo: "ltx-2.5-22b-distilled-lora-450-bf16.safetensors", rife: "rife49.pth" }, uploads: { recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5 } },
      },
    ];
  })(),
});
