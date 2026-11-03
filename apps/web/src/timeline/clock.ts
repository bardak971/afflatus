import { useMemo, useSyncExternalStore } from "react";

/**
 * The moment of what plays, as the player reports it fifteen times a second. It is kept out of the
 * editor's state on purpose: only the parts that draw it (the track's playhead, the transport readout)
 * subscribe and redraw on each tick; the rest of the editor reads it when a key or a click asks.
 */
export interface Clock {
  get(): number;
  set(ms: number): void;
  subscribe(onChange: () => void): () => void;
}

function makeClock(start = 0): Clock {
  let ms = start;
  const listeners = new Set<() => void>();
  return {
    get: () => ms,
    set: (next) => {
      if (next === ms) return;
      ms = next;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

/** One clock for the life of a component, at `start` first. */
export const useNewClock = (start = 0): Clock => useMemo(() => makeClock(start), []); // eslint-disable-line react-hooks/exhaustive-deps -- where it starts, once

/** The clock's moment, redrawn on every tick: for the parts that show it. */
export const useClock = (clock: Clock): number => useSyncExternalStore(clock.subscribe, clock.get, clock.get);

/**
 * What a part makes of the clock's moment (rounded, clamped), redrawn only when that changes: a tick that leaves it the same
 * draws nothing.
 */
export const useClockAs = <T,>(clock: Clock, of: (ms: number) => T): T => {
  const now = () => of(clock.get());
  return useSyncExternalStore(clock.subscribe, now, now);
};
