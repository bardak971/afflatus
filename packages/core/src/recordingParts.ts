/**
 * A long recording (a voice) cut into Lip sync clips: each part ends in the pause nearest the length asked, never inside a
 * word, within what one clip takes. Pure: the pauses are read from the sound by the server (ffmpeg's silencedetect).
 */

/** A pause of the recording, in seconds from its start. */
export interface Pause {
  start: number;
  end: number;
}

/** One clip's part of the recording: where it starts and how long it lasts, in seconds. */
export interface RecordingPart {
  start: number;
  seconds: number;
}

/**
 * The parts `fromS` to `toS` of a recording is cut into, each about `wantS` long and within `leastS` to `mostS`. A part ends
 * in the middle of the pause nearest its asked end, among the pauses that keep it within its bounds; with none there, at its
 * most (a monologue without a breath is cut mid-word, as little as it can be). A last part shorter than the least is taken by
 * the part before when one clip holds both, else the two share what is left evenly.
 */
export function recordingParts(o: { fromS: number; toS: number; wantS: number; leastS: number; mostS: number; pauses: Pause[] }): RecordingPart[] {
  const { fromS, toS, leastS, mostS } = o;
  const want = Math.min(Math.max(o.wantS, leastS), mostS);
  const round = (s: number) => Math.round(s * 100) / 100;
  const parts: RecordingPart[] = [];
  let at = fromS;
  for (let guard = 0; guard < 1000 && toS - at > 0.05; guard++) {
    // what is left fits one clip, and a cut near the length asked would leave less than a clip after it: one part
    if (toS - at <= mostS && toS - at - want < leastS) {
      parts.push({ start: at, seconds: toS - at });
      break;
    }
    const cuts = o.pauses.map((p) => (p.start + p.end) / 2).filter((m) => m - at >= leastS && m - at <= mostS);
    const end = cuts.length ? cuts.reduce((best, m) => (Math.abs(m - at - want) < Math.abs(best - at - want) ? m : best)) : at + mostS;
    parts.push({ start: at, seconds: end - at });
    at = end;
  }
  // a short last part: taken by the one before when one clip holds both, else shared evenly with it
  const last = parts.at(-1);
  const before = parts.at(-2);
  if (last && before && last.seconds < leastS) {
    if (before.seconds + last.seconds <= mostS) {
      parts.splice(-2, 2, { start: before.start, seconds: before.seconds + last.seconds });
    } else {
      const half = (before.seconds + last.seconds) / 2;
      parts.splice(-2, 2, { start: before.start, seconds: half }, { start: before.start + half, seconds: half });
    }
  }
  return parts.map((p) => ({ start: round(p.start), seconds: round(p.seconds) }));
}
