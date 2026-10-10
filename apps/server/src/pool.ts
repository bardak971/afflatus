import { availableParallelism } from "node:os";

/**
 * At most `size` pieces of work at once; the rest wait their turn, first come first served. For the ffmpeg runs a page
 * asks for (a timeline opened for the first time measures every clip at once): forty processes at a time would only
 * share the cores out and finish all of them late.
 */
export function pool(size: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    running--;
    waiting.shift()?.();
  };
  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (running >= size) await new Promise<void>((go) => waiting.push(go));
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
