import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, mkdir, open, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, win32 } from "node:path";
import { isNetworkPath } from "./linked";
import { modelDirs } from "./modelFiles";
import { cannotReach, failCode, fetchFailure, fetchPublic } from "./outbound";
import type { ComfyClient } from "@afflatus/comfy";

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
/** Hugging Face's refusal of a gated file: an account that accepted the model's licence, through its token, is what it wants. */
export const REFUSED_HF = "Hugging Face refused the download: the file is gated. Accept the model's licence on its Hugging Face page, signed in with the account whose token is in Settings (Finding missing files), and give the token read access to gated repositories.";
/** What a refusal is said as: Hugging Face's gated files get their own words. */
export const refusedSaid = (source: string): string => (/^https:\/\/(huggingface\.co|hf\.co)\//i.test(source) ? REFUSED_HF : REFUSED);

/** A size in words: "7.3 GB", "48 MB"; a few bytes are "1 MB", none are "0 MB". */
export const sizeText = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${n > 0 ? Math.max(1, Math.round(n / 2 ** 20)) : 0} MB`);

/** Folders ComfyUI lists that hold code or settings, not models: never downloaded into (the node pack refuses them too). */
export const NOT_MODELS = new Set(["custom_nodes", "configs"]);

/** What a file's name must not hold on any system: a drive's colon, Windows' reserved characters, control characters. */
export const BAD_NAME = /[:*?"<>|\x00-\x1f]/;

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
          throw new Refused(res.status === 401 || res.status === 403 || /text\/html/.test(type) ? refusedSaid(o.source) : `The site answered ${res.status}.`);
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
        // a redirect refused on the way (into the network, down to http, one too many): the same again next time
        if (typeof (err as { statusCode?: unknown }).statusCode === "number") throw new Refused((err as Error).message);
        // a write that failed half way leaves the .part shorter than counted: picked up from what is really there
        const onDisk = await stat(part).then((s) => s.size, () => 0);
        if (onDisk !== have) {
          have = Math.min(onDisk, have);
          hash = await hashOf(part, have);
        }
        // a host that cannot be reached at all (refused, unknown, a bad certificate) before a byte came: trying again changes nothing
        if (!have && cannotReach(err)) throw new Refused(`Could not reach ${hostOf(o.source)} (${failCode(err)}). Check the address, then press Download again.`);
        fails = have > before ? 1 : fails + 1;
        // undici says a cut connection in its own words ("terminated", "other side closed"): said plainly here, and
        // a cut only once some of the file came; before that, what kept it from coming is said
        const said = (err as Error).message.replace(/\.$/, "");
        const why = !/terminated|other side closed|ECONNRESET|socket|fetch failed|EPIPE/i.test(said)
          ? said
          : have
            ? `the connection was cut at ${sizeText(have)}`
            : /fetch failed/i.test(said)
              ? fetchFailure(err, o.source)
              : "the connection was cut before any of the file came";
        if (fails >= attempts) throw new Refused(`The download failed ${attempts} times in a row (${why}). Press Download again to start over.`);
        o.onRetry?.(`${why[0]!.toUpperCase()}${why.slice(1)}: trying again${have ? ` from ${sizeText(have)}` : ""} (${fails + 1} of ${attempts}).`);
        await sleep(backoff * 2 ** (fails - 1), o.signal);
      }
    }
    if (expectSize && have !== expectSize) throw new Refused(`The file came incomplete: ${have} of ${expectSize} bytes. Press Download again.`);
    const sha256 = hash.digest("hex");
    if (expectSha && sha256 !== expectSha) throw new Refused("The file came damaged: its SHA-256 is not the one Hugging Face lists. Press Download again.");
    if (SAFETENSORS.test(o.dest) && !(await looksLikeSafetensors(part, have))) throw new Refused("What came is not a safetensors file (the site sent something else under that name). Check the address.");
    // never over a file that is there: ComfyUI may have it in use, and it was asked for as missing
    if (await stat(o.dest).then(() => true, () => false)) throw new Refused("A file of that name is in the folder already.");
    await rename(part, o.dest);
    return { bytes: have, sha256 };
  } catch (err) {
    await removePart();
    throw err;
  }
}

const SAFETENSORS = /\.(safetensors|sft)$/i;

/**
 * Whether a file starts as a safetensors file does: the length of its JSON header in 8 bytes (little-endian), then
 * the header's `{`, the header within the file. A page, an archive or another service's answer saved under a
 * model's name does not, and is refused before ComfyUI lists it.
 */
export async function looksLikeSafetensors(path: string, size: number): Promise<boolean> {
  if (size < 10) return false;
  const file = await open(path, "r");
  try {
    const head = Buffer.alloc(9);
    await file.read(head, 0, 9, 0);
    const length = head.readBigUInt64LE(0);
    return length >= 2n && length <= BigInt(size - 8) && head[8] === 0x7b;
  } finally {
    await file.close();
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const mkdirFor = (path: string) => mkdir(dirOf(path), { recursive: true });

/** Whether `path` is `root` itself or a place under it (both already real paths). */
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Whether ComfyUI's address names this machine: then the folders it says are folders here. Only "localhost" or an
 * IP address counts (a loopback one, or one of this machine's own): a host name such as 127.example.net resolves
 * wherever its owner wants, so its first label proves nothing.
 */
export function onThisMachine(comfyUrl: string): boolean {
  let host: string;
  try {
    host = new URL(comfyUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost") return true;
  if (!isIP(host)) return false;
  // an IPv4 address said the IPv6 way ([::ffff:127.0.0.1], which URL writes ::ffff:7f00:1) is that IPv4 address
  host = unmapped(host);
  const kind = isIP(host);
  if ((kind === 4 && host.startsWith("127.")) || host === "::1") return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((a) => a.address.toLowerCase() === host));
}

/** The IPv4 address an IPv4-mapped IPv6 one stands for (::ffff:7f00:1, ::ffff:127.0.0.1); any other address as it is. */
function unmapped(host: string): string {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted && isIP(dotted[1]!) === 4) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return host;
  const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** ComfyUI's older names of two folders: a request may use either. */
const OTHER_NAME: Record<string, string> = { unet: "diffusion_models", clip: "text_encoders", diffusion_models: "unet", text_encoders: "clip" };

/**
 * The paths ComfyUI reads a model folder from, as it says them on /internal/folder_paths (extra_model_paths.yaml
 * counted). Null when this ComfyUI does not say (an older one): then the folder set in Settings is read instead.
 */
export async function comfyFolderPaths(client: Pick<ComfyClient, "raw">): Promise<Record<string, string[]> | null> {
  try {
    const res = await client.raw("/internal/folder_paths", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const all = (await res.json()) as Record<string, unknown>;
    if (!all || typeof all !== "object") return null;
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : []]));
  } catch {
    return null;
  }
}

/** Where a place of a model folder is, for ComfyUI: its own `models/<folder>`, its folder's older name, or any other it reads. */
export type PlaceKind = "own" | "older" | "other";

/** One of the paths ComfyUI reads a model folder from, as the page is told it. */
export interface Place {
  /** The path as ComfyUI says it: what a choice is kept as. */
  path: string;
  kind: PlaceKind;
  /** In a few words: "models\loras" under ComfyUI's folder, the whole path for any other. */
  shown: string;
}

/** The path functions of the system a path was written on: a pod's are Linux paths, whatever this machine is. */
const pathsOf = (p: string) => (/^[A-Za-z]:[\\/]|^\\\\|\\/.test(p) ? win32 : posix);

/** A path to compare with another: resolved, and without case on Windows, whose disks ignore it. */
const sameKey = (p: string) => {
  const sys = pathsOf(p);
  const resolved = sys.resolve(p).replace(/[\\/]+$/, "");
  return sys === win32 ? resolved.toLowerCase() : resolved;
};

/**
 * ComfyUI's own folder, from what it says: its custom_nodes' parent (ComfyUI's main.py folder, or the base folder it was
 * started on); else the folder set in Settings. Null when neither says.
 */
export function comfyBase(paths: Record<string, string[]> | null, comfyDir: string): string | null {
  const nodes = paths?.custom_nodes?.[0];
  if (nodes && pathsOf(nodes).basename(nodes).toLowerCase() === "custom_nodes") return pathsOf(nodes).dirname(nodes);
  return comfyDir.trim() || null;
}

/**
 * The paths ComfyUI reads a model folder from, in the order Afflatus downloads into them (card #59): ComfyUI's own
 * `models/<folder>` first, then its folder's older name there (`unet`, `clip`), then the others in ComfyUI's order. ComfyUI
 * lists the older name and extra_model_paths.yaml's folders first: a download landed in models\unet, or in an A1111
 * install's Lora folder, where nobody looked for it. Without ComfyUI's folder known, a `models/<name>` path stands for its own.
 */
export function placesOf(listed: string[], folder: string, base: string | null): Place[] {
  // the folder's other name (a download asked under "unet" takes models\diffusion_models second)
  const older = OTHER_NAME[folder] ?? null;
  const named = (p: string, name: string) => {
    const sys = pathsOf(p);
    if (base) return sameKey(p) === sameKey(sys.join(base, "models", name));
    const parts = p.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1)?.toLowerCase() === name.toLowerCase() && parts.at(-2)?.toLowerCase() === "models";
  };
  const seen = new Set<string>();
  const all: Place[] = [];
  for (const p of listed) {
    if (!p || seen.has(sameKey(p))) continue;
    seen.add(sameKey(p));
    all.push({ path: p, kind: named(p, folder) ? "own" : older && named(p, older) ? "older" : "other", shown: shownPlace(p, base) });
  }
  const rank: Record<PlaceKind, number> = { own: 0, older: 1, other: 2 };
  // a stable sort: ComfyUI's own order kept within each kind
  return all.map((p, i) => ({ p, i })).sort((a, b) => rank[a.p.kind] - rank[b.p.kind] || a.i - b.i).map(({ p }) => p);
}

/** A model folder's path in a few words: "models\loras" under ComfyUI's folder, the whole path anywhere else. */
export function shownPlace(p: string, base: string | null): string {
  if (!base) return p;
  const sys = pathsOf(p);
  const rel = sys.relative(base, p);
  return rel && !rel.startsWith("..") && !sys.isAbsolute(rel) ? rel : p;
}

/** Whether two paths name the same folder (case aside on Windows). */
export const samePath = (a: string, b: string) => sameKey(a) === sameKey(b);

/** Whether Afflatus could write a model folder here: there, a folder, writable, and not on a network share. */
async function writable(p: string): Promise<boolean> {
  if (!p || isNetworkPath(p) || !isAbsolute(p)) return false;
  try {
    const real = await realpath(p);
    if (!(await stat(real)).isDirectory()) return false;
    await access(real, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** What the page is told of a model folder's places: each with whether it can be written here, the one chosen, and where a download goes now. */
export interface FolderPlaces {
  places: Array<Place & { ok?: boolean }>;
  /** The path chosen in Settings › Models, while ComfyUI still lists it. */
  chosen?: string;
  /** Where a download goes now, in a few words (a place's `shown`). */
  goes?: string;
  /** The way downloads take here cannot be told a place (ComfyUI-Manager, an older node pack): `goes` says where they land, no choice offered. */
  fixed?: true;
}

/**
 * Who downloads into a ComfyUI when Afflatus cannot write its folders itself, as folderPlaces needs it: a node pack that
 * takes the place chosen (PACK_PLACE or newer), an older one, which keeps to the first path ComfyUI lists that it can write,
 * ComfyUI-Manager, which writes under ComfyUI's models folder, or nobody.
 */
export type OtherRoute = "pack" | "old-pack" | "manager" | "none";

/**
 * Every model folder's places on a ComfyUI (placesOf), for the page: on this machine, whether each can be written and where
 * a download goes (the chosen one when it can be written, else the first that can, as modelRoot picks). Where Afflatus
 * cannot write (another machine, or nothing writable here), where `others` puts it: the node pack the chosen one, else
 * ComfyUI's own models/<folder>, which only it can check; an older pack ComfyUI's first path for the folder whatever was
 * chosen, and ComfyUI-Manager models/<folder>, so neither is offered a choice it would not keep (Manager was told "default"
 * and wrote into the first path ComfyUI lists, an A1111 folder, while the page said models/<folder> and offered the menu).
 */
export async function folderPlaces(paths: Record<string, string[]>, comfyUrl: string, comfyDir: string, chosen: Record<string, string>, others: OtherRoute): Promise<Record<string, FolderPlaces>> {
  const base = comfyBase(paths, comfyDir);
  const local = onThisMachine(comfyUrl);
  const out: Record<string, FolderPlaces> = {};
  for (const folder of Object.keys(paths).sort()) {
    if (NOT_MODELS.has(folder)) continue;
    const listed = listedFor(paths, folder);
    const places: FolderPlaces["places"] = placesOf(listed, folder, base);
    if (!places.length) continue;
    if (local) for (const p of places) p.ok = await writable(p.path);
    const pick = chosen[folder] ? places.find((p) => samePath(p.path, chosen[folder]!)) : undefined;
    // Afflatus writes it itself: the chosen place when it can be written, else the first that can (modelRoot)
    const here = local ? ((pick?.ok ? pick : undefined) ?? places.find((p) => p.ok)) : undefined;
    if (here || others === "pack") {
      const goes = here ?? pick ?? places[0];
      out[folder] = { places, ...(pick ? { chosen: pick.path } : {}), ...(goes ? { goes: goes.shown } : {}) };
      continue;
    }
    // ComfyUI-Manager: under ComfyUI's own models folder, when it is known; an older pack: ComfyUI's first path for it
    const goes = others === "manager" ? (base ? shownPlace(pathsOf(base).join(base, "models", folder), base) : undefined)
      : others === "old-pack" && listed[0] ? shownPlace(listed[0], base) : undefined;
    out[folder] = { places, fixed: true, ...(pick ? { chosen: pick.path } : {}), ...(goes ? { goes } : {}) };
  }
  return out;
}

/** The paths ComfyUI lists for a folder, under its older name when it has none under this one. */
export const listedFor = (paths: Record<string, string[]>, folder: string): string[] =>
  paths[folder] ?? (OTHER_NAME[folder] ? paths[OTHER_NAME[folder]!] : undefined) ?? [];

/**
 * The directory Afflatus downloads a model folder's files into, when it can write there itself: the place chosen for that
 * folder (`chosen`, Settings › Models, when ComfyUI still reads it), else the first in placesOf's order (ComfyUI's own
 * `models/<folder>` first) that exists here and can be written, as its real path. Only a path ComfyUI listed (or, from an
 * older ComfyUI, one of the folder set in Settings) is ever taken, inside that folder when ComfyUI is not on this machine;
 * never one on a network share (see isNetworkPath), never custom_nodes or configs. Null when there is none: the download
 * then goes through ComfyUI.
 */
export async function modelRoot(paths: Record<string, string[]> | null, folder: string, comfyUrl: string, comfyDir: string, chosen?: string): Promise<string | null> {
  const dir = comfyDir.trim();
  // ComfyUI's paths are its machine's: they are this machine's only when it runs here, or when its folder was set here
  const local = onThisMachine(comfyUrl);
  const here = local || Boolean(dir && !isNetworkPath(dir));
  if (!here || NOT_MODELS.has(folder)) return null;
  // a ComfyUI on another machine says paths of its own disk: taken here only inside the folder set in Settings, never
  // wherever that ComfyUI's answer points
  const within = local || !paths ? null : await realpath(dir).catch(() => null);
  if (!local && paths && !within) return null;
  const ordered = placesOf(paths ? listedFor(paths, folder) : await modelDirs(dir, folder), folder, comfyBase(paths, dir)).map((p) => p.path);
  // the place chosen comes first, as long as ComfyUI still reads it: never a path it does not list
  const pick = chosen ? ordered.find((p) => sameKey(p) === sameKey(chosen)) : undefined;
  const listed = pick ? [pick, ...ordered.filter((p) => p !== pick)] : ordered;
  for (const p of listed) {
    if (!p || isNetworkPath(p) || !isAbsolute(p)) continue;
    try {
      const real = await realpath(p);
      if (within && !inside(within, real)) continue;
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

/**
 * ComfyUI's own folder, as a ComfyUI on this machine says it: its custom_nodes folder's parent, on /internal/folder_paths.
 * That is the folder with main.py, or, for ComfyUI Desktop and any install started with --base-directory, the base folder
 * ComfyUI reads its custom_nodes and models from (its code, main.py, lives elsewhere: Desktop's in the app's resources).
 * Null for one on another machine (its paths are its own disk's), one that does not say, or a folder that is not here or
 * is neither: Settings › ComfyUI's folder is then set by hand. What lets Afflatus write its node pack in.
 */
export async function comfyFolderOf(client: Pick<ComfyClient, "raw">, comfyUrl: string): Promise<string | null> {
  if (!onThisMachine(comfyUrl)) return null;
  const nodes = (await comfyFolderPaths(client))?.custom_nodes?.[0];
  if (!nodes || !isAbsolute(nodes) || isNetworkPath(nodes)) return null;
  const dir = dirname(nodes);
  const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
  if (await stat(join(dir, "main.py")).then(() => true, () => false)) return dir;
  // a base folder: the custom_nodes ComfyUI reported, with a models folder beside it (only a folder ComfyUI itself named)
  return basename(nodes) === "custom_nodes" && (await isDir(nodes)) && (await isDir(join(dir, "models"))) ? dir : null;
}
