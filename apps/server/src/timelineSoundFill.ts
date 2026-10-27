import { laysSound, recordingSpecOf, type InputSpec } from "@afflatus/core";

/**
 * A take under a recording whose own sound stops short of its frames, filled from the recording itself where its clip
 * meets no clip carrying on (a cut, the timeline's end). Its sound track ends a little before its last frame (the
 * encoder's last packet: 30 ms on Timeline 6's clip 7, 2026-10-27), and a cut after it played that much silence, in the
 * middle of a sung line. A clip that carries on takes the sound over before then (core soundHandover, its sung head), so a
 * join that carries on is never given one: its sound stays as it was.
 */
export interface SoundFill {
  /** The recording laid in the take. */
  asset: string;
  /** Where the take's own sound ends, in its video's time (ms): the fill plays from there. */
  fromMs: number;
  /** How long it lasts (ms): to where the clip stops playing. */
  ms: number;
  /** The moment of the recording at `fromMs` (seconds into it). */
  songS: number;
  /** The gain (dB) bringing the recording to the take's own level there (cut.ts soundTailOf). */
  gainDb: number;
}

/** The most a fill covers: a take's sound short by more is something else (a sound cut off), left as it is. */
export const FILL_MOST_MS = 250;
/** Under this, nothing is heard missing. */
const FILL_LEAST_MS = 2;

/**
 * Where a take's file sounds of its recording: the recording laid in it, and the moment of it at a time of the file (ms),
 * read off what its render was sent (`made`, the generation's inputs) by the recipe it was rendered with. Null for a take
 * whose sound is not a recording laid on it (core laysSound). The part begins after the take's head (`headMs`) and the
 * moment before the words (the window's `less`: Lip sync's Speech starts at), as the graph lays it (recordingOnClip).
 */
export function laidSong(inputs: readonly InputSpec[], made: Record<string, unknown> | undefined, headMs: number): { asset: string; at: (fileMs: number) => number } | null {
  const spec = recordingSpecOf(inputs);
  if (!spec || !made || !laysSound(inputs, made)) return null;
  const asset = made[spec.id];
  const start = Number(made[spec.window.start]);
  if (typeof asset !== "string" || !asset || !Number.isFinite(start)) return null;
  const lead = (spec.window.fits?.less ?? []).reduce((sum, id) => sum + (Number(made[id]) || 0), 0);
  return { asset, at: (fileMs) => start + (fileMs - headMs) / 1000 - lead };
}

/**
 * The fill a clip's take gets (SoundFill), or null: its own sound heard ("own", the take with a sound), laid from a
 * recording, the clip after not carrying on from it (none, a cut, a still) and no transition into it, and its sound (`tail`,
 * measured) ending between FILL_LEAST_MS and FILL_MOST_MS before where the clip stops playing (`endMs`, its video's time).
 */
export function soundFillOf(o: {
  sound: string;
  hasSound: boolean;
  song: ReturnType<typeof laidSong>;
  endMs: number;
  nextCarriesOn: boolean;
  tail: { soundMs: number; gainDb: number } | null;
}): SoundFill | null {
  if (o.sound !== "own" || !o.hasSound || !o.song || o.nextCarriesOn || !o.tail) return null;
  const ms = o.endMs - o.tail.soundMs;
  if (ms < FILL_LEAST_MS || ms > FILL_MOST_MS) return null;
  const songS = o.song.at(o.tail.soundMs);
  if (!(songS >= 0)) return null;
  return { asset: o.song.asset, fromMs: o.tail.soundMs, ms: Math.round(ms * 1000) / 1000, songS: Math.round(songS * 1e6) / 1e6, gainDb: o.tail.gainDb };
}

/**
 * Whether the clip after (`next`) carries on from this one, or plays over the join: a video clip joined "continue" (its
 * sound takes over from its head, or it lands), or any clip with a transition into it (the sound faded over the join).
 * Neither is filled.
 */
export const carriesOn = (next: { kind: string; joined: string; transition: unknown } | undefined) => Boolean(next && (next.transition || (next.kind === "video" && next.joined === "continue")));
