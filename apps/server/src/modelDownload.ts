import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, mkdir, open, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { isNetworkPath } from "./linked";
import { modelDirs } from "./modelFiles";
import { fetchPublic } from "./outbound";

/**
 * Afflatus downloading a model file itself, straight into one of ComfyUI's model folders, when it can write
 * there (ComfyUI on this machine). ComfyUI-Manager reads a file from any other address than a few sites
 * whole into memory before it writes it: a file of several gigabytes failed half way. Here the file is
 * written as it comes, to `<name>.part` beside where it goes, picked up again from the byte it had when the
 * connection is cut, checked for its size (and its SHA-256 when Hugging Face says it), and only then given
 * its name: ComfyUI never lists half a model.
 */

/** A failure that trying again would not change: the site refused, the disk is full, the file is wrong. */
export class Refused extends Error {}

export const REFUSED = "The site refused the download. For Civitai, save a key in Settings (Finding missing files): some files need an account.";

/** A size in words: "7.3 GB", "48 MB". */
export const sizeText = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

/** What is kept free on the disk beyond the file itself: a disk filled to its last byte troubles everything on it. */
const SPARE = 256 * 2 ** 20;

/** The free bytes of the disk a directory is on. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** Refuse a download the disk has no room for, before a byte of it is written. */
export async function assertRoom(dir: string, need: number, free: (dir: string) => Promise<number> = freeBytes): Promise<void> {
  if (need <= 0) return;
  const has = await free(dir).catch(() => Number.POSITIVE_INFINITY);
  if (has < need + SPARE) throw new Refused(`Not enough free space for it: the file is ${sizeText(need)}, and the disk of ${dir} has ${sizeText(has)} free. Make room, then press Download again.`);
}

export interface FetchTo {
  source: string;
  /** Sent to the host first asked only (a Civitai key): fetchPublic. */
  headers: Record<string, string>;
  /** Hosts inside the network that may be fetched from anyway (outbound.ts). */
  allow: Array<string | null | undefined>;
  /** Where the file goes, whole. `<dest>.part` holds it while it comes. */
  dest: string;
  signal: AbortSignal;
  onBytes(bytes: number, total: number): void;
  /** Hears why it starts again, and from where. */
  onRetry?(note: string): void;
  /** Tries in a row that gain nothing before it gives up. */
  attempts?: number;
  /** The first wait before trying again; it doubles each time. */
  backoffMs?: number;
  /** The free bytes of a directory's disk (a stand-in in the tests). */
  free?: (dir: string) => Promise<number>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });

/** The SHA-256 of a file on disk: for a .part whose last bytes did not all reach it. */
async function hashOf(path: string, upTo: number) {
  const hash = createHash("sha256");
  if (upTo > 0) for await (const chunk of createReadStream(path, { end: upTo - 1 })) hash.update(chunk as Buffer);
  return hash;
}

/**
 * Download `source` into `dest`: written as it comes to `<dest>.part`, picked up with a Range request where it
 * stopped when the connection is cut (from the start again when the site ignores Range), tried again with a
 * growing wait on a cut or a 5xx, and renamed to `dest` only once all of it is there and checked. A stop (the
 * signal) or a failure removes the .part. Refused is thrown for what trying again would not change.
 */
