import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";

/**
 * At most `size` pieces of work at once; the rest wait their turn, first come first served. For the ffmpeg runs a page
 * asks for (a timeline opened for the first time measures every clip at once): forty processes at a time would only
 * share the cores out and finish all of them late. `first`: work a screen waits on (the motion its tracks snap to) goes
 * before what only decorates it (film strips), whichever was asked first. `last`: work nobody waits on (what is measured
 * in the background, precompute.ts) goes after everything else, and never takes the last free place unless the pool is
 * empty, so that what a screen asks for next does not wait behind it. Work asked for inside a place already held (a
 * background unit measuring through a function that uses the pool itself) runs at once in that place: it is the same
 * piece of work, and waiting for a second place could wait for ever.
 */
export function pool(size: number) {
  let running = 0;
  const urgent: Array<() => void> = [];
  const waiting: Array<() => void> = [];
  const idle: Array<() => void> = [];
  const holding = new AsyncLocalStorage<true>();
  const pick = () => {
    if (running >= size) return undefined;
    if (urgent.length) return urgent.shift();
    if (waiting.length) return waiting.shift();
    if (idle.length && (running === 0 || running < size - 1)) return idle.shift();
    return undefined;
  };
  const wake = () => {
    for (let go = pick(); go; go = pick()) {
      running++;
      go();
    }
  };
  return async function run<T>(work: () => Promise<T>, opts: { first?: boolean; last?: boolean } = {}): Promise<T> {
    if (holding.getStore()) return work();
    await new Promise<void>((go) => {
      (opts.first ? urgent : opts.last ? idle : waiting).push(go);
      wake();
    });
    try {
      return await holding.run(true, work);
    } finally {
      running--;
      wake();
    }
  };
}

/** The ffmpeg runs made for a request: half the machine's cores (two at least), so that the server still answers meanwhile. */
export const ffmpegPool = pool(Math.max(2, Math.floor(availableParallelism() / 2)));
