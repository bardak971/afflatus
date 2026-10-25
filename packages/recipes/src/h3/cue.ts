import type { BuildContext, CueValue, GraphBuilder, Ref } from "@afflatus/core";
import { H3_FPS } from "./family";

/** How many sound cues one clip takes. */
export const H3_CUES = 6;
/** Whose sound the take's file carries at a cue: the cue's own part laid in (the first, the usual one), or H3's. */
export const CUE_SOUND = ["The file's sound", "H3's own"] as const;

/** The ComfyUI nodes the cues add: the part loaded and fitted, pinned at its frame, and laid into the file's sound. */
export const cueNodes = (input: { cues?: CueValue[]; cueSound?: string }): string[] =>
  input.cues?.length ? ["LoadAudio", "TrimAudioDuration", "MiniMaxH3AddGuide", ...(laysCues(input) ? ["AudioConcat"] : [])] : [];

/**
 * What the cues add where they are mixed over a sound that is a file of its own (a lip sync's recording, a swap's or a Motion
 * transfer's source sound kept): said by those recipes' nodes(), which know their forms. nodes() sees the form alone: a source
 * with no sound of its own is listed as one with it, as their own nodes list it.
 */
export const cueMixNodes = (input: { cues?: CueValue[]; cueSound?: string }): string[] => (input.cues?.length && laysCues(input) ? ["AudioMerge"] : []);

/** Whether the take's file carries each cue's own part (the usual), rather than H3's own sound at it. */
export const laysCues = (input: { cueSound?: string }) => (input.cueSound ?? CUE_SOUND[0]) === CUE_SOUND[0];

/** A cue as the clip takes it: its frame among the clip's (the head counted) and how long it lasts there. */
interface Placed {
  index: number;
  /** The frame it lands on, counted from the clip's first frame, the frames shared with the clip before included. */
  frame: number;
  /** Seconds of its part that fit before the clip's own end. */
  seconds: number;
}

const said = (s: number) => `${Number(s.toFixed(2))} s`;

/**
 * Each cue placed on the clip: its moment is in the clip's own time, after the frames it shares with the clip before (`head`),
 * and before those it lands on of the clip after (`tail`). One landing at or past the clip's own end is refused in words; one
 * that starts inside and runs past it is cut at the end. `fps`: the model's (H3's unless said: LTX's Lip sync lays them too).
 */
export function placeCues(cues: CueValue[], ctx: BuildContext, at: { head: number; tail: number; frames: number; fps?: number }): Placed[] {
  const fps = at.fps ?? H3_FPS;
  const own = at.frames - at.head - at.tail;
  return cues.map((cue, index) => {
    const frame = Math.round(cue.at * fps);
    if (frame >= own) throw new Error(`Sound cue ${index + 1} lands at ${said(cue.at)}, past the clip's end (${said(own / fps)}). Move it inside the clip, or make the clip longer.`);
    // the part as it was cut (a sound that ends early gives less than asked), else the length asked for
    const cut = ctx.media[`cues.${index}`]?.seconds ?? cue.seconds;
    return { index, frame: at.head + frame, seconds: Math.min(cut, (own - frame) / fps) };
  });
}

/** Each cue's part, loaded once and fitted to the clip: the guide hears what the file carries. */
function cueParts(g: GraphBuilder, ctx: BuildContext, placed: Placed[]): Map<number, Ref> {
  return new Map(placed.map((p) => [p.index, g.out("TrimAudioDuration", { audio: g.out("LoadAudio", { audio: ctx.uploads[`cues.${p.index}`] }), start_index: 0, duration: p.seconds })]));
}

/**
 * The cues on the conditioning: each part alone, no picture, pinned at its frame (MiniMaxH3AddGuide). Measured on a test pod
 * (card #79): the hit lands on the frame asked, exactly; the picture meets it only when the prompt names the event.
 */
export function guideCues(g: GraphBuilder, placed: Placed[], parts: Map<number, Ref>, at: { positive: Ref; latent: Ref; vae: Ref; audioVae: Ref }): Ref {
  let positive = at.positive;
  for (const p of placed) positive = g.out("MiniMaxH3AddGuide", { positive, latent: at.latent, vae: at.vae, audio_vae: at.audioVae, audio: parts.get(p.index)!, frame_idx: p.frame });
  return positive;
}

/**
 * The file's sound with each cue's part laid in at its moment. Over H3's own sound the part takes its place for as long as it
 * lasts: H3 at times makes the file itself there, with its polarity flipped (the door slam of card #79, r 0.92), and the two
 * added would cancel out. Over a sound that is a file of its own (`over`: a lip sync's recording, a swap's source sound) it is
 * added, the recording playing on under it; mixed over the cue's own stretch only, since ComfyUI's AudioMerge scales its whole
 * result down when the sum clips, and the rest of the recording keeps its level. ComfyUI's TrimAudioDuration refuses an empty
 * stretch: a cue at the very start has nothing before it, and one that ends with the clip nothing after it.
 */
export function layCues(g: GraphBuilder, sound: Ref, placed: Placed[], parts: Map<number, Ref>, at: { frames: number; over: boolean; fps?: number }): Ref {
  const fps = at.fps ?? H3_FPS;
  const total = at.frames / fps;
  for (const p of placed) {
    const from = p.frame / fps;
    const till = from + p.seconds;
    const part = parts.get(p.index)!;
    const laid = at.over ? g.out("AudioMerge", { audio1: g.out("TrimAudioDuration", { audio: sound, start_index: from, duration: p.seconds }), audio2: part, merge_method: "add" }) : part;
    const before = from > 0 ? g.out("AudioConcat", { audio1: g.out("TrimAudioDuration", { audio: sound, start_index: 0, duration: from }), audio2: laid, direction: "after" }) : laid;
    // past the clip's end the base may already have stopped (a recording ending with its words): nothing after then
    sound = till < total - 0.05 ? g.out("AudioConcat", { audio1: before, audio2: g.out("TrimAudioDuration", { audio: sound, start_index: till, duration: total - till }), direction: "after" }) : before;
  }
  return sound;
}

/** The cues of a clip, placed and loaded, ready for its guide and its sound; null with none. */
export function cuesFor(g: GraphBuilder, ctx: BuildContext, cues: CueValue[] | undefined, at: { head: number; tail: number; frames: number; fps?: number }): { placed: Placed[]; parts: Map<number, Ref> } | null {
  if (!cues?.length) return null;
  const placed = placeCues(cues, ctx, at);
  return { placed, parts: cueParts(g, ctx, placed) };
}
