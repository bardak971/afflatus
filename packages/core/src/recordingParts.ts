/**
 * A long recording (a voice, a song) cut into Lip sync clips: each part ends at the best spot within the length asked ± a
 * window, within what one clip takes: a pause, else the end of a timed lyric line, else the quietest moment. Pure: the
 * pauses (ffmpeg's silencedetect), the lines (the file's subtitle track) and the loudness are read by the server.
 */

import { gridAtOrBefore, type FrameGrid } from "./frameGrid";

/** A pause of the recording, in seconds from its start. */
export interface Pause {
  start: number;
  end: number;
}

/** A timed line the sound file carries (Suno's m4a: a mov_text track of its lyrics), in seconds from its start. */
export interface LyricLine {
  start: number;
  end: number;
}

/** The recording's loudness, `rate` samples a second, in dB (about -60 is silence). */
export interface Loudness {
  rate: number;
  db: number[];
}

/** One clip's part of the recording: where it starts and how long it lasts, in seconds. */
export interface RecordingPart {
  start: number;
  seconds: number;
}

/** Where a part ended: in a pause, at a lyric line's end, at the quietest moment of its window, or at the length asked. */
export type CutOn = "pause" | "line" | "quiet" | "length";

/** The window a recording is cut in as it is dropped: the length asked ± 1.5 s. */
export const CUT_WINDOW = 1.5;
/** The widest window the recording's panel takes: past it, a clip's length is anything its model holds. */
export const CUT_WINDOW_MOST = 5;

/** What a recording is cut at, besides its length: its pauses, its timed lines, its loudness. */
export interface CutMarks {
  pauses: Pause[];
  lines?: LyricLine[];
  levels?: Loudness | null;
}

/**
 * Where a clip of the model can end: its frame counts (`grid`, at `fps`) less the frames it shares with the clip before
 * (`head`: the run-up it carries on from; `firstHead` for the first part, none when it opens on a cut). A clip that carries
 * on plays from the end of its head to the end of its take, and the next one takes over there, in the kept latent: so a
 * part can only end that many whole steps after it starts (H3: 17 frames, 0.71 s; a part between two others, a multiple
 * of it). Cut anywhere else, the take ran on to its next step, the next part started there, and the cuts slid off the
 * lyric lines further at every clip (+68, +159, +351 ms on three clips of a song, 2026-10-27).
 */
export interface ClipGrid {
  fps: number;
  grid: FrameGrid;
  head: number;
  firstHead: number;
}

/**
 * The parts `fromS` to `toS` of a recording is cut into, each about `wantS` long and within `leastS` to `mostS`. A part ends
 * within `windowS` of its asked end (CUT_WINDOW by default; 0: every part the length asked, wherever the words are), at the
 * best spot there: the middle of the pause nearest the asked end, else the end of the lyric line nearest it, else the
 * quietest moment of the window (a song's breath between phrases), else the length asked. Only within the window: a pause
 * anywhere within the bounds won before, and the closing pause of a song, 13 s away, made a last part of 14 s. A last part
 * shorter than the least is taken by the part before when one clip holds both, else the two share what is left evenly.
 * With the model's `clipGrid`, each end but the last is then brought to the nearest moment a clip can end on (onClipGrid).
 */
export function recordingParts(o: { fromS: number; toS: number; wantS: number; leastS: number; mostS: number; windowS?: number; clipGrid?: ClipGrid } & CutMarks): RecordingPart[] {
  const { fromS, toS, leastS, mostS } = o;
  const want = Math.min(Math.max(o.wantS, leastS), mostS);
  const window = Math.max(0, o.windowS ?? CUT_WINDOW);
  const round = (s: number) => Math.round(s * 100) / 100;
  const parts: RecordingPart[] = [];
  const reach = (at: number, end: number, first: boolean) => (o.clipGrid ? onClipGrid(at, end, o.clipGrid, first ? o.clipGrid.firstHead : o.clipGrid.head, { leastS, mostS, toS }) : end);
  let at = fromS;
  for (let guard = 0; guard < 1000 && toS - at > 0.05; guard++) {
    const cut = endOf(at, toS, want, leastS, mostS, window, o);
    const end = cut >= toS ? toS : reach(at, cut, parts.length === 0);
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
      const half = reach(before.start, before.start + (before.seconds + last.seconds) / 2, parts.length === 2) - before.start;
      parts.splice(-2, 2, { start: before.start, seconds: half }, { start: before.start + half, seconds: before.seconds + last.seconds - half });
    }
  }
  // both ends kept to the hundredth, the length between them: rounded on their own, a part ended a hundredth past where the
  // next one starts (25.54 and 25.53 on a song)
  return parts.map((p) => ({ start: round(p.start), seconds: round(round(p.start + p.seconds) - round(p.start)) }));
}

/**
 * The moment nearest `end` a clip from `at` can end on (ClipGrid), carrying on from `head` frames: a whole count of the
 * model's frames after it, within what one clip holds and short of the stretch's end (that part would be the last, cut at
 * `toS`). `end` itself when no count is (a stretch too short for one).
 */
