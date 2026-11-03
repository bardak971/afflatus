import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Small helpers the server had written several times over (the 2026-11-02 review): a wait a Stop ends, a file's SHA-256,
 * and whether a path is inside a folder.
 */

/**
 * Wait `ms`, or less when `signal` aborts: a stopped download or upload does not sit out its backoff (an upload to a pod
 * waited up to 16 s of it with a bare timer). Resolves either way; the caller asks the signal what happened.
 */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });

/** The SHA-256 of a file's first `upTo` bytes (all of it by default), as a hash that may still be fed: a .part goes on from it. */
export async function hashOf(path: string, upTo = Infinity): Promise<Hash> {
  const hash = createHash("sha256");
  if (upTo > 0) for await (const chunk of createReadStream(path, Number.isFinite(upTo) ? { end: upTo - 1 } : {})) hash.update(chunk as Buffer);
  return hash;
}

/** A file's SHA-256 in hex: upper case as Civitai lists it (`upper`), else lower case as a release's sums are. */
export async function sha256File(path: string, o: { upper?: boolean } = {}): Promise<string> {
  const hex = (await hashOf(path)).digest("hex");
  return o.upper ? hex.toUpperCase() : hex;
}

/**
 * Whether `path` is `root` itself or a place under it. One check for the folders a request may name (a model's place, the
 * bin, a backup's files): the downloader's copy also refused a folder named "..x" inside the root, as its test was on
 * the "..", not on the ".." segment. On Windows, another drive is never inside, and case does not tell two paths apart.
 */
export function isInside(root: string, path: string): boolean {
  const back = relative(resolve(root), resolve(path));
  return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}
