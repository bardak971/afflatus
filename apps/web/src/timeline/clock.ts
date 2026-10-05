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

export function makeClock(): Clock {
  let ms = 0;
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

/** One clock for the life of a component. */
export const useNewClock = (): Clock => useMemo(makeClock, []);

/** The clock's moment, redrawn on every tick: for the parts that show it. */
export const useClock = (clock: Clock): number => useSyncExternalStore(clock.subscribe, clock.get, clock.get);
