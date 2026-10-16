import { useSyncExternalStore } from "react";
import { useThemeChoice } from "../theme/store";

/**
 * How a progress bar moves (Settings › Interface › Progress), chosen per browser with the theme:
 * - same: a short ease to each new value, the look the app always had;
 * - glide: the bar glides at the render's own pace towards the next step it expects, never past it;
 * - steps: one tick per step (grouped past ~40), the ring as dots, nothing moving in between;
 * - alive: as `same`, with a light sweeping along the bar and a dot circling the ring.
 * Every one of them moves by `transform` and `opacity` only, so that the compositor draws it: a width or an SVG
 * dash that eases on each step kept the tab painting at the display's rate while anything rendered.
 */
export type ProgressStyle = "same" | "glide" | "steps" | "alive";

export const PROGRESS_STYLES: ReadonlyArray<{ id: ProgressStyle; label: string; tip: string }> = [
  { id: "same", label: "Same look", tip: "A short ease to each new value, as Afflatus always drew it" },
  { id: "glide", label: "Glide", tip: "The bar glides at the render's own pace, reaching each step as the next one is due" },
  { id: "steps", label: "Steps", tip: "One tick per step, the ring as dots: nothing moves between two steps" },
  { id: "alive", label: "Alive", tip: "A short ease to each new value, with a light sweeping along the bar and a dot circling the ring" },
];

export const DEFAULT_PROGRESS: ProgressStyle = "glide";

/** The style drawn: with motion reduced, the two that keep moving (Glide, Alive) are drawn as Steps. Same look stays, without its ease. */
export const shownStyle = (chosen: ProgressStyle | undefined, reduced: boolean): ProgressStyle => {
  const style = chosen && PROGRESS_STYLES.some((s) => s.id === chosen) ? chosen : DEFAULT_PROGRESS;
  return reduced && (style === "glide" || style === "alive") ? "steps" : style;
};

const REDUCED = "(prefers-reduced-motion: reduce)";
// the query asked once per page (each bar reads it at every drawing), and again only for another matchMedia (the tests' own)
let asked: { of: typeof window.matchMedia; media: MediaQueryList } | null = null;
const media = (): MediaQueryList | null => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (asked?.of !== window.matchMedia) asked = { of: window.matchMedia, media: window.matchMedia(REDUCED) };
  return asked.media;
};
const reducedNow = () => media()?.matches === true;
const onReduced = (changed: () => void) => {
  const m = media();
  m?.addEventListener("change", changed);
  return () => m?.removeEventListener("change", changed);
};

/** Whether the system asks for less motion, followed as it changes. */
export const useReducedMotion = (): boolean => useSyncExternalStore(onReduced, reducedNow, () => false);

/** The progress style this browser draws (the one chosen, or Steps under reduced motion). */
export function useProgressStyle(): ProgressStyle {
  const chosen = useThemeChoice((s) => s.progress);
  return shownStyle(chosen, useReducedMotion());
}

/**
 * How many ticks a Steps bar draws: one per step up to `max`, past it steps grouped evenly (50 steps at 40 → 25 ticks
 * of 2), so that a tick stays wide enough to read. Without a step count (a download), 20 ticks of 5 %.
 */
export function ticksOf(steps: number | undefined, max = 40): number {
  if (!steps || steps < 1 || !Number.isFinite(steps)) return 20;
  const per = Math.ceil(steps / max);
  return Math.ceil(steps / per);
}

/** How many of `ticks` are lit at `value` (0–1): a tick lights when its whole share is done. */
export const litOf = (value: number, ticks: number): number => Math.max(0, Math.min(ticks, Math.floor(value * ticks + 1e-6)));

/** Where a gliding bar is going: the value it aims at, and in how long it gets there (ms; 0 = at once). */
export interface Glide {
  /** The last value said. */
  at: number;
  /** When it was said (ms). */
  t: number;
  /** The last step's size and how long it took; null before two values have come. */
  step: number | null;
  every: number | null;
  /** The value drawn towards, and the time it takes to get there. */
  aim: number;
  ms: number;
}

/** A first step's glide, before the render's pace is known: a short move to the value. */
const SHORT_MS = 300;
/** A step longer than this (a video's slow steps can be 30 s) still glides; past it the bar waits at the step. */
const LONGEST_MS = 120_000;

/**
 * The glide after a new value: with the render's pace known from the last step (its size and how long it took), the
 * bar aims at the next step it expects (this value plus one more step of the same size) and takes one step's time to
 * get there, so that it moves on without stopping and arrives as the next value is due. It never aims past that next
 * step, nor past the end; a value that went back (a new phase, another job) is drawn at once.
 */
export function glideTo(prev: Glide | null, value: number, now: number): Glide {
  const v = Math.max(0, Math.min(1, value));
  if (!prev || v < prev.at || prev.at <= 0) return { at: v, t: now, step: null, every: null, aim: v, ms: prev && v >= prev.at && v > 0 ? SHORT_MS : 0 };
  if (v === prev.at) return prev;
  const step = v - prev.at;
  const took = now - prev.t;
  // the pace evened over the last two steps: one step that came late (the queue read between two events) does not jolt it
  const every = prev.every !== null ? (prev.every + took) / 2 : took;
  if (every > LONGEST_MS || v >= 1) return { at: v, t: now, step, every, aim: v, ms: v >= 1 ? SHORT_MS : 0 };
  return { at: v, t: now, step, every, aim: Math.min(1, v + step), ms: Math.max(0, Math.round(every)) };
}
