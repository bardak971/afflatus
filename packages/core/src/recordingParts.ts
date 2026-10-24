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
 * in the middle of the pause nearest its asked end, among the pauses that keep it within its bounds; with none there, at the
 * length asked (a song's music never pauses: cut at the most, its parts were all 14.8 s whatever length was asked). A last
 * part shorter than the least is taken by the part before when one clip holds both, else the two share what is left evenly.
 * `snap` false (the recording's panel, Snap to pauses off): every part the length asked, wherever the words are.
 */
export function recordingParts(o: { fromS: number; toS: number; wantS: number; leastS: number; mostS: number; pauses: Pause[]; snap?: boolean }): RecordingPart[] {
  const { fromS, toS, leastS, mostS } = o;
  const want = Math.min(Math.max(o.wantS, leastS), mostS);
  const round = (s: number) => Math.round(s * 100) / 100;
  const parts: RecordingPart[] = [];
  let at = fromS;
  for (let guard = 0; guard < 1000 && toS - at > 0.05; guard++) {
    const end = o.snap === false ? evenEnd(at, toS, want, leastS, mostS) : endOf(at, toS, want, leastS, mostS, o.pauses);
    parts.push({ start: at, seconds: end - at });
    if (end >= toS) break;
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

/**
 * The one part of a recording a single clip takes (a voice given to one Lip sync clip): the whole of it from `fromS`, as
 * much as one clip holds, ended in the pause nearest that most when it is longer, else at the most. Not the first of
 * recordingParts: that one shares a short last part evenly with the part before, which suits a row of clips, but halved
 * the single clip a voice fills (a 16 s voice without a pause gave it 8 s, where 14.83 fit).
 */
export function recordingPart(o: { fromS: number; toS: number; leastS: number; mostS: number; pauses: Pause[] }): RecordingPart | null {
  if (o.toS - o.fromS <= 0.05) return null;
  const end = endOf(o.fromS, o.toS, o.mostS, o.leastS, o.mostS, o.pauses);
  return { start: Math.round(o.fromS * 100) / 100, seconds: Math.round((end - o.fromS) * 100) / 100 };
}

/** Where the part from `at` ends when it is not snapped to a pause: `want` later, or the end when what is left fits one clip. */
function evenEnd(at: number, toS: number, want: number, leastS: number, mostS: number): number {
  return toS - at <= mostS && toS - at - want < leastS ? toS : Math.min(at + want, toS);
}

/** Where the part from `at`, about `want` long, ends (in seconds of the recording). */
function endOf(at: number, toS: number, want: number, leastS: number, mostS: number, pauses: Pause[]): number {
  // what is left fits one clip, and a cut near the length asked would leave less than a clip after it: one part
  if (toS - at <= mostS && toS - at - want < leastS) return toS;
  // a pause past the end (a recording trimmed, its Out before the words go on) is no place to cut: a part made to it
  // would render the words trimmed off, and one past the recording's end would say a length the sound has not
  const cuts = pauses.map((p) => (p.start + p.end) / 2).filter((m) => m - at >= leastS && m - at <= mostS && m < toS);
  // no pause within reach: the length asked, as with Snap to pauses off (a single clip's part asks for the most: recordingPart)
  return cuts.length ? cuts.reduce((best, m) => (Math.abs(m - at - want) < Math.abs(best - at - want) ? m : best)) : Math.min(at + want, toS);
}
