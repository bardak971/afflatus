import { defineRecipe, type GraphBuilder, type InputSpec, type Ref, type Variant } from "@afflatus/core";
import { H3_FPS, H3_MAX_FRAMES } from "./family";
import { h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video } from "./video";
import { H3_STARTS } from "./model";

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

/**
 * Seconds of the recording handed over after the part: a clip outlasts its words (a quarter second, the frame grid's
 * rounding, 4 s at least) and ends on the recording's own pause, not on the model's sound, which babbled on after the
 * words (the owner's renders, 2026-10-13). Where the recording goes on speaking, the server fades it out in 0.15 s.
 */
const AFTER = 4;
/** A quarter second after the last word, so that the frame grid's rounding never ends the clip on it. */
const PAD = 0.25;

/** The frames of the clip before the words begin. */
const leadOf = (input: H3LipSync) => Math.round(input.speechAt * H3_FPS);

/** Said after the scene: without it H3 sometimes leaves the person silent while the recording plays. */
const SPEAKS = "The person speaks throughout, the lips moving with every word.";

const recordingInputs: InputSpec[] = [
  {
    id: "recording", type: "audio", role: "sound", label: "Recording",
    window: { start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness", after: AFTER, fits: { frames: H3_MAX_FRAMES, fps: H3_FPS, pad: PAD, min: 4, less: ["speechAt"] } },
    note: "what is said: the clip is made around it, the mouth follows it, and it is the clip's sound. One clip holds about 14.8 seconds (less the moment before the words, and the frames of a clip it continues); the part's ends snap to the pauses so that no word is cut",
  },
  { id: "recordingStart", type: "number", label: "Recording: start", min: 0, max: 600, step: 0.1, default: 0, unit: " s", showWhen: "recording" },
  { id: "recordingSeconds", type: "number", label: "Recording: length", min: 1, max: 15, step: 0.1, default: 8, unit: " s", showWhen: "recording" },
  {
    id: "speechAt", type: "number", label: "Speech starts at", min: 0, max: 3, step: 0.25, default: 0, unit: " s", showWhen: "recording", advanced: true,
    note: "a moment of the clip before the words begin, counted after the frames of the clip before",
  },
  {
    id: "evenLoudness", type: "toggle", label: "Even out the loudness", default: true, showWhen: "recording", advanced: true,
    note: "the part is brought to a usual speaking level (-16 LUFS, measured as EBU R128) before it is used: a quiet take guides the mouth weakly",
  },
];

/**
 * H3's inputs with the scene in place of the dialogue, the recording after it, no duration (the recording's length decides
 * it) and no voice sample: the recording is the voice, and the cast's sample would only pull the timbre elsewhere.
 */
const lipSyncInputs: InputSpec[] = h3Inputs.flatMap((spec): InputSpec[] => {
  if (spec.id === "seconds" || spec.id === "voice" || spec.id === "voiceStart" || spec.id === "voiceSeconds" || spec.id === "voiceEven") return [];
  if (spec.id === "description" && spec.type === "prompt") {
    return [
      { ...spec, label: "Scene", placeholder: "A man at a café terrace, medium close-up, talking to the camera, calm and friendly.", note: "where they are and how they speak, without a dialogue line: the recording is what is said" },
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
  starts: H3_STARTS,
  presets: h3Video.presets,
  // the recording is cut to the clip; the model's decoded sound goes before it when the clip opens on frames of the clip
  // before or on a moment before the words. No voice sample: H3's nodes are asked without one
  nodes: (input) => [...new Set([...h3Video.nodes({ ...input, voice: undefined }), "LoadAudio", "MiniMaxH3AddGuide", "TrimAudioDuration", ...(input.previous || leadOf(input) > 0 ? ["AudioConcat"] : [])])],
  optionalNodes: h3Video.optionalNodes,
  finishing: h3Video.finishing,

  build(input, ctx) {
    // the recording's part as it was cut (a sound that ends early gives less than asked), else the length asked for
    const spoken = ctx.media.recording?.seconds ?? input.recordingSeconds;
    const lead = leadOf(input);
    const seconds = Math.min(15, Math.max(4, input.speechAt + spoken + PAD));
    const description = [input.description.trim(), SPEAKS].filter(Boolean).join(" ");
    let recording: Ref | null = null;
    // one loader, cut to the clip's frames after the words begin, for the guide and the sound
    const loaded = (g: GraphBuilder, at: { head: number; frames: number }) =>
      (recording ??= g.out("TrimAudioDuration", { audio: g.out("LoadAudio", { audio: ctx.uploads.recording }), start_index: 0, duration: (at.frames - at.head - lead) / H3_FPS }));
    // the cast's videos lend their frames only: their own sound would be a second voice beside the recording, pulling the
    // timbre away from it as a voice sample would
    const media = Object.fromEntries(Object.entries(ctx.media).map(([k, m]) => [k, k.startsWith("refVideos.") ? { ...m, hasSound: false } : m]));
    return buildH3({ ...input, voice: undefined, seconds, description }, { ...ctx, media }, {
      guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: loaded(g, at), frame_idx: at.head + lead }),
      // the files' sound: the model's own for the frames before the words (the clip before's, mostly), then the recording
      // itself to the clip's end, the pause the server handed over after the part included (continued clips decode it
      // only roughly: 0.15 correlation, measured 2026-10-13). Never the model's own after the words: it babbled on there.
      // A recording handed over without that pause (cut before 2026-10-13, or not cut) ends with its words: the file's
      // sound is that much shorter than its frames
      sound: (g, decoded, at) => {
        const before = (at.head + lead) / H3_FPS;
        const sound = loaded(g, at);
        return before > 0 ? g.out("AudioConcat", { audio1: g.out("TrimAudioDuration", { audio: decoded, start_index: 0, duration: before }), audio2: sound, direction: "after" }) : sound;
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
        name: "the recording handed over with its pause after the part, no smoothing",
        input: { description: "a", references: [{ asset: "r1", role: "person" }], recording: "a1", smooth: false },
        slots: all, uploads: { "references.0": "r1.png", recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 6.3, after: AFTER } },
      },
    ];
  })(),
});
