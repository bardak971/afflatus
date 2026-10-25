import { leadInCovers, type BuildContext, type GraphBuilder, type InputSpec, type Ref } from "@afflatus/core";
import { H3_FPS, H3_MAX_FRAMES } from "./family";

/**
 * A recording's part laid on an H3 clip's sound, shared by the forms a clip under a recording takes (card #72): Lip sync,
 * whose mouth follows it, and Video with audio, which it plays over unchanged (a cutaway, someone listening). The same
 * inputs under the same ids on both, so that a clip keeps its part, its place in the recording and the song's hand-over
 * whichever of them it is in; and the same sound in the take's files, so that the player and the export play the
 * recording across both alike.
 */
export interface H3Recording {
  recording?: string;
  recordingStart: number;
  recordingSeconds: number;
  evenLoudness: boolean;
  /** Set by a timeline: the next clip carries the recording on from this one's end (a song). */
  recordingGoesOn?: boolean;
  /** Set by a timeline: the clip before sang the recording up to this part, and the head is filed with it. */
  recordingLeadIn?: boolean;
}

/**
 * Seconds of the recording handed over after the part: a clip outlasts its words (a quarter second, the frame grid's
 * rounding, 4 s at least) and ends on the recording's own pause, not on the model's sound, which babbled on after the
 * words (the owner's renders, 2026-10-13). Where the recording goes on speaking, the server fades it out in 0.15 s, unless
 * the next clip carries the recording on (recordingGoesOn): then the tail is the recording itself.
 */
export const RECORDING_AFTER = 4;
/** A quarter second after the last word, so that the frame grid's rounding never ends the clip on it. */
export const RECORDING_PAD = 0.25;

/**
 * The recording's inputs: the recording and its part, Even out the loudness, and the two toggles a timeline sets for a
 * song carried across clips. `shown`: Lip sync's form draws them (the recording is what it is made around); on another
 * form they are the clip's place in the recording, set by the timeline and never drawn (internal). `less`: the number
 * inputs a part is shortened by (Lip sync's moment before the words), placed after its length.
 */
export function recordingInputs(o: { shown: boolean; less?: InputSpec[] }): InputSpec[] {
  const hidden = o.shown ? {} : { internal: true };
  return [
    {
      id: "recording", type: "audio", role: "sound", label: "Recording", ...(o.shown ? {} : { optional: true, internal: true }),
      window: {
        start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness", after: RECORDING_AFTER, goesOn: "recordingGoesOn", leadIn: "recordingLeadIn",
        fits: { frames: H3_MAX_FRAMES, fps: H3_FPS, pad: RECORDING_PAD, min: 4, ...(o.less?.length ? { less: o.less.map((i) => i.id) } : {}) },
      },
      note: o.shown
        ? "what is said: the clip is made around it, the mouth follows it, and it is the clip's sound. One clip holds about 14.8 seconds (less the moment before the words, and the frames of a clip it continues); the part's ends snap to the pauses so that no word is cut"
        : "the recording the clip is under: its part is the clip's sound, laid over H3's own",
    },
    { id: "recordingStart", type: "number", label: "Recording: start", min: 0, max: 600, step: 0.1, default: 0, unit: " s", showWhen: "recording", ...hidden },
    { id: "recordingSeconds", type: "number", label: "Recording: length", min: 1, max: 15, step: 0.1, default: 8, unit: " s", showWhen: "recording", ...hidden },
    ...(o.less ?? []),
    {
      id: "evenLoudness", type: "toggle", label: "Even out the loudness", default: true, showWhen: "recording", advanced: true, ...hidden,
      note: "the recording is brought to a usual speaking level (-16 LUFS, EBU R128) by one gain for all of it, the same in every clip: a quiet take guides the mouth weakly",
    },
    // set by a timeline when the next clip's part carries on from this one's end (a song): the clip's tail is the recording
    // itself, sung, not faded out, and the next clip picks up where it stops (TimelinePlan.recordingRun)
    { id: "recordingGoesOn", type: "toggle", label: "Recording goes on in the next clip", default: false, internal: true },
    // set by a timeline when the clip before sang the recording right up to this part: its head (the frames they share) is
    // filed with the recording before the part, the moments that clip sang, not the model's rough guess at them
    { id: "recordingLeadIn", type: "toggle", label: "Recording sung up to this part by the clip before", default: false, internal: true },
  ];
}

/**
 * The nodes laying a recording adds to an H3 clip: its loader and cut, and the join to the model's sound before the part
 * (`joined`: frames before it, and no lead-in: a clip the one before sang up to its part is filed with the recording whole,
 * as the timeline sets the lead-in only where it covers them, leadInCovers).
 */
export const recordingNodes = (o: { joined: boolean }) => ["LoadAudio", "TrimAudioDuration", ...(o.joined ? ["AudioConcat"] : [])];

/**
 * The recording's part on an H3 clip whose part begins `lead` frames after its head (Lip sync's moment before the words;
 * none on a clip it plays over): how long the clip lasts, the part cut to the clip's frames (Lip sync's guide), and the
 * sound its files carry in place of the decoded one.
 */
export function recordingOnClip(input: Pick<H3Recording, "recordingSeconds">, ctx: BuildContext, lead: number) {
  // the recording's part as it was cut (a sound that ends early gives less than asked), else the length asked for
  const spoken = ctx.media.recording?.seconds ?? input.recordingSeconds;
  // the recording handed over before the part (its lead-in, recordingLeadIn): the part starts this far into the file
  const pre = ctx.media.recording?.before ?? 0;
  let file: Ref | null = null;
  let part: Ref | null = null;
  // one loader; the part cut to the clip's frames after the part begins, for the guide and the sound
  const whole = (g: GraphBuilder) => (file ??= g.out("LoadAudio", { audio: ctx.uploads.recording }));
  const loaded = (g: GraphBuilder, at: { head: number; frames: number }) =>
    (part ??= g.out("TrimAudioDuration", { audio: whole(g), start_index: pre, duration: (at.frames - at.head - lead) / H3_FPS }));
  return {
    seconds: Math.min(15, Math.max(4, lead / H3_FPS + spoken + RECORDING_PAD)),
    loaded,
    // the files' sound: the model's own for the frames before the part (the clip before's, mostly), then the recording
    // itself to the clip's end, the pause the server handed over after the part included (continued clips decode it
    // only roughly: 0.15 correlation, measured 2026-10-13). Never the model's own after the part begins: on Lip sync it
    // babbled on after the words, and on a clip the recording plays over it is H3's own music or speech, dropped.
    // A recording handed over without that pause (cut before 2026-10-13, or not cut) ends with its words: the file's
    // sound is that much shorter than its frames
    sound: (g: GraphBuilder, decoded: Ref, at: { head: number; frames: number }): Ref => {
      const before = (at.head + lead) / H3_FPS;
      // the clip before sang the recording up to the part: the head is filed with it too, the whole clip one stretch of the
      // recording. The model's guess there was heard at the join, where one frame of the head shows (a song's, 2026-10-24).
      // The timeline asks for it by the same sum (leadInCovers), so that a take it says is sung was made so
      if (leadInCovers(pre, at.head + lead, H3_FPS)) return g.out("TrimAudioDuration", { audio: whole(g), start_index: pre - before, duration: at.frames / H3_FPS });
      const sound = loaded(g, at);
      return before > 0 ? g.out("AudioConcat", { audio1: g.out("TrimAudioDuration", { audio: decoded, start_index: 0, duration: before }), audio2: sound, direction: "after" }) : sound;
    },
  };
}
