import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { copyText } from "./secureContext";

/** The small hooks several screens share. */

/**
 * `value` a moment after it stops changing: what is asked of the server as typed waits for the typing to pause. While
 * `live` is off it keeps what it had (a search of another mode is not asked again on the way back). It starts at `from`.
 */
export function useDebounced<T>(value: T, ms: number, live: boolean, from: T): T {
  const [now, setNow] = useState(from);
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setNow(value), ms);
    return () => clearTimeout(t);
  }, [value, ms, live]);
  return now;
}

/** A value as it stands once it has stopped changing for `ms`: what is typed in a search box, asked for once the typing stops. */
export const useSettled = <T,>(value: T, ms = 250): T => useDebounced(value, ms, true, value);

/**
 * A value shown for a moment: `flash(v)` sets it, and it is back to `rest` after `ms`. A flash before the last one is
 * over starts the wait again, and nothing is set once the screen is gone.
 */
export function useFlash<T>(rest: T, ms = 1500): [T, (value: T) => void] {
  const [value, setValue] = useState(rest);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // what it falls back to is read when the wait ends, so that the caller may pass it afresh at each drawing
  const restRef = useRef(rest);
  restRef.current = rest;
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback((next: T) => {
    clearTimeout(timer.current);
    setValue(next);
    timer.current = setTimeout(() => setValue(restRef.current), ms);
  }, [ms]);
  return [value, flash];
}

/** A copy button's "Copied" for a moment: `copy(text)` puts the text on the clipboard and lights `copied`; a copy the browser refuses lights nothing. */
export function useCopied(ms = 1500): { copied: boolean; copy(text: string): void } {
  const [copied, flash] = useFlash(false, ms);
  const copy = useCallback((text: string) => void copyText(text).then(() => flash(true), () => {}), [flash]);
  return { copied, copy };
}

/** Whether a media query matches, followed as the window changes: for a layout CSS cannot make alone (two lists of cards, or one). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia(query);
    const follow = () => setOn(media.matches);
    follow();
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [query]);
  return on;
}

/**
 * A form's change of one input, made on its inputs as they stand with the changes just before it: a field that sets two
 * inputs at once (the part of a sound: its start, then its length) sends two changes before the screen is drawn again, and
 * the second, made on the inputs drawn, put the start back (a lip sync's recording in the timeline, 2026-10-15). What it
 * builds on follows `stored` again whenever that is drawn anew.
 */
export function useInputEdits(stored: Record<string, unknown>, save: (next: Record<string, unknown>) => void): (input: string, value: unknown) => void {
  const latest = useRef({ drawn: stored, now: stored });
  if (latest.current.drawn !== stored) latest.current = { drawn: stored, now: stored };
  return (input, value) => {
    const now = { ...latest.current.now, [input]: value };
    latest.current = { ...latest.current, now };
    save(now);
  };
}

/** The time now, read again every `ms` while `on`: for what counts on screen by itself (a rented pod's running time and cost). */
export function useNow(ms = 1000, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

/** The whole second the shared clock is at, and who reads it: one interval for every screen that counts by the second. */
let second = Math.floor(Date.now() / 1000) * 1000;
const readers = new Set<() => void>();
let ticking: ReturnType<typeof setInterval> | null = null;
const tick = () => {
  second = Math.floor(Date.now() / 1000) * 1000;
  for (const read of readers) read();
};
function readSecond(read: () => void): () => void {
  readers.add(read);
  if (!ticking) {
    tick();
    ticking = setInterval(tick, 1000);
  }
  return () => {
    readers.delete(read);
    if (!readers.size && ticking) {
      clearInterval(ticking);
      ticking = null;
    }
  };
}
const unread = () => () => {};

/**
 * The time to the whole second, from one clock shared by every screen that reads it, ticking while `on`: two places that
 * say the same running figure (a pod's boot time and cost in the pill and on its card) say it at the same second, where
 * each its own useNow could be a second and a tenth of a cent apart. Off, the time as the screen is drawn.
 */
export function useSecond(on = true): number {
  const shared = useSyncExternalStore(on ? readSecond : unread, () => second);
  return on ? shared : Math.floor(Date.now() / 1000) * 1000;
}
