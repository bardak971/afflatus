import { defineRecipe, type InputSpec, type Variant } from "@afflatus/core";
import { H3_FPS } from "./family";
import { RECORDING_AFTER, recordingInputs, recordingNodes, recordingOnClip, type Recording } from "../shared/recording";
import { H3_NO_TAGS, REF_VIDEOS_WHAT, h3Inputs, type H3Video } from "./inputs";
import { buildH3, h3Video } from "./video";
import { isH3Layout } from "./prompt";
import { H3_STARTS, referenceNeeds, turboNeeds, vedaNeeds } from "./model";
import { latentUpscaleNeeds } from "./latent-upscale";
import { upscaleNeeds } from "../video/upscale";
import { rifeNeeds } from "../shared/finish";
import { FACE_REFINE_SLOTS, faceRefineNeeds } from "./faceRefine";
import { cueMixNodes } from "./cue";

/**
 * MiniMax H3 · Lip sync: a new shot made around a recording. The recording is laid on the clip's sound where the clip's
 * own part begins (MiniMaxH3AddGuide), so the mouth follows the words; the clip lasts as long as the recording, and its
 * files carry the recording itself. Everything else is H3's clip: the cast, the clip before continued in its latent,
 * Turbo, the finishes. Tested 2026-10-13 (HANDOVER-swap-lipsync-report.md §8): three chained clips cut in the
 * recording's pauses joined at 1.8 (the app flags 3), lip-sync confidence 4.4 to 5.4.
 */
export interface H3LipSync extends H3Video, Recording {
  recording: string;
  speechAt: number;
}

/** The frames of the clip before the words begin. */
const leadOf = (input: H3LipSync) => Math.round(input.speechAt * H3_FPS);

/** Said after the scene: without it H3 sometimes leaves the person silent while the recording plays. */
const SPEAKS = "The person speaks throughout, the lips moving with every word.";

/**
 * The scene with SPEAKS after it. A prompt in H3's own layout is sent as written, its last section the music: there the
 * sentence goes at the end of its description section (the reference model's or the other's), not into the music where it
 * was lost (B21); a layout with no description section is left as it is.
 */
export function withSpeaks(description: string): string {
  const text = description.trim();
  if (!isH3Layout(text)) return [text, SPEAKS].filter(Boolean).join(" ");
  const field = /((?:integrated_multimodal_description|detailed_description):[\s\S]*?)(?=\n\s*\n\s*\w+:|$)/i.exec(text);
  if (!field) return text;
  const end = field.index + field[1]!.trimEnd().length;
  return `${text.slice(0, end)} ${SPEAKS}${text.slice(end)}`;
}

const speechAt: InputSpec = {
  id: "speechAt", type: "number", label: "Speech starts at", min: 0, max: 3, step: 0.25, default: 0, unit: " s", showWhen: "recording", advanced: true,
  note: "a moment of the clip before the words begin, counted after the frames of the clip before",
};

/**
 * H3's inputs with the scene in place of the dialogue, the recording after it, no duration (the recording's length decides
 * it) and no voice sample: the recording is the voice, and the cast's sample would only pull the timbre elsewhere.
 */
const lipSyncInputs: InputSpec[] = h3Inputs.flatMap((spec): InputSpec[] => {
  // nor In the take: the file's sound is always the recording, so each cue's part is laid over it (H3's own is not in it, B12)
  if (spec.id === "seconds" || spec.id === "voice" || spec.id === "voiceStart" || spec.id === "voiceSeconds" || spec.id === "voiceEven" || spec.id === "cueSound") return [];
  if (spec.id === "description" && spec.type === "prompt") {
    return [
      { ...spec, label: "What happens", placeholder: "A man at a café terrace, medium close-up, talking to the camera, calm and friendly.", note: `where they are and how they speak, without a dialogue line: the recording is what is said. ${H3_NO_TAGS}` },
      ...recordingInputs({ shown: true, less: [speechAt] }),
    ];
  }
  // the recording is the voice: no reference video gives its sound here (build)
  if (spec.id === "refVideos") return [{ ...spec, note: `${REF_VIDEOS_WHAT} Their sound is left out: the recording is the voice` }];
  return [spec];
});

