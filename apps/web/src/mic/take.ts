import { pausesIn } from "../pauses";
import { dayMonth, hourMinute } from "../format";

/**
 * A take recorded from the microphone, as numbers: its loudness read live (LEVELS a second, the waveform and the trim's
 * pauses), the silence at its ends proposed for a trim, and the words that say it. Pure, so that the dialog's tests and
 * the trim's own run without a microphone.
 */

/** How many levels a second the take is read at while it is recorded: one bar of its waveform each. */
export const LEVELS = 20;

/** One reading of the microphone: its loudest sample (0 to 1, 1 = it clips) and its loudness (dB, about -60 = silence). */
export interface Level {
  peak: number;
  db: number;
}

/** A level read off one window of samples (-1 to 1), as the AnalyserNode gives them. */
export function levelOf(samples: ArrayLike<number>): Level {
  let peak = 0;
  let sum = 0;
  for (let k = 0; k < samples.length; k++) {
    const v = Math.abs(samples[k]!);
    if (v > peak) peak = v;
    sum += v * v;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { peak: Math.min(1, peak), db: rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90 };
}

/** A bar's height (percent of the waveform's), from its loudest sample: -48 dB and under is a sliver, 0 dB the whole height. */
export function barHeight(peak: number): number {
  const db = peak > 0 ? 20 * Math.log10(peak) : -90;
  return Math.round(Math.max(4, Math.min(100, ((db + 48) / 48) * 100)));
}

/** A peak this high clips: "Too loud". */
export const CLIPS = 0.99;

/** The part of a take kept, in seconds from its start. */
export interface Trim {
  from: number;
  to: number;
}

/** How much of the silence is left at an end the trim cuts: the word's own tail and breath, never cut into. */
const KEEP = 0.15;
/** Less than this cut at both ends together is no trim worth proposing. */
const LEAST = 0.15;

/**
 * The trim proposed for a take of `total` seconds: the silence at its start and at its end, found as the recording's
 * pauses are (pausesIn, the timeline's and the recording lane's own finding, a quarter second at least), less a little of
 * it kept at each end. Null when there is no silence at either end, or nothing but silence.
 */
export function proposedTrim(levels: readonly Level[], total: number): Trim | null {
  if (!levels.length || total <= 0) return null;
  const db = levels.map((l) => l.db);
  const pauses = pausesIn(db, Math.ceil(LEVELS / 4));
  const lead = pauses.find((p) => p.from === 0);
  const tail = pauses.findLast((p) => p.to === db.length);
  // one pause from start to end: the take is silence, there is nothing to keep
  if (lead && lead === tail) return null;
  const from = lead ? Math.max(0, lead.to / LEVELS - KEEP) : 0;
  const to = tail ? Math.min(total, tail.from / LEVELS + KEEP) : total;
  if (from + (total - to) < LEAST || to - from <= 0.3) return null;
  return { from: round(from), to: round(to) };
}

const round = (s: number) => Math.round(s * 100) / 100;
const s1 = (s: number) => `${s.toFixed(1)} s`;

/** What a trim cuts, in words: "Cuts 0.5 s of silence at the start and 0.7 s at the end: 3.5 s left." */
export function trimSaid(trim: Trim, total: number): string {
  const start = trim.from;
  const end = Math.max(0, total - trim.to);
  const cut = start >= 0.05 && end >= 0.05 ? `${s1(start)} of silence at the start and ${s1(end)} at the end` : start >= 0.05 ? `${s1(start)} of silence at the start` : `${s1(end)} of silence at the end`;
  return `Cuts ${cut}: ${s1(trim.to - trim.from)} left.`;
}

/** The take's name in the library: "Recording · Voice sample · 26 Oct 14:03". */
export const takeName = (slot: string, at: Date) => `Recording · ${slot} · ${dayMonth(at)} ${hourMinute(at)}`;

/** A time of the take as the dialog shows it: 0:04.7. */
export function takeClock(s: number): string {
  const tenths = Math.floor(Math.max(0, s) * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** `levels` drawn as `n` bars, each the loudest of its share (the listen view's whole take, whatever its length). */
export function barsOf(levels: readonly Level[], n: number): number[] {
  if (!levels.length) return [];
  const count = Math.min(n, levels.length);
  return Array.from({ length: count }, (_, i) => {
    const a = Math.floor((i * levels.length) / count);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / count));
    let peak = 0;
    for (let k = a; k < b; k++) peak = Math.max(peak, levels[k]!.peak);
    return barHeight(peak);
  });
}
