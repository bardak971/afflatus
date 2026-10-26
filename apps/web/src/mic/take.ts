import { pausesIn } from "../pauses";
import { dayMonth, hourMinute, seconds } from "../format";

/**
 * A take recorded from the microphone, as numbers: its loudness read live (LEVELS a second, the waveform and the trim's
 * pauses), the silence at its ends proposed for a trim, and the words that say it. Pure, so that the dialog's tests and
 * the trim's own run without a microphone.
 */

/**
 * How many levels a second a take is drawn and trimmed at: one bar of its waveform each. The microphone is read about as
 * often while it records, but a timer drifts (a busy PC, a hidden tab): the readings are timed, and spread back on this
 * even grid once the take stops (`evenly`).
 */
export const LEVELS = 20;

/** The bars the live waveform shows at most: the last seconds of a long take, as it scrolls. */
export const LIVE_BARS = 220;

/** One reading of the microphone: its loudest sample (0 to 1, 1 = it clips) and its loudness (dB, about -60 = silence). */
export interface Level {
  peak: number;
  db: number;
}

/** A level as the microphone was read while recording: `at`, seconds from the take's start. */
export interface Reading {
  at: number;
  level: Level;
}

const louder = (a: Level, b: Level): Level => ({ peak: Math.max(a.peak, b.peak), db: Math.max(a.db, b.db) });
const SILENT: Level = { peak: 0, db: -90 };

/**
 * The timed readings of a take of `total` seconds, as LEVELS a second on an even grid: each step the loudest reading made
 * in it. A step no reading fell in (the timer late) takes the louder of the readings either side of it, so that a gap next
 * to a word counts as the word and the trim never cuts into it.
 */
export function evenly(readings: readonly Reading[], total: number): Level[] {
  if (!readings.length || total <= 0) return [];
  const steps = Math.max(1, Math.round(total * LEVELS));
  const out: Level[] = [];
  let k = 0;
  for (let i = 0; i < steps; i++) {
    const end = (i + 1) / LEVELS;
    let got: Level | null = null;
    // the last step takes whatever was read up to the stop
    while (k < readings.length && (readings[k]!.at < end || i === steps - 1)) got = louder(got ?? SILENT, readings[k++]!.level);
    out.push(got ?? louder(readings[k - 1]?.level ?? SILENT, readings[k]?.level ?? SILENT));
  }
  return out;
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

/** What a trim cuts, in words: "Cuts 0.5 s of silence at the start and 0.7 s at the end: 3.5 s left." */
export function trimSaid(trim: Trim, total: number): string {
  const start = trim.from * 1000;
  const end = Math.max(0, total - trim.to) * 1000;
  const cut = start >= 50 && end >= 50 ? `${seconds(start)} of silence at the start and ${seconds(end)} at the end` : start >= 50 ? `${seconds(start)} of silence at the start` : `${seconds(end)} of silence at the end`;
  return `Cuts ${cut}: ${seconds((trim.to - trim.from) * 1000)} left.`;
}

/**
 * The take's name in the library: "Recording · Voice sample · 26 Oct 14.03". Nothing a file name cannot hold (a ":"), so
 * that in a linked folder the file is named as the library item is.
 */
export const takeName = (slot: string, at: Date) => `Recording · ${slot} · ${dayMonth(at)} ${hourMinute(at).replace(":", ".")}`.replace(/[:*?"<>|\\/]/g, "");

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