export async function fetchToFile(o: FetchTo): Promise<{ bytes: number; sha256: string }> {
  const part = `${o.dest}.part`;
  const attempts = o.attempts ?? 5;
  const backoff = o.backoffMs ?? 2000;
  let have = 0;
  let total = 0;
  let hash = createHash("sha256");
  // what Hugging Face says of the file on its first answer, before it sends on to where the bytes are
  let expectSize = 0;
  let expectSha = "";
  let roomChecked = false;
  let fails = 0;
  const removePart = () => rm(part, { force: true }).catch(() => {});
  await removePart();
  try {
    for (;;) {
      if (o.signal.aborted) throw o.signal.reason ?? new Error("stopped");
      const before = have;
      let file: Awaited<ReturnType<typeof open>> | null = null;
      try {
        const seen = (res: Response) => {
          const size = Number(res.headers.get("x-linked-size"));
          if (size > 0) expectSize = size;
          const etag = /^(?:W\/)?"?([0-9a-f]{64})"?$/i.exec(res.headers.get("x-linked-etag") ?? "")?.[1];
          if (etag) expectSha = etag.toLowerCase();
        };
        const res = await fetchPublic(o.source, { headers: { "User-Agent": "afflatus", Accept: "*/*", ...o.headers, ...(have ? { Range: `bytes=${have}-` } : {}) }, signal: o.signal }, o.allow, 5, seen);
        const type = res.headers.get("content-type") ?? "";
        if (res.status === 416 && have && have === (total || expectSize)) {
          // asked for what comes after the last byte: it was all there already
          await res.body?.cancel().catch(() => {});
          break;
        }
        if (res.status >= 500 || res.status === 429) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`the site answered ${res.status}`);
        }
        if (!res.ok || !res.body || /text\/html|application\/json/.test(type)) {
          await res.body?.cancel().catch(() => {});
          throw new Refused(res.status === 401 || res.status === 403 || /text\/html/.test(type) ? REFUSED : `The site answered ${res.status}.`);
        }
        const range = res.status === 206 ? /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "") : null;
        if (res.status === 206 && range && Number(range[1]) === have) {
          total = range[2] === "*" ? total : Number(range[2]);
        } else {
          if (res.status === 206) {
            // a piece of the file, but not from where it was asked: asked again for the whole
            await res.body.cancel().catch(() => {});
            have = 0;
            hash = createHash("sha256");
            await removePart();
            throw new Error("the site sent another part of the file than was asked");
          }
          // the whole file: a site that ignores Range sends it from the start, and what was there goes
          if (have) o.onRetry?.("The site does not resume downloads: starting over.");
          have = 0;
          hash = createHash("sha256");
          total = Number(res.headers.get("content-length")) || 0;
        }
        if (!total && expectSize) total = expectSize;
        if (expectSize && total && expectSize !== total) throw new Refused(`The site says the file is ${expectSize} bytes, and sends ${total}.`);
        if (!roomChecked) {
          await mkdirFor(o.dest);
          await assertRoom(dirOf(o.dest), total - have, o.free);
          roomChecked = true;
        }
        file = await open(part, have ? "a" : "w");
        o.onBytes(have, total);
        // each piece written before it is counted: what was counted is what the .part holds, so a cut picks up exactly there
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await file.write(value);
          hash.update(value);
          have += value.length;
          o.onBytes(have, total);
        }
        await file.close();
        file = null;
        if (total && have < total) throw new Error(`the connection was cut at ${sizeText(have)} of ${sizeText(total)}`);
        if (total && have > total) throw new Refused(`The site sent more than the ${total} bytes it said.`);
        break;
      } catch (err) {
        await file?.close().catch(() => {});
        if (o.signal.aborted) throw err;
        if (err instanceof Refused) throw err;
        // a write that failed half way leaves the .part shorter than counted: picked up from what is really there
        const onDisk = await stat(part).then((s) => s.size, () => 0);
        if (onDisk !== have) {
          have = Math.min(onDisk, have);
          hash = await hashOf(part, have);
        }
        fails = have > before ? 1 : fails + 1;
        // undici says a cut connection in its own words ("terminated", "other side closed"): said plainly here
        const said = (err as Error).message.replace(/\.$/, "");
        const why = /terminated|other side closed|ECONNRESET|socket|fetch failed|EPIPE/i.test(said) ? `the connection was cut at ${sizeText(have)}` : said;
        if (fails >= attempts) throw new Refused(`The download failed ${attempts} times in a row (${why}). Press Download again to start over.`);
        o.onRetry?.(`${why[0]!.toUpperCase()}${why.slice(1)}: trying again${have ? ` from ${sizeText(have)}` : ""} (${fails + 1} of ${attempts}).`);
        await sleep(backoff * 2 ** (fails - 1), o.signal);
      }
    }
    if (expectSize && have !== expectSize) throw new Refused(`The file came incomplete: ${have} of ${expectSize} bytes. Press Download again.`);
    const sha256 = hash.digest("hex");
    if (expectSha && sha256 !== expectSha) throw new Refused("The file came damaged: its SHA-256 is not the one Hugging Face lists. Press Download again.");
    // never over a file that is there: ComfyUI may have it in use, and it was asked for as missing
    if (await stat(o.dest).then(() => true, () => false)) throw new Refused("A file of that name is in the folder already.");
    await rename(part, o.dest);
    return { bytes: have, sha256 };
  } catch (err) {
    await removePart();
    throw err;
  }
}

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const mkdirFor = (path: string) => mkdir(dirOf(path), { recursive: true });