export const h3LipSync = defineRecipe<H3LipSync>({
  // Turbo's LoRA, the reference model for a clip with the cast, H3's latent upscaler for an upscale with it, Face refine's
  // files (built by buildH3, as a clip is)
  needsWith: (input, slots) => [...turboNeeds(input, slots), ...referenceNeeds(input, slots), ...vedaNeeds(input, slots), ...latentUpscaleNeeds(input), ...upscaleNeeds(input), ...rifeNeeds(input.smooth), ...faceRefineNeeds(input, { picture: Boolean(input.start && !input.previous) })],
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
  nodes: (input) => [...new Set([...h3Video.nodes({ ...input, voice: undefined, recording: undefined }), "MiniMaxH3AddGuide", ...recordingNodes({ joined: (Boolean(input.previous) || leadOf(input) > 0) && !input.recordingLeadIn }), ...cueMixNodes(input)])],
  optionalNodes: h3Video.optionalNodes,
  finishing: h3Video.finishing,

  build(input, ctx) {
    const lead = leadOf(input);
    const laid = recordingOnClip(input, ctx, lead);
    const description = withSpeaks(input.description);
    // the cast's videos lend their frames only: their own sound would be a second voice beside the recording, pulling the
    // timbre away from it as a voice sample would
    const media = Object.fromEntries(Object.entries(ctx.media).map(([k, m]) => [k, k.startsWith("refVideos.") ? { ...m, hasSound: false } : m]));
    return buildH3({ ...input, voice: undefined, seconds: laid.seconds, description }, { ...ctx, media }, {
      guide: (g, at) => g.out("MiniMaxH3AddGuide", { positive: at.positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: laid.loaded(g, at), frame_idx: at.head + lead }),
      sound: laid.sound,
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
        name: "Veda's sparse attention on a recording",
        input: { description: "a café terrace", start: "p1", recording: "a1", veda: true, vedaGenerated: 24, vedaReference: 40, shot: "Close-up" },
        slots: { ...all, ...{ veda: "minimax_h3_r2va_veda_preview_fp8.safetensors", vedaT2va: "minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors" } }, uploads: { start: "a.png", recording: "rec.wav" }, media: { start: { width: 832, height: 1216 }, recording: { width: 0, height: 0, seconds: 5.9 } },
      },
      {
        name: "Face refine of the cast person (a Finish of it loads its own latent)",
        input: { description: "a", references: [{ asset: "r1", role: "person" }], recording: "a1", faceRefine: true },
        slots: { ...all, ...FACE_REFINE_SLOTS }, uploads: { recording: "rec.wav", "references.0": "r1.png", "self.latent": "own.safetensors" }, media: { recording: { width: 0, height: 0, seconds: 5.9 } },
      },
      {
        name: "the cast, carrying on from a clip, the words a moment in",
        input: { description: "a", previous: { asset: "c1" }, references: [{ asset: "r1", role: "person" }], recording: "a1", speechAt: 0.5, fast: false },
        slots: all, uploads: { previous: "a.mp4", "references.0": "r1.png", recording: "rec.wav" }, media: { previous: joined, recording: { width: 0, height: 0, seconds: 4.2 } },
      },
      {
        name: "the recording handed over with its pause after the part, no smoothing",
        input: { description: "a", references: [{ asset: "r1", role: "person" }], recording: "a1", smooth: false },
        slots: all, uploads: { "references.0": "r1.png", recording: "rec.wav" }, media: { recording: { width: 0, height: 0, seconds: 6.3, after: RECORDING_AFTER } },
      },
      {
        // added over the recording, which plays on under it
        name: "a sound cue over the recording",
        input: { description: "a", start: "p1", recording: "a1", cues: [{ asset: "s1", start: 0, seconds: 0.6, at: 2.4 }] },
        slots: all, uploads: { start: "a.png", recording: "rec.wav", "cues.0": "door.wav" }, media: { start: { width: 832, height: 1216 }, recording: { width: 0, height: 0, seconds: 5.9 }, "cues.0": { width: 0, height: 0, seconds: 0.6 } },
      },
    ];
  })(),
});
