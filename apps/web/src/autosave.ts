import { useCallback, useEffect, useRef, useState } from "react";

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

/**
 * Something edited on screen and saved to the server on its own (a draft, a Prompt kit item): saved `delayMs` after the
 * last change, and at once on `flush` (another one is opened), when the screen is left, or as the tab closes, by a
 * request that outlives the page. A save that fails keeps the change: the next flush, or `retry`, sends it again, and
 * the browser asks before the tab is closed meanwhile. Saves go one at a time (`turn`, see inTurn).
 *
 * `pending` is what waits to be saved: the caller may rewrite it (a draft made again under another id).
 */
export function useAutosave<T>(opts: {
  /** Send it; a throw keeps it pending, its message said as the failure. */
  save(item: T): Promise<void>;
  /** As the page closes: send it by a request that outlives the page (`raw` with `keepalive`), if it can go that way. */
  keepalive(item: T): void;
  /** Whether all of it can go as the page closes; when not, the browser asks first, and the ordinary save is started. Left out: always. */
  goesWhole?(item: T): boolean;
  delayMs?: number;
}) {
  const own = useRef(opts);
  own.current = opts;
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  /** Why the last save failed, in the server's words. */
  const [failure, setFailure] = useState<string | null>(null);
  const [turn] = useState(inTurn);

  const send = useCallback(async () => {
    const item = pending.current;
    if (!item) return;
    try {
      await own.current.save(item);
      // what was sent is saved; a change made meanwhile is still waiting
      if (pending.current === item) pending.current = null;
      if (!pending.current) {
        setState("saved");
        setFailure(null);
      }
    } catch (err) {
      // the change stays pending: the next flush, or Retry, sends it again
      setState("failed");
      setFailure((err as Error).message);
    }
  }, []);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // what is pending is read when its turn comes: a change made while the save before it was out goes along
    return turn(send);
  }, [turn, send]);
  /** A change is pending (set `pending` first): saved after the delay, unless another comes before. */
  const schedule = useCallback(() => {
    setState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), own.current.delayMs ?? 500);
  }, [flush]);
  const queue = useCallback((item: T) => {
    pending.current = item;
    schedule();
  }, [schedule]);
  const retry = useCallback(() => {
    setState("saving");
    void flush();
  }, [flush]);

  // leaving the screen saves what is pending
  useEffect(() => () => void flush(), [flush]);
  // so does closing or reloading the tab: a request that outlives the page. While a save has failed, or when what is
  // pending cannot go whole that way, the browser asks first: staying lets the ordinary save, started then, finish.
  useEffect(() => {
    const hide = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const item = pending.current;
      if (item) own.current.keepalive(item);
    };
    const ask = (e: BeforeUnloadEvent) => {
      const item = pending.current;
      const cut = Boolean(item && own.current.goesWhole && !own.current.goesWhole(item));
      if (state !== "failed" && !cut) return;
      if (cut) void flush();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", ask);
    };
  }, [state, flush]);

  return { pending, state, failure, flush, schedule, queue, retry, turn };
}