/** Whether `path` is `root` itself or a place under it (both already real paths). */
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/** Whether ComfyUI's address names this machine: then the folders it says are folders here. */
export function onThisMachine(comfyUrl: string): boolean {
  let host: string;
  try {
    host = new URL(comfyUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((a) => a.address.toLowerCase() === host));
}

/** ComfyUI's older names of two folders: a request may use either. */
const OTHER_NAME: Record<string, string> = { unet: "diffusion_models", clip: "text_encoders", diffusion_models: "unet", text_encoders: "clip" };

/**
 * The paths ComfyUI reads a model folder from, as it says them on /internal/folder_paths (extra_model_paths.yaml
 * counted). Null when this ComfyUI does not say (an older one): then the folder set in Settings is read instead.
 */
export async function comfyFolderPaths(comfyUrl: string): Promise<Record<string, string[]> | null> {
  try {
    const res = await fetch(`${comfyUrl.replace(/\/+$/, "")}/internal/folder_paths`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const all = (await res.json()) as Record<string, unknown>;
    if (!all || typeof all !== "object") return null;
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []]));
  } catch {
    return null;
  }
}

/**
 * The directory Afflatus downloads a model folder's files into, when it can write there itself: the first
 * of the paths ComfyUI reads that folder from (as ComfyUI-Manager would pick) that exists here and can be
 * written, as its real path. Only a path ComfyUI listed (or, from an older ComfyUI, one of the folder set in
 * Settings) is ever taken; never one on a network share (see isNetworkPath). Null when there is none: the
 * download then goes through ComfyUI.
 */
export async function modelRoot(paths: Record<string, string[]> | null, folder: string, comfyUrl: string, comfyDir: string): Promise<string | null> {
  const dir = comfyDir.trim();
  // ComfyUI's paths are its machine's: they are this machine's only when it runs here, or when its folder was set here
  const here = onThisMachine(comfyUrl) || Boolean(dir && !isNetworkPath(dir));
  if (!here) return null;
  const listed = paths ? paths[folder] ?? (OTHER_NAME[folder] ? paths[OTHER_NAME[folder]!] : undefined) ?? [] : await modelDirs(dir, folder);
  for (const p of listed) {
    if (!p || isNetworkPath(p) || !isAbsolute(p)) continue;
    try {
      const real = await realpath(p);
      if (!(await stat(real)).isDirectory()) continue;
      await access(real, constants.W_OK);
      return real;
    } catch {
      // not there, or not ours to write: the next one
    }
  }
  return null;
}

/**
 * Where a file goes under a model folder's directory: `sub` (a sub-folder the name came with) kept inside it,
 * after its links are followed. Throws when it would land anywhere else.
 */
export async function placeIn(root: string, sub: string, name: string): Promise<string> {
  const dir = sub ? join(root, ...sub.split("/")) : root;
  if (!inside(root, dir)) throw new Refused("that is not a models folder");
  await mkdir(dir, { recursive: true });
  const real = await realpath(dir);
  if (!inside(root, real)) throw new Refused("that sub-folder leads out of the models folder");
  return join(real, name);
}
