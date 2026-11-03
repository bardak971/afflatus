import { OWN_MODEL, type Variant } from "@afflatus/core";
import { H3_FPS } from "./family";
import { UPSCALE } from "../video/upscale";
import { FACE_REFINE_SLOTS } from "./faceRefine";
import type { H3Video } from "./inputs";
import { recordingInputs, recordingOnClip, type Recording } from "../shared/recording";
import { h3Form } from "./form";

// the recipe's parts live beside it (inputs, join, condition, latent-upscale, finish, its clip's graph in clip.ts); its input
// type is still had from here
export type { H3Video } from "./inputs";

/** MiniMax H3 · Video with audio: H3's clip as it is, every H3 option on it (h3Form). */
export const h3Video = h3Form<H3Video & Partial<Recording>>({
  id: "h3.video",
  version: 2,
  title: "Video with audio",
  summary: "t2v, or i2v from a first and last frame, with reference images, or extending a previous clip. Audio included.",
  // a clip under a recording it plays over (card #72): its place in the recording, set by the timeline, never drawn
  inputs: { lay: (shared) => [...shared, ...recordingInputs({ shown: false })] },

  // under a recording it plays over (card #72): the clip lasts as long as its part, as a Lip sync clip does, and its files
  // carry the part in place of H3's own sound, so that the recording plays on across it unchanged. No guide: the mouth
  // does what What happens says (#79: "listens, mouth closed" kept it as still as a silent Lip sync guide)
  built(input, ctx) {
    if (!input.recording) return { clip: input };
    // (its form always has the part's length: the recording's inputs are its own, with their defaults)
    const laid = recordingOnClip({ recordingSeconds: input.recordingSeconds ?? 0, recordingGoesOn: input.recordingGoesOn }, ctx, 0);
    return { clip: { ...input, seconds: laid.seconds }, extra: { sound: laid.sound } };
  },

  variants: ((): Variant<H3Video & Partial<Recording>>[] => {
    const slots = { unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors" };
    const all = { ...slots, turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors" };
    const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    const picture = { width: 832, height: 1216 };
    const faceSlots = FACE_REFINE_SLOTS;
    return [
      { name: "words only, plain", input: { description: "a", fast: false, smooth: false, quick: false }, slots },
      { name: "fast, smooth, quick", input: { description: "a", cache: true }, slots: all },
      { name: "full steps with the step cache", input: { description: "a", fast: false, cache: true }, slots: all },
      // Veda on, its two predictors there: the text-and-frames one taken (no references), sparsity 24 / 40
      { name: "Veda's sparse attention, its text-and-frames predictor", input: { description: "a", veda: true, vedaGenerated: 24, vedaReference: 40, shot: "Medium" }, slots: { ...all, ...{ veda: "minimax_h3_r2va_veda_preview_fp8.safetensors", vedaT2va: "minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors" } } },
      {
        name: "opens on a picture and ends on another, a LoRA",
        input: { description: "a", start: "p1", end: "p2", loras: [{ file: "l.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }], fast: false },
        slots, uploads: { start: "a.png", end: "b.png" }, media: { start: picture, end: picture },
      },
      {
        name: "carries on from a clip",
        input: { description: "a", previous: { asset: "c1" }, start: "ignored" },
        slots: all, uploads: { previous: "a.mp4", start: "a.png" }, media: { previous: joined },
      },
      // the person pictures of the take before (card #223): sampled without them, the face drawn towards them by Face refine
      {
        name: "carries on with the person's pictures of the clip before, its face from Face refine",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }], faceCarried: true },
        slots: { ...all, ...faceSlots }, uploads: { previous: "a.mp4", "references.0": "r1.png" }, media: { previous: joined },
      },
      // (the latent routes are not variants: nodes() declares the pixel route, which is always possible; the
      // recipe tests build them and check them against the catalog)
      {
        name: "between two clips, the next one silent and short",
        input: { description: "a", previous: { asset: "c1", at: 3000 }, next: { asset: "c2" }, end: "ignored" },
        slots: all, uploads: { previous: "a.mp4", next: "b.mp4", end: "b.png" },
        media: { previous: joined, next: { ...joined, frames: 5, hasSound: false } }, canvas: { width: 1024, height: 576 },
      },
      {
        name: "a person and a place from reference pictures, a voice, opening on a picture",
        input: {
          description: "a", subject: "brown hair", start: "p1", end: "ignored", voice: "v1", sharpRefs: true,
          references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "person" }, { asset: "r3", role: "place" }],
        },
        slots: all, uploads: { start: "a.png", end: "b.png", voice: "v.wav", "references.0": "r1.png", "references.1": "r2.png", "references.2": "r3.png" },
        media: { start: picture },
      },
      {
        name: "references, carrying on from a clip",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "clothing" }], fast: false },
        slots: all, uploads: { previous: "a.mp4", "references.0": "r1.png" }, media: { previous: joined },
      },
      {
        // one file that is all three: no reference model, no turbo LoRA
        name: "a hybrid turbo fine-tune, with a reference picture",
        input: { description: "a", model: "SomeoneH3_hybridTurboV3.safetensors", references: [{ asset: "r1", role: "person" }] },
        slots: { ...slots, turbo: all.turbo }, uploads: { "references.0": "r1.png" },
      },
      {
        name: "a video of the person with its sound, and a picture of the place",
        input: { description: "a", refVideos: [{ asset: "v1", role: "person" }, { asset: "v2", role: "person" }], references: [{ asset: "r1", role: "place" }] },
        slots: all, uploads: { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4", "references.0": "r1.png" },
        media: { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: false } },
      },
      {
        // a place's and a look's videos: their own subjects, and their sound left out
        name: "a video of a place and a video of a look, both with sound",
        input: { description: "a", refVideos: [{ asset: "v1", role: "place" }, { asset: "v2", role: "style" }] },
        slots: all, uploads: { "refVideos.0": "a.mp4", "refVideos.1": "b.mp4" },
        media: { "refVideos.0": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true }, "refVideos.1": { width: 384, height: 682, frames: 72, fps: 24, hasSound: true } },
      },
      {
        name: "passes through a picture half way",
        input: { description: "a", start: "p1", mid: "p2", midAt: 2.5 },
        slots: all, uploads: { start: "a.png", mid: "m.png" }, media: { start: picture },
      },
      { name: "latent upscale, plain resize", input: { description: "a", upscale: UPSCALE.latent }, slots: all },
      { name: "latent upscale, H3's upscaler", input: { description: "a", upscale: UPSCALE.latent, upscaleBy: 1.5, fast: false }, slots: { ...all, latentUpscaler: "minimax_h3_latent_upscaler_3d_fp16.safetensors" } },
      { name: "pixel upscale with a model", input: { description: "a", upscale: UPSCALE.model, upscaleModel: "4x-UltraSharp.pth" }, slots: all },
      { name: "pixel upscale with RTX VSR", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all },
      { name: "pixel upscale with the other RTX node, NVIDIA's absent", input: { description: "a", upscale: UPSCALE.rtx, upscaleBy: 2 }, slots: all, has: (n: string) => n !== "RTXVideoSuperResolution" },
      { name: "SeedVR2 upscale", input: { description: "a", upscale: UPSCALE.seedvr, upscaleBy: 2, upscaleColour: "wavelet" }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" } },
      {
        // one loader: the face pass on the clip's own reference model (card #159)
        name: "Face refine on the clip's own model",
        input: { description: "a", faceRefine: true, faceRefineModel: OWN_MODEL, references: [{ asset: "r1", role: "person" }] },
        slots: { ...all, ...faceSlots }, uploads: { "references.0": "r1.png" },
      },
      { name: "SeedVR2 upscale with the model picked", input: { description: "a", upscale: UPSCALE.seedvr, seedvrModel: "seedvr2_7b_int8_convrot.safetensors" }, slots: { ...all, seedvr: "seedvr2_3b_int8_convrot.safetensors", seedvrVae: "seedvr2_ema_vae_fp16.safetensors" } },
      { name: "latent upscale, the upscaler picked", input: { description: "a", upscale: UPSCALE.latent, upscaleLatentModel: "minimax_h3_latent_upscaler_3d_v2.safetensors" }, slots: all },
      {
        name: "Face refine, towards the cast person's picture",
        input: { description: "a", subject: "short dark hair, round glasses", faceRefine: true, references: [{ asset: "r1", role: "person" }, { asset: "r2", role: "place" }] },
        slots: { ...all, ...faceSlots }, uploads: { "references.0": "r1.png", "references.1": "r2.png" },
      },
      {
        name: "Finish › Face refine: the take's own latent, nothing sampled, no SAM",
        input: { description: "a", faceRefine: true, faceRefineOnly: true, references: [{ asset: "r1", role: "person" }] },
        slots: { ...all, faceRefineUnet: faceSlots.faceRefineUnet, faceDetector: faceSlots.faceDetector }, uploads: { "references.0": "r1.png", "self.latent": "own.safetensors" },
      },
      {
        // the cues pinned after the run-up (frames 22 + 2.4 s and 22 + 0), their parts laid into the file's sound over H3's
        name: "two sound cues laid in, carrying on from a clip",
        input: { description: "a", previous: { asset: "c1" }, cues: [{ asset: "s1", start: 0.1, seconds: 0.6, at: 2.4 }, { asset: "s2", start: 3, seconds: 1.5, at: 0 }] },
        slots: all, uploads: { previous: "a.mp4", "cues.0": "door.wav", "cues.1": "cheer.wav" }, media: { previous: joined, "cues.0": { width: 0, height: 0, seconds: 0.6 }, "cues.1": { width: 0, height: 0, seconds: 1.5 } },
      },
      {
        name: "a sound cue that H3 makes its own sound for",
        input: { description: "a", cues: [{ asset: "s1", start: 0, seconds: 0.5, at: 2.4 }], cueSound: "H3's own" },
        slots: all, uploads: { "cues.0": "clap.wav" }, media: { "cues.0": { width: 0, height: 0, seconds: 0.5 } },
      },
      {
        name: "a voice only, with the picture of who speaks",
        input: { description: "a", start: "p1", voice: "v1" },
        slots: all, uploads: { start: "a.png", voice: "v.wav" }, media: { start: picture },
      },
      // under a recording it plays over (card #72): its part laid in as the sound, nothing guided with it
      {
        name: "under a recording it plays over",
        input: { description: "She listens, her mouth closed, swaying gently to the music.", recording: "a1" },
        slots: all, uploads: { recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9, after: 4 } },
      },
      {
        name: "under a recording, carrying on from a clip that sang up to its part",
        input: { description: "a", previous: { asset: "c1" }, recording: "a1", recordingLeadIn: true, recordingGoesOn: true },
        slots: all, uploads: { previous: "a.mp4", recording: "rec.wav" }, media: { previous: joined, recording: { width: 0, height: 0, seconds: 7.3, after: 4, before: 2 } },
      },
      {
        // added over the recording, which plays on under it (card #71)
        name: "under a recording, a sound cue over it",
        input: { description: "She listens and claps once.", recording: "a1", cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: all, uploads: { recording: "rec.wav", "cues.0": "clap.wav" }, media: { recording: { width: 0, height: 0, seconds: 5.9, after: 4 }, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
    ];
  })(),
});
