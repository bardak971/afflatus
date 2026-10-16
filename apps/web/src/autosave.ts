import { useEffect, useMemo, useRef, useState } from "react";

/** Where an autosave stands: all sent, a change waiting or on its way, or the last send failed (the change is kept). */
export type SaveState = "saved" | "saving" | "failed";

/**
 * Jobs run one after the other, each once the one before it is done (failed or not). Two saves of a draft sent at once
 * could be answered out of turn: the older one's answer, written last, put stale data in the cache that the next
 * keystroke then saved over the newer edit.
 */
export function inTurn(): <T>(job: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const run = last.then(job, job);
    last = run.catch(() => {});
    return run;
  };
}

/** The most a request that outlives the page may carry: the browser refuses a `keepalive` body past 64 KiB (sendBeacon too). */
export const KEEPALIVE_MAX = 60 * 1024;

/** How the things an autosave keeps are saved, each under its key (a clip's id; one key for a draft). */
export type AutosaveOpts<T> = {
  /** Send it; a throw keeps it pending, its message said as the failure. */
  save(key: string, item: T): Promise<void>;
  /** As the page closes: send it by a request that outlives the page (`raw` with `keepalive`), if it can go that way. */
  keepalive(key: string, item: T): void;
  /** Whether all of it can go as the page closes; when not, the browser asks first, and the ordinary save is started. Left out: always. */
  goesWhole?(key: string, item: T): boolean;
  /**
   * Whether a failed save says the thing is no more on the server (a clip removed while its form was being saved): its
   * change is dropped rather than kept as failed, which would leave every later save said failed, and the tab asking
   * before it closes, for the rest of the session. Left out: never.
   */
  gone?(err: unknown): boolean;
  delayMs?: number;
};

/**
 * The saving itself, apart from React (so that it can be tested on its own): what waits to be saved under each key, a
 * timer per key, and one turn for every save, so that two saves of one thing never cross. `opts` is read at each use
 * (the hook passes its latest); `said` hears where the whole stands after each change.
 */
export function autosaver<T>(opts: () => AutosaveOpts<T>, said: (state: SaveState, failure: string | null) => void = () => {}) {
  const pending = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // why the last save of each key failed: the whole stands failed while one of them has
  const failures = new Map<string, string>();
  const turn = inTurn();
  let state: SaveState = "saved";
  const set = (next: SaveState, failure: string | null) => {
    state = next;
    said(next, failure);
  };
  const stop = (key?: string) => {
    for (const k of key === undefined ? [...timers.keys()] : [key]) {
      clearTimeout(timers.get(k));
      timers.delete(k);
    }
  };
  // the whole said as it stands: failed while a key's last save has, saved once nothing waits, else on its way
  const settle = () => {
    const left = [...failures.values()];
    if (left.length) set("failed", left[left.length - 1]!);
    else set(pending.size ? "saving" : "saved", null);
  };
  const send = async (key: string) => {
    const item = pending.get(key);
    if (item === undefined) return;
    // what was sent is saved, or has nothing left to be saved to; a change made meanwhile is still waiting
    const done = () => {
      failures.delete(key);
      if (pending.get(key) === item) pending.delete(key);
      settle();
    };
    try {
      await opts().save(key, item);
      done();
    } catch (err) {
      if (opts().gone?.(err)) return done();
      // the change stays pending: the next flush, or Retry, sends it again
      failures.set(key, (err as Error).message);
      set("failed", (err as Error).message);
    }
  };
  /** What waits under `key` (under every key when left out) is saved now, in its turn. */
  const flush = (key?: string) => {
    stop(key);
    // what is pending is read when its turn comes: a change made while the save before it was out goes along
    return turn(async () => {
      for (const k of key === undefined ? [...pending.keys()] : [key]) await send(k);
    });
  };
  /** A change is pending under `key` (set in `pending` first): saved after the delay, unless another comes before. */
  const schedule = (key: string) => {
    // a failure stays said until a save goes through: what failed is still not saved
    if (state !== "failed") set("saving", null);
    stop(key);
    timers.set(key, setTimeout(() => void flush(key), opts().delayMs ?? 500));
  };
  const queue = (key: string, item: T) => {
    pending.set(key, item);
    schedule(key);
  };
  /**
   * What waits under `key` is dropped, not saved: the thing is gone (a draft deleted). Its failure goes with it, else
   * the whole stayed said failed, and the tab asked before closing, for something no longer there.
   */
  const drop = (key: string) => {
    stop(key);
    pending.delete(key);
    failures.delete(key);
    settle();
  };
  const retry = () => {
    set("saving", null);
    return flush();
  };
  /** The page closes: every change still waiting goes by a request that outlives the page. */
  const hide = () => {
    stop();
    for (const [key, item] of pending) opts().keepalive(key, item);
  };
  /**
   * Whether the browser should ask before the tab closes: a save has failed, or what waits cannot go whole as the page
   * closes. In that last case the ordinary save is started, so that staying lets it finish.
   */
  const mustAsk = () => {
    const whole = opts().goesWhole;
    const cut = Boolean(whole && [...pending].some(([key, item]) => !whole(key, item)));
    if (cut) void flush();
    return cut || state === "failed";
  };
  return { pending, turn, flush, schedule, queue, drop, retry, hide, mustAsk };
}

