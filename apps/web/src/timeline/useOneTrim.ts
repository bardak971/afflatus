import { useMemo, useRef } from "react";

type Trim<V> = (v: V, o: { onSuccess(r: { clips: string[] }): void; onSettled(): void }) => void;

/**
 * One trim at a time, the source's and a recording's (useTimelineEditor). A trim sets windows aside or makes them anew from
 * the timeline as it is, so a second one sent before the first one's change is read back (a handle's release heard twice,
 * two drags in a row, a typed In during a drag's trim) would be worked out from the timeline before it, and could set aside
 * again what the first one set aside. Held in a ref rather than read from the mutation's pending state, so that two calls
 * from the same render are stopped as well; let go once the change is read back (the trims' `onSuccess` waits for it,
 * useTimelineMutations' `readBack`) or has failed.
 */
export function useOneTrim() {
  const busy = useRef(false);
  return useMemo(() => ({
    /** A trim is on its way: another one now is dropped. */
    get busy() {
      return busy.current;
    },
    /** The trim sent, unless one is on its way (false then); `done` with the clips it made, once read back. */
    run<V>(mutate: Trim<V>, v: V, done: (clips: string[]) => void): boolean {
      if (busy.current) return false;
      busy.current = true;
      mutate(v, { onSuccess: (r) => done(r.clips), onSettled: () => void (busy.current = false) });
      return true;
    },
  }), []);
}
