import { defineRecipe, type GraphBuilder, type InputSpec, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS } from "./family";
import { h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video } from "./video";

/**
 * MiniMax H3 · Lip sync: a new shot made around a recording. The recording is laid on the clip's sound where the clip's
 * own part begins (MiniMaxH3AddGuide), so the mouth follows the words; the clip lasts as long as the recording, and its
 * files carry the recording itself. Everything else is H3's clip: the cast, the clip before continued in its latent,
 * Turbo, the finishes. Tested 2026-10-13 (HANDOVER-swap-lipsync-report.md §8): three chained clips cut in the
 * recording's pauses joined at 1.8 (the app flags 3), lip-sync confidence 4.4 to 5.4.
 */
export interface H3LipSync extends H3Video {
  recording: string;
  recordingStart: number;
  recordingSeconds: number;
  evenLoudness: boolean;
  speechAt: number;
}

/** Said after the scene: without it H3 sometimes leaves the person silent while the recording plays. */
const SPEAKS = "The person speaks throughout, the lips moving with every word.";

const recordingInputs: InputSpec[] = [
  {
    id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness" },
    note: "what is said: the clip is made around it, the mouth follows it, and it is the clip's sound. Up to 14 seconds a clip; end the part in a pause so that no word is cut",
  },
  { id: "recordingStart", type: "number", label: "Recording: start", min: 0, max: 600, step: 0.1, default: 0, unit: " s", showWhen: "recording" },
  { id: "recordingSeconds", type: "number", label: "Recording: length", min: 1, max: 14, step: 0.1, default: 8, unit: " s", showWhen: "recording" },
  {
    id: "speechAt", type: "number", label: "Speech starts at", min: 0, max: 3, step: 0.25, default: 0, unit: " s", showWhen: "recording", advanced: true,
    note: "a moment of the clip before the words begin, counted after the frames of the clip before",
  },
  {
    id: "evenLoudness", type: "toggle", label: "Even out the loudness", default: true, showWhen: "recording", advanced: true,
    note: "the part is brought to a usual speaking level (EBU R128, -16 LUFS) before it is used: a quiet take guides the mouth weakly",
  },
];

/** H3's inputs with the scene in place of the dialogue, the recording after it, and no duration (the recording's length decides it). */
const lipSyncInputs: InputSpec[] = h3Inputs.flatMap((spec): InputSpec[] => {
  if (spec.id === "seconds") return [];
  if (spec.id === "description" && spec.type === "prompt") {
    return [
      { ...spec, label: "Scene", placeholder: "Nicolas at a café terrace, medium close-up, talking to the camera, calm and friendly.", note: "where they are and how they speak, without a dialogue line: the recording is what is said" },
      ...recordingInputs,
    ];
  }
  return [spec];
});

export const h3LipSync = defineRecipe<H3LipSync>({
  id: "h3.lipsync",
  family: "h3",
  version: 1,
  title: "Lip sync",
  summary: "A new shot made around a recording: the mouth follows it. Continues the clip before.",
  output: "video",
  traits: h3Video.traits,
  inputs: lipSyncInputs,
  presets: h3Video.presets,
  // the sound is put together from the model's decoded lead-in and tail around the recording (a quarter second after
  // the words, and the frame grid's rounding, always leave a tail)
  nodes: (input) => [...new Set([...h3Video.nodes(input), "LoadAudio", "MiniMaxH3AddGuide", "AudioConcat", "TrimAudioDuration"])],
  optionalNodes: h3Video.optionalNodes,
  finishing: h3Video.finishing,

  build(input, ctx) {
    // the recording's part as it was cut (a sound that ends early gives less than asked), else the length asked for
    const spoken = ctx.media.recording?.seconds ?? input.recordingSeconds;
    const lead = Math.round(input.speechAt * H3_FPS);
    // a quarter second after the last word, so that the frame grid's rounding never ends the clip on it
    const seconds = Math.min(15, Math.max(4, input.speechAt + spoken + 0.25));
    const description = [input.description.trim(), SPEAKS].filter(Boolean).join(" ");
    let recording: Ref | null = null;
    // one loader for the guide and the sound
    const loaded = (g: GraphBuilder) => (recording ??= g.out("LoadAudio", { audio: ctx.uploads.recording }));
    return buildH3({ ...input, seconds, description }, ctx, {
      guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: loaded(g), frame_idx: at.head + lead }),
      // the files' sound: the model's own for the frames before the words (the clip before's, mostly), then the recording
      // itself (continued clips decode it only roughly: 0.15 correlation, measured 2026-10-13), then the model's own again
      sound: (g, decoded, at) => {
        const before = (at.head + lead) / H3_FPS;
        const after = at.frames / H3_FPS - before - spoken;
        let sound = loaded(g);
        if (before > 0) sound = g.out("AudioConcat", { audio1: g.out("TrimAudioDuration", { audio: decoded, start_index: 0, duration: before }), audio2: sound, direction: "after" });
        if (after > 0.02) sound = g.out("AudioConcat", { audio1: sound, audio2: g.out("TrimAudioDuration", { audio: decoded, start_index: before + spoken, duration: after }), direction: "after" });
        return sound;
      },
    });
  },

  variants: ((): Variant<H3LipSync>[] => {
    const all = {
      unet: "minimax_h3_fl2va.safetensors", clip: "qwen3vl_minimax_h3.safetensors", videoVae: "minimax_h3_video_vae.safetensors", audioVae: "minimax_h3_audio_vae.safetensors",
      turbo: "minimax_h3_turbo.safetensors", rife: "rife49.pth", refUnet: "minimax_h3_ref2va.safetensors", refTurbo: "minimax_h3_ref2v_turbo.safetensors",
    };
    const joined = { width: 576, height: 1024, frames: 22, fps: H3_FPS, hasSound: true };
    return [
      {
        name: "a recording and the picture of who speaks",
        input: { description: "a café terrace", start: "p1", recording: "a1" },
        slots: all, uploads: { start: "a.png", recording: "rec.wav" }, media: { start: { width: 832, height: 1216 }, recording: { width: 0, height: 0, seconds: 5.9 } },
      },
      {
        name: "the cast, carrying on from a clip, the words a moment in",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }], recording: "a1", speechAt: 0.5, fast: false },
        slots: all, uploads: { previous: "a.mp4", "references.0": "r1.png", recording: "rec.wav" }, media: { previous: joined, recording: { width: 0, height: 0, seconds: 4.2 } },
      },
      {
        name: "a voice sample for the timbre around the recording, no smoothing",
        input: { description: "a", references: [{ asset: "r1", role: "person" }], voice: "v1", recording: "a1", smooth: false },
        slots: all, uploads: { "references.0": "r1.png", voice: "v.wav", recording: "rec.wav" },
      },
    ];
  })(),
});
