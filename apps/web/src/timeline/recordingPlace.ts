import type { Clip, RecipeInfo } from "../api";
import type { Slot } from "./model";
import { recordingInput } from "./track/RecordingBand";

/** One clip's part of a recording, and where it plays on the track. */
export interface RecordingPart {
  clip: Clip;
  /** The clip's number on the timeline (from 1). */
  number: number;
  /** Its part of the recording, in ms of the recording. */
  startMs: number;
  endMs: number;
  /** Where the part's first moment plays, in the track's own time (after the moment before the words, `speechAt`). */
  trackMs: number;
  /** Where its clip lies on the track (as the track draws it: a clip not rendered yet at the length it will have). */
  clipFromMs: number;
  clipToMs: number;
}

/**
 * A recording laid under its Lip sync clips (the recording's stage): its clips' parts, the stretch they use, and where a
 * moment of it plays on the track and the other way round. Within a part, the recording runs with the clip; between two
 * parts (a clip that outlasts its words) the track goes on while the recording waits at the next part's start; before
 * the first and past the last it runs on from them, as the source runs on past its stretch. Null when no clip of the
 * timeline is made of it. Read off the track's slots: a clip not rendered yet has no place of its own (`atMs` 0), only the one
 * the track draws it at.
 */
export function recordingPlace(slots: Slot[], recipes: RecipeInfo[], asset: string, lengthMs?: number | null): RecordingPlace | null {
  const mine = slots.filter((s) => {
    const input = recordingInput(recipes.find((r) => r.id === s.clip.recipe));
    return Boolean(input && s.clip.inputs[input.id] === asset);
  });
  const input = recordingInput(recipes.find((r) => r.id === mine[0]?.clip.recipe));
  if (!mine.length || !input) return null;
  const parts: RecordingPart[] = mine.map((s) => {
    const c = s.clip;
    const startMs = Math.round(Number(c.inputs[input.start] ?? 0) * 1000);
    const lead = input.lead.reduce((sum, id) => sum + (Number(c.inputs[id]) || 0), 0) * 1000;
    return { clip: c, number: s.index + 1, startMs, endMs: startMs + Math.round(Number(c.inputs[input.seconds] ?? 0) * 1000), trackMs: s.startMs + lead, clipFromMs: s.startMs, clipToMs: s.startMs + s.lengthMs };
  });
  const first = parts[0]!;
  const last = parts.at(-1)!;
  const length = lengthMs ?? last.endMs;
  const toTrack = (ms: number) => {
    if (ms < first.startMs) return first.trackMs - (first.startMs - ms);
    const p = parts.find((x) => ms >= x.startMs && ms < x.endMs) ?? (ms >= last.endMs ? last : parts.find((x) => ms < x.startMs)!);
    return p.trackMs + (ms - p.startMs);
  };
  const toRecording = (trackMs: number) => {
    let ms: number;
    if (trackMs < first.trackMs) ms = first.startMs - (first.trackMs - trackMs);
    else {
      // the last part that starts by then: within it, or past its words (the next part's start, or the recording running on)
      const p = [...parts].reverse().find((x) => trackMs >= x.trackMs)!;
      const at = p.startMs + (trackMs - p.trackMs);
      const next = parts[parts.indexOf(p) + 1];
      ms = at < p.endMs || !next ? at : next.startMs;
    }
    return Math.max(0, Math.min(length, ms));
  };
  return { parts, fromMs: first.startMs, toMs: last.endMs, lengthMs: length, toTrack, toRecording };
}

export interface RecordingPlace {
  parts: RecordingPart[];
  /** The stretch its clips use (In and Out), in ms of the recording. */
  fromMs: number;
  toMs: number;
  /** The whole recording. */
  lengthMs: number;
  /** Where a moment of the recording plays on the track. */
  toTrack(ms: number): number;
  /** The moment of the recording heard where the playhead stands on the track. */
  toRecording(trackMs: number): number;
}

/** The part a moment of the recording is in (its clip's), if any. */
export function partAt(place: RecordingPlace, ms: number): RecordingPart | undefined {
  return place.parts.find((p) => ms >= p.startMs && ms < p.endMs) ?? (ms === place.toMs ? place.parts.at(-1) : undefined);
}

/**
 * Where what the stage plays in place of the clips (the source while its panel is open, a recording open) ends on the
 * track; null when it plays the clips. The transport runs to it, and the track is drawn out to it.
 */
export function stageEnd(sourceOpen: boolean, source: { atMs: number; lengthMs: number } | null | undefined, recording: RecordingPlace | null | undefined): number | null {
  if (sourceOpen && source) return source.atMs + source.lengthMs;
  return recording ? recording.toTrack(recording.lengthMs) : null;
}