/**
 * Things edited on screen and saved to the server on their own, each under its key (the clips of a timeline): saved
 * `delayMs` after the last change to it, and at once on `flush`, when the screen is left, or as the tab closes, by a
 * request that outlives the page. A save that fails keeps the change: the next flush, or `retry`, sends it again, and
 * the browser asks before the tab is closed meanwhile. Saves go one at a time (`turn`, see inTurn).
 *
 * `pending` is what waits to be saved, by key: the caller may rewrite it.
 */
export function useKeyedAutosave<T>(opts: AutosaveOpts<T>) {
  const own = useRef(opts);
  own.current = opts;
  const [state, setState] = useState<SaveState>("saved");
  /** Why the last save failed, in the server's words. */
  const [failure, setFailure] = useState<string | null>(null);
  const [saver] = useState(() => autosaver<T>(() => own.current, (s, f) => {
    setState(s);
    setFailure(f);
  }));

  // leaving the screen saves what is pending
  useEffect(() => () => void saver.flush(), [saver]);
  // so does closing or reloading the tab: a request that outlives the page. While a save has failed, or when what is
  // pending cannot go whole that way, the browser asks first: staying lets the ordinary save, started then, finish.
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => {
      if (!saver.mustAsk()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("pagehide", saver.hide);
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("pagehide", saver.hide);
      window.removeEventListener("beforeunload", ask);
    };
  }, [saver]);

  return useMemo(() => ({ ...saver, state, failure }), [saver, state, failure]);
}

/** The one key of an autosave that keeps a single thing. */
const ONE = "";

/**
 * Something edited on screen and saved to the server on its own (a draft, a Prompt kit item): a `useKeyedAutosave`
 * with one key. `pending` is what waits to be saved: the caller may rewrite it (a draft made again under another id).
 */
export function useAutosave<T>(opts: {
  save(item: T): Promise<void>;
  keepalive(item: T): void;
  goesWhole?(item: T): boolean;
  delayMs?: number;
}) {
  const own = useRef(opts);
  own.current = opts;
  const keyed = useKeyedAutosave<T>({
    save: (_, item) => own.current.save(item),
    keepalive: (_, item) => own.current.keepalive(item),
    goesWhole: (_, item) => own.current.goesWhole?.(item) ?? true,
    delayMs: opts.delayMs,
  });
  const { pending: map, flush, schedule, queue, drop, retry, turn, state, failure } = keyed;
  const pending = useMemo(() => ({
    get current(): T | null {
      return map.get(ONE) ?? null;
    },
    set current(item: T | null) {
      if (item === null) map.delete(ONE);
      else map.set(ONE, item);
    },
  }), [map]);
  // the same functions for the life of the screen: callers' effects depend on them
  const fns = useMemo(() => ({
    flush: () => flush(),
    schedule: () => schedule(ONE),
    queue: (item: T) => queue(ONE, item),
    /** What waits is dropped, not saved, its failure with it: the thing is gone. */
    drop: () => drop(ONE),
    retry: () => void retry(),
    turn,
  }), [flush, schedule, queue, drop, retry, turn]);
  return useMemo(() => ({ ...fns, pending, state, failure }), [fns, pending, state, failure]);
}
