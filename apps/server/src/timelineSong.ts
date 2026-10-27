import { laysSound, recordingSpecOf, type CueValue, type InputSpec } from "@afflatus/core";

/**
 * The song under Lip sync clips as one track (card #131): a take whose sound is a recording laid on it plays that recording
 * itself, not its own copy of it, in the export and in the player alike, from the same parts worked out here. Each take
 * carried its own copy: its sound track ended a little before its frames (30 ms on Timeline 6's clip 7), a take after a
 * cut started as a rough copy for its first 10 to 30 ms (its encoder's start), and the player, switching videos at a cut on
 * its own timing, skipped 56 ms of the song there (2026-10-27). Played from the recording, the song runs on to the sample.
 */
export interface SoundPart {
  /** "song": the recording itself; "own": the take's own sound (a cue mixed in, the model's moment before the words, the tail of a last clip). */
  kind: "song" | "own";
  /** The sound it is read from: the recording, or the take's video. */
  asset: string;
  /** Where it plays in its clip, in ms from where the clip starts playing (its own time). */
  fromMs: number;
  toMs: number;
  /** Where it reads its sound from, in seconds of `asset`, at `fromMs`. */
  atS: number;
  /** The gain it plays at (dB): a song part at the gain its render laid the recording at; an own part at 0. */
  gainDb: number;
}

/**
 * Where a take's file sounds of its recording: the recording laid in it, and the moment of it at a time of the file (ms),
 * read off what its render was sent (`made`, the generation's inputs) by the recipe it was rendered with. Null for a take
 * whose sound is not a recording laid on it (core laysSound). The part begins after the take's head (`headMs`) and the
 * moment before the words (the window's `less`: Lip sync's Speech starts at), as the graph lays it (recordingOnClip).
 */
export function laidSong(inputs: readonly InputSpec[], made: Record<string, unknown> | undefined, headMs: number) {
  const spec = recordingSpecOf(inputs);
  if (!spec || !made || !laysSound(inputs, made)) return null;
  const asset = made[spec.id];
  const start = Number(made[spec.window.start]);
  const seconds = Number(made[spec.window.seconds]);
  if (typeof asset !== "string" || !asset || !Number.isFinite(start) || !Number.isFinite(seconds)) return null;
  const lead = (spec.window.fits?.less ?? []).reduce((sum, id) => sum + (Number(made[id]) || 0), 0);
  const w = spec.window;
  return {
    asset,
    /** The moment of the recording at a time of the file (ms). */
    at: (fileMs: number) => start + (fileMs - headMs) / 1000 - lead,
    /** Where the part is in the file (ms): before it, the head's and the moment before the words' sound; after it, the tail. */
    partFromMs: headMs + lead * 1000,
    partToMs: headMs + (lead + seconds) * 1000,
    /** The clip before sang it up to the part: the head is the recording too (the window's leadIn). */
    sungBefore: Boolean(w.leadIn && made[w.leadIn]),
    /** The next clip carries it on: the tail is the recording itself, not faded out (the window's goesOn). */
    goesOn: Boolean(w.goesOn && made[w.goesOn]),
    /** It was evened out by one gain for the whole recording (the window's even). */
    even: Boolean(w.even && made[w.even]),
  };
}

/** Where each cue's part was mixed into a take's file (ms), at the frame its render laid it (h3/cue.ts placeCues). */
export function cueStretches(cues: CueValue[] | undefined, headMs: number, fps: number): Array<{ fromMs: number; toMs: number }> {
  return (cues ?? []).map((cue) => {
    const from = headMs + (Math.round(cue.at * fps) * 1000) / fps;
    return { fromMs: from, toMs: from + cue.seconds * 1000 };
  });
}

/** Around a cue, the take's own sound a little wider: its mix begins and ends on a frame, read off a rounded moment. */
const CUE_MARGIN_MS = 20;

/**
 * A take's sound as parts (SoundPart), over what its clip plays of its file (`shown`, file ms): the recording itself where
 * the file is that recording (from the part's start, or from the head when the clip before sang it; to the part's end, or to
 * the end when the next clip carries it on), its own sound elsewhere and over each cue. `gainDb`: the gain its render laid
 * the recording at. Parts shorter than a millisecond are left out; contiguous parts of one kind are one.
 */
export function soundPartsOf(o: {
  song: NonNullable<ReturnType<typeof laidSong>>;
  take: string;
  shown: { start: number; end: number };
  gainDb: number;
  cues: Array<{ fromMs: number; toMs: number }>;
}): SoundPart[] {
  const { song, shown } = o;
  const songFrom = song.sungBefore ? -Infinity : song.partFromMs;
  const songTo = song.goesOn ? Infinity : song.partToMs;
  // where the kind changes, in file ms, within what plays
  const marks = [shown.start, shown.end, songFrom, songTo, ...o.cues.flatMap((c) => [c.fromMs - CUE_MARGIN_MS, c.toMs + CUE_MARGIN_MS])]
    .filter((m) => Number.isFinite(m) && m >= shown.start && m <= shown.end)
    .sort((a, b) => a - b);
  const isSong = (fileMs: number) => fileMs >= songFrom && fileMs < songTo && !o.cues.some((c) => fileMs >= c.fromMs - CUE_MARGIN_MS && fileMs < c.toMs + CUE_MARGIN_MS);
  const parts: SoundPart[] = [];
  for (let k = 0; k + 1 < marks.length; k++) {
    const a = marks[k]!;
    const b = marks[k + 1]!;
    if (b - a < 1) continue;
    const kind = isSong((a + b) / 2) ? "song" : "own";
    const last = parts.at(-1);
    if (last && last.kind === kind && Math.abs(last.toMs - (a - shown.start)) < 1e-6) {
      last.toMs = b - shown.start;
      continue;
    }
    parts.push(kind === "song"
      ? { kind, asset: song.asset, fromMs: a - shown.start, toMs: b - shown.start, atS: round6(song.at(a)), gainDb: o.gainDb }
      : { kind, asset: o.take, fromMs: a - shown.start, toMs: b - shown.start, atS: round6(a / 1000), gainDb: 0 });
  }
  return parts.map((p) => ({ ...p, fromMs: round3(p.fromMs), toMs: round3(p.toMs) }));
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const round3 = (x: number) => Math.round(x * 1e3) / 1e3;
