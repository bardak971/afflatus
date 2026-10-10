import { availableParallelism } from "node:os";

/**
 * At most `size` pieces of work at once; the rest wait their turn, first come first served. For the ffmpeg runs a page
 * asks for (a timeline opened for the first time measures every clip at once): forty processes at a time would only
 * share the cores out and finish all of them late. `first`: work a screen waits on (the motion its tracks snap to) goes
 * before what only decorates it (film strips), whichever was asked first.
 */
export function pool(size: number) {
  let running = 0;
  const urgent: Array<() => void> = [];
  const waiting: Array<() => void> = [];
  const next = () => {
    running--;
    (urgent.shift() ?? waiting.shift())?.();
  };
  return async function run<T>(work: () => Promise<T>, opts: { first?: boolean } = {}): Promise<T> {
    if (running >= size) await new Promise<void>((go) => (opts.first ? urgent : waiting).push(go));
    running++;
    try {
      return await work();
    } finally {
      next();
    }
  };
}

/** The ffmpeg runs made for a request: half the machine's cores (two at least), so that the server still answers meanwhile. */
export const ffmpegPool = pool(Math.max(2, Math.floor(availableParallelism() / 2)));