export function onClipGrid(at: number, end: number, g: ClipGrid, head: number, bounds: { leastS: number; mostS: number; toS: number }): number {
  const below = gridAtOrBefore(Math.floor((end - at) * g.fps + head), g.grid);
  const ends = [below, below + g.grid.step, below - g.grid.step]
    .map((frames) => at + (frames - head) / g.fps)
    .filter((e) => e - at >= bounds.leastS - 1e-6 && e - at <= bounds.mostS + 1e-6 && e < bounds.toS - 0.05);
  return ends.reduce<number | null>((best, e) => (best === null || Math.abs(e - end) < Math.abs(best - end) ? e : best), null) ?? end;
}

/**
 * The one part of a recording a single clip takes (a voice given to one Lip sync clip): the whole of it from `fromS`, as
 * much as one clip holds, ended in the pause nearest that most when it is longer, else at the most. Not the first of
 * recordingParts: that one shares a short last part evenly with the part before, which suits a row of clips, but halved
 * the single clip a voice fills (a 16 s voice without a pause gave it 8 s, where 14.83 fit).
 */
export function recordingPart(o: { fromS: number; toS: number; leastS: number; mostS: number; pauses: Pause[] }): RecordingPart | null {
  if (o.toS - o.fromS <= 0.05) return null;
  // its window is all one clip takes: any pause from the least to the most, the one nearest the most
  const end = endOf(o.fromS, o.toS, o.mostS, o.leastS, o.mostS, o.mostS - o.leastS, { pauses: o.pauses });
  return { start: Math.round(o.fromS * 100) / 100, seconds: Math.round((end - o.fromS) * 100) / 100 };
}

/** Where a part ends within a second of a mark: a part's ends are kept to the hundredth, and a mark is read to the millisecond. */
const ON_MARK = 0.03;

/**
 * What a part's end was cut at, read back from where it lies (the recording's panel counts its clips by it): a pause's
 * middle, a lyric line's end, else the quietest moment when it was cut in a window, else the length asked. `nearS`: how
 * far from the mark it may lie, half a step of the model's frames when the cut brought it onto them (onClipGrid).
 */
export function cutOn(endS: number, marks: CutMarks, windowS: number, nearS = ON_MARK): CutOn {
  const near = Math.max(ON_MARK, nearS);
  if (marks.pauses.some((p) => Math.abs((p.start + p.end) / 2 - endS) <= near)) return "pause";
  if (lineEnds(marks.lines).some((m) => Math.abs(m - endS) <= near)) return "line";
  return windowS > 0 ? "quiet" : "length";
}

/** The ends of the lines that are sung: a section's name ([Intro], [Couplet 1]) is a line of no length, at no break. */
function lineEnds(lines: LyricLine[] | undefined): number[] {
  return (lines ?? []).filter((l) => l.end - l.start > 0.05).map((l) => l.end);
}

/** Where the part from `at`, about `want` long, ends (in seconds of the recording), within `window` of that. */
function endOf(at: number, toS: number, want: number, leastS: number, mostS: number, window: number, marks: CutMarks): number {
  // what is left fits one clip, and a cut near the length asked would leave less than a clip after it: one part
  if (toS - at <= mostS && toS - at - want < leastS) return toS;
  const asked = Math.min(at + want, toS);
  if (window <= 0) return asked;
  // a mark past the end (a recording trimmed, its Out before the words go on) is no place to cut: a part made to it
  // would render the words trimmed off, and one past the recording's end would say a length the sound has not
  const lo = at + Math.max(leastS, want - window);
  const hi = Math.min(at + Math.min(mostS, want + window), toS);
  const nearest = (xs: number[]) => xs.filter((m) => m >= lo && m <= hi && m < toS).reduce<number | null>((best, m) => (best === null || Math.abs(m - at - want) < Math.abs(best - at - want) ? m : best), null);
  return nearest(marks.pauses.map((p) => (p.start + p.end) / 2)) ?? nearest(lineEnds(marks.lines)) ?? quietest(marks.levels, lo, hi, at + want) ?? asked;
}

/** How much quieter than the rest a moment has to be to be one: on a level stretch (a held note, a tone) none is. */
const QUIET_DB = 3;

/**
 * The quietest moment from `lo` to `hi`: among the samples within QUIET_DB of the quietest there, the one nearest `near`,
 * `near` itself when its own sample is one of them (a level stretch is cut at the length asked, not a sample off it); null
 * with no loudness there.
 */
export function quietest(levels: Loudness | null | undefined, lo: number, hi: number, near: number): number | null {
  if (!levels?.db.length || !(levels.rate > 0)) return null;
  const samples: Array<{ i: number; t: number; db: number }> = [];
  for (let i = Math.max(0, Math.ceil(lo * levels.rate - 0.5)); i < levels.db.length; i++) {
    const t = (i + 0.5) / levels.rate;
    if (t > hi) break;
    samples.push({ i, t, db: levels.db[i]! });
  }
  if (!samples.length) return null;
  const least = Math.min(...samples.map((x) => x.db));
  const quiet = samples.filter((x) => x.db <= least + QUIET_DB);
  if (quiet.some((x) => x.i === Math.floor(near * levels.rate))) return near;
  return quiet.reduce((best, x) => (Math.abs(x.t - near) < Math.abs(best.t - near) ? x : best)).t;
}
