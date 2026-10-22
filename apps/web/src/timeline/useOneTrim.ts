import { useEffect, useMemo, useRef, useState } from "react";

type Trim<V> = (v: V, o: { onSuccess(r: { clips: string[] }): void; onSettled(): void }) => void;

/**
 * One trim at a time, the source's and a recording's (useTimelineEditor). A trim sets windows aside or makes them anew from
 * the timeline as it is, so a second one sent before the first one's change is read back (a handle's release heard twice,
 * two drags in a row, a typed In during a drag's trim) would be worked out from the timeline before it, and could set aside
 * again what the first one set aside. Held in a ref rather than read from the mutation's pending state, so that two calls
 * from the same render are stopped as well; let go once the change is read back (the trims' `onSuccess` waits for it,
 * useTimelineMutations' `readBack`) or has failed.
 *
 * A trim asked for meanwhile is not dropped: the last one of each kind (`later`, keyed: the source, each recording) waits
 * and is run once the guard lifts, through the editor's run of the render after the read-back, so that it is worked out
 * (and its moved start asked) against the timeline the first one left. Dropped, the user's newest edit was lost without a
 * word, after a lane that snapped back to the old stretch had just invited it.
 */
export function useOneTrim() {
  const busy = useRef(false);
  /** The trims waiting, the last of each kind, in the order they were first asked for. */
  const waiting = useRef(new Map<string, { run: () => Promise<boolean>; done: (taken: boolean) => void }>());
  // the kinds waiting, to be shown as under way; and a render asked for when the guard lifts, so that the trims waiting run
  // from the timeline read back, not from the render they were asked in
  const [queued, setQueued] = useState<string[]>([]);
  const [lifted, setLifted] = useState(0);
  const listed = () => setQueued([...waiting.current.keys()]);
  useEffect(() => {
    for (const [key, next] of waiting.current) {
      if (busy.current) break;
      waiting.current.delete(key);
      void next.run().then(next.done);
    }
    listed();
  }, [lifted]);
  return useMemo(() => ({
    /** A trim is on its way: another one now waits (`later`). */
    get busy() {
      return busy.current;
    },
    /** The trim sent, unless one is on its way (false then); `done` with the clips it made, once read back. Settles true once read back, false when it failed. */
    run<V>(mutate: Trim<V>, v: V, done: (clips: string[]) => void): Promise<boolean> {
      if (busy.current) return Promise.resolve(false);
      busy.current = true;
      return new Promise<boolean>((settled) => {
        let taken = false;
        mutate(v, {
          onSuccess: (r) => {
            taken = true;
            done(r.clips);
          },
          onSettled: () => {
            busy.current = false;
            settled(taken);
            setLifted((n) => n + 1);
          },
        });
      });
    },
    /**
     * A trim asked for while one is on its way: kept, in place of the one of its kind already waiting (that one settles
     * false, never sent), and `run` once the guard lifts. Settles as that run does.
     */
    later(key: string, run: () => Promise<boolean>): Promise<boolean> {
      return new Promise<boolean>((done) => {
        waiting.current.get(key)?.done(false);
        waiting.current.set(key, { run, done });
        listed();
      });
    },
    /** A trim of this kind is waiting for the one on its way. */
    waits: (key: string) => queued.includes(key),
  }), [queued]);
}
