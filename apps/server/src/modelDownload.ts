import { createHash } from "node:crypto";
import { access, constants, mkdir, open, realpath, rename, rm, stat, statfs } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, posix, win32 } from "node:path";
import { otherName, SAFETENSORS } from "@afflatus/core";
import { civitaiSites } from "./civitai";
import { hashOf, isInside, sleep } from "./fsUtil";
import { isNetworkPath } from "./linked";
import { modelDirs } from "./modelFiles";
import { cannotReach, failCode, fetchFailure, fetchPublic, hostOf } from "./outbound";
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
/** Tried and failed too many times in a row on something that passes (a cut, a 5xx, nothing coming): what came may be carried on from. */
export class Passing extends Refused {}
/** What came is not the file (another size, another SHA-256, not a safetensors): its .part is never carried on from. */
class Wrong extends Refused {}

export const REFUSED = "The site refused the download. For Civitai, save a key in Settings › Models › Civitai API key: some files need an account.";
/** Hugging Face's refusal of a gated file: an account that accepted the model's licence, through its token, is what it wants. */
export const REFUSED_HF = "Hugging Face refused the download: the file is gated. Accept the model's licence on its Hugging Face page, signed in with the account whose token is in Settings › Models › Hugging Face token, and give the token read access to gated repositories.";
/** Civitai refusing the key itself: a 401 although one was sent. */
export const KEY_REFUSED = "Civitai refused the API key (expired, revoked or mistyped): save a new one in Settings › Models › Civitai API key.";
/** Civitai's 401 for a file its creator closed: `{"error":"Unauthorized","message":"The creator of this asset has disabled downloads on this file"}`, key or none (card #206). */
export const DOWNLOADS_DISABLED = "The creator disabled downloads of this file on Civitai: no key or account gets it there.";
/** What a 401's message says when it is about who asks (a key, an account): anything else is the file itself refused. */
const ABOUT_WHO = /\b(api ?key|key|token|auth\w*|log(?:ged)? ?in|sign(?:ed)? ?in|session|account)\b/i;
/** A refusal a key saved in the Settings may undo: the key refused, or none sent where Civitai wants an account. Any other is the file's own. */
export const keyMayDo = (said: string): boolean => said === KEY_REFUSED || said === REFUSED;
/** What a refusal is said as: Hugging Face's gated files get their own words. */
export const refusedSaid = (source: string): string => (/^https:\/\/(huggingface\.co|hf\.co)\//i.test(source) ? REFUSED_HF : REFUSED);

/** A version Civitai sells (Early Access, paid for with Buzz), as its 403 says it: `{"error":"Early Access","message":"…use Buzz…"}`. */
const PAID_WORDS = /early access|buzz|purchase/i;
/** A Civitai download address's version: `/api/download/models/<version>`. */
const versionOf = (url: string) => Number(/\/api\/download\/models\/(\d+)/.exec(url)?.[1] ?? 0);

const PAID_SAID = "This version is paid on Civitai";
/** A paid version's words: until when when Civitai says so (Early Access ends, the version is free then), and its page. */
export const paidSaid = (page: string | null, until?: string | null): string =>
  `${PAID_SAID} (Early Access${until ? ` until ${until.slice(0, 10)}` : ""}): unlock it with Buzz on its page${page ? ` (${page})` : ""}, or pick another version.`;

/** Whether a refusal is a paid version's (paidSaid): one for a while only, or until the user unlocks it. */
export const isPaidSaid = (said: string): boolean => said.startsWith(PAID_SAID);

/**
 * Why a site refused a download (a 401 or a 403, or a sign-in page), in the words that say what to do. Civitai says its
 * own reason in a small JSON body, read here: a paid version (Early Access) is not a missing key, and a key it refuses
 * is not one never saved (card #163: a saved, valid key was told to save one). Anything else, as before. The body is
 * read or let go here, either way.
 */
export async function refusalOf(res: Response, source: string, headers: Record<string, string> = {}): Promise<string> {
  const civitai = civitaiSites().some((site) => source.toLowerCase().startsWith(`${site.toLowerCase()}/`));
  if (!civitai) {
    await res.body?.cancel().catch(() => {});
    return refusedSaid(source);
  }
  const body = /json/.test(res.headers.get("content-type") ?? "") ? ((await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null) : (await res.body?.cancel().catch(() => {}), null);
  const said = [body?.error, body?.message].filter((x): x is string => typeof x === "string").join(": ").slice(0, 240);
  const keyed = Object.keys(headers).some((h) => h.toLowerCase() === "authorization");
  const version = versionOf(source);
  if (PAID_WORDS.test(said)) {
    const origin = new URL(source).origin;
    // when Early Access ends is on the version, not in the refusal: asked once, a moment at most, and left out when it does not come
    const v = version ? await fetchPublic(`${origin}/api/v1/model-versions/${version}`, { headers: { "User-Agent": "afflatus", ...headers }, signal: AbortSignal.timeout(5000) }, civitaiSites())
      .then((r) => (r.ok ? (r.json() as Promise<{ paidAccess?: { endsAt?: string | null } | null }>) : null)).catch(() => null) : null;
    return paidSaid(version ? `${origin}/model-versions/${version}` : null, v?.paidAccess?.endsAt);
  }
  // a 401 is Civitai's answer to the creator closing the file too (card #206: a valid key was told it was refused): its
  // message says which. Only one about the key or an account is a key refused; one saying nothing, as before
  const message = typeof body?.message === "string" ? body.message : "";
  if (res.status === 401 && /disabled downloads/i.test(message)) return DOWNLOADS_DISABLED;
  if (res.status === 401 && message && !ABOUT_WHO.test(message)) return `Civitai refused the download (${said}).`;
  if (res.status === 401) return keyed ? KEY_REFUSED : REFUSED;
  if (res.status === 403 && said) return `Civitai refused the download (${said}).`;
  return REFUSED;
}

/** A size in words: "7.3 GB", "48 MB"; a few bytes are "1 MB", none are "0 MB". */
export const sizeText = (n: number) => (n >= 2 ** 30 ? `${(n / 2 ** 30).toFixed(1)} GB` : `${n > 0 ? Math.max(1, Math.round(n / 2 ** 20)) : 0} MB`);

/** Folders ComfyUI lists that hold code or settings, not models: never downloaded into (the node pack refuses them too). */
export const NOT_MODELS = new Set(["custom_nodes", "configs"]);

/** What a file's name must not hold on any system: a drive's colon, Windows' reserved characters, control characters. */
export const BAD_NAME = /[:*?"<>|\x00-\x1f]/;
/** A name made safe to save under: a path's separators and whatever BAD_NAME refuses made "_". */
export const cleanName = (name: string): string => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_");

/** A SHA-256 as a site lists it: 64 hex digits, either case. */
export const SHA256_HEX = /^[0-9a-f]{64}$/i;
/** A SHA-256 a site lists, in lower case; "" for anything else. */
export const shaOf = (x: unknown): string => (typeof x === "string" && SHA256_HEX.test(x) ? x.toLowerCase() : "");

/**
 * More than any model file is (the largest are some tens of GB): a site saying more is not believed. A Content-Range of
 * 10^21 bytes once built a list of pieces that would never end.
 */
export const MOST = 512 * 2 ** 30;

/** What is kept free on the disk beyond the file itself: a disk filled to its last byte troubles everything on it. */
const SPARE = 256 * 2 ** 20;

/** The free bytes of the disk a directory is on. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Refuse a download the disk has no room for, before a byte of it is written: beside `kept`, what the other downloads under
 * way still have to write there, and SPARE. A disk whose free space cannot be read is refused too (it was taken as
 * endless). Gives the room left for this one.
 */
export async function assertRoom(dir: string, need: number, free: (dir: string) => Promise<number> = freeBytes, kept = 0): Promise<number> {
  const has = await free(dir).catch((err: unknown) => {
    throw new Refused(`The free space of the disk of ${dir} could not be read (${failCode(err) ?? (err as Error).message}).`);
  });
  if (need > 0 && has - kept < need + SPARE) {
    const others = kept > 0 ? `, ${sizeText(kept)} of it kept for the other download under way` : "";
    throw new Refused(`Not enough free space for it: the file is ${sizeText(need)}, and the disk of ${dir} has ${sizeText(has)} free${others}. Make room, then press Download again.`);
  }
  return has - kept - SPARE;
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
  /** A big file over several connections at once, when the site serves parts of it (inParts); one connection without. */
  parts?: Parts;
  /** The file's size as its source lists it (Civitai), when known: a file too small for parts is not asked one byte first. */
  size?: number;
  /** The file's SHA-256 as its source lists it (Civitai): checked before the file is named, as Hugging Face's is. */
  sha256?: string;
  /** A failure leaves what came in the .part (one whose bytes are wrong aside), for the next download of the file to carry on from. */
  keepPart?: boolean;
  /** Carry on from the .part an earlier try left, when there is one: else it is removed first. */
  takeOver?: boolean;
  /** What the other downloads under way still have to write on the same disk: room this one cannot count on. */
  reserved?(): number;
  /** How long a request may bring nothing before it is taken for cut (STALL_MS; shorter in tests). */
  stallMs?: number;
}

/**
 * How many connections Afflatus's own downloads use in all. Civitai serves each connection at 17–33 MB/s and no more: on the
 * owner's line (2026-11-02, a signed link read 35 s each way) 1 connection came at 18 MB/s, 4 at 56 and 8 at 68, the line's
 * own limit; on pods 8 came at 233–256 MB/s (card #199). A 20 GB file: ~19 min over one, ~5 min over eight.
 */
export const CONNECTIONS = 8;
/** From this size on, a file is fetched in parts; a smaller one over one connection. */
const PARTS_FROM = 256 * 2 ** 20;
/**
 * The size of a piece: a connection asks for one at a time, so that two downloads at once share the connections piece by
 * piece, and the last pieces of a file are not left to one connection for long.
 */
const PIECE_MIN = 32 * 2 ** 20;
const PIECE_MAX = 256 * 2 ** 20;

/**
 * Connections several downloads share: each request takes one for as long as it reads, and waits its turn when none is
 * free. A stop ends the wait.
 */
export class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.free = size;
  }

  /** One connection, waited for as long as it takes: the function given back lets it go, once. */
  async take(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error("stopped");
    if (this.free > 0) this.free--;
    else
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal.removeEventListener("abort", stop);
          resolve();
        };
        const stop = () => {
          this.waiting.splice(this.waiting.indexOf(go), 1);
          reject(signal.reason ?? new Error("stopped"));
        };
        this.waiting.push(go);
        signal.addEventListener("abort", stop, { once: true });
      });
    let given = false;
    return () => {
      if (given) return;
      given = true;
      // handed straight to the first that waits, else free again
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/** The connections every download of this Afflatus shares: two files at once share the eight. */
const SLOTS = new Slots(CONNECTIONS);

export interface Parts {
  /** How many connections one file may use at once (1: never in parts). */
  connections: number;
  /** The connections it shares with the other downloads (SLOTS). */
  slots?: Slots;
  /** From what size on, and pieces of what size (the tests' small files). */
  from?: number;
  piece?: number;
}

/**
 * How long a request may bring nothing (no answer, no byte) before it is taken for a cut connection, as the node pack's 60 s
 * (downloads.py run): undici alone waits five minutes a try, and five silent tries held a download for 25 minutes.
 */
const STALL_MS = 60_000;

/** A request's own end when nothing comes for `ms`: tried again as a cut. `poke` as each block comes. */
function stallGuard(signal: AbortSignal, ms: number) {
  const own = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => own.abort(new Error(`nothing came for ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`)), ms);
  };
  poke();
  return { signal: AbortSignal.any([signal, own.signal]), poke, done: () => clearTimeout(timer) };
}

/** What Hugging Face says of a file on its answer that sends on to the bytes: its size and SHA-256 (x-linked-size, x-linked-etag). */
export function linkedOf(res: Response): { size?: number; sha256?: string } {
  const size = Number(res.headers.get("x-linked-size"));
  const sha256 = shaOf(/^(?:W\/)?"?([0-9a-f]{64})"?$/i.exec(res.headers.get("x-linked-etag") ?? "")?.[1]);
  return { ...(size > 0 ? { size } : {}), ...(sha256 ? { sha256 } : {}) };
}

/** A 206's Content-Range ("bytes 0-99/1000"): its first and last byte, and the file's size (null for "*"); null when it says none. */
export function rangeOf(res: Response): { start: number; end: number; size: number | null } | null {
  const got = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
  return got ? { start: Number(got[1]), end: Number(got[2]), size: got[3] === "*" ? null : Number(got[3]) } : null;
}

/**
 * Why an answer is not the file: a refusal (a 401, a 403, or a page: a sign-in), in the site's words (refusalOf); another
 * status; or JSON in place of the bytes. Null for an answer that is the file, or a part of it. Its body is let go when it is not.
 */
export async function notTheFile(res: Response, source: string, headers: Record<string, string>): Promise<{ said: string; refused: boolean } | null> {
  const type = res.headers.get("content-type") ?? "";
  if (res.ok && res.body && !/text\/html|application\/json/.test(type)) return null;
  const refused = res.status === 401 || res.status === 403 || /text\/html/.test(type);
  if (refused) return { said: await refusalOf(res, source, headers), refused };
  await res.body?.cancel().catch(() => {});
  return { said: `The site answered ${res.status}.`, refused };
}

/** What undici says of a cut connection, in its own words ("terminated", "other side closed"). */
const CUT = /terminated|other side closed|ECONNRESET|socket|fetch failed|EPIPE/i;

/**
 * Why a request failed, said plainly: a cut connection as one, and, given how much of the file came (`at`), where; before
 * any came, what kept it from coming (a host not reached).
 */
function whyFailed(err: unknown, at?: { have: number; source: string }): string {
  const said = (err as Error).message.replace(/\.$/, "");
  if (!CUT.test(said)) return said;
  if (!at) return "the connection was cut";
  if (at.have) return `the connection was cut at ${sizeText(at.have)}`;
  return /fetch failed/i.test(said) ? fetchFailure(err, at.source) : "the connection was cut before any of the file came";
}

/** A disk with no room left: no try after this one fares better (the node pack's DISK_FULL). */
const DISK_FULL = new Set(["ENOSPC", "EDQUOT"]);
const diskFull = (err: unknown) => DISK_FULL.has(String((err as { code?: unknown }).code));
const DISK_FULL_SAID = (err: unknown) => `The disk is full (${(err as { code?: unknown }).code}): make room, then press Download again.`;

/** Tries in a row that gain nothing, counted for one request after another: past the last, given up (Passing) with why. */
class Tries {
  private fails = 0;

  constructor(private readonly attempts: number, private readonly backoff: number) {}

  /** One more try that failed (`gained`: some of the file came in it): how long to wait before the next, or Passing past the last. */
  failed(why: string, gained: boolean, then: string): number {
    this.fails = gained ? 1 : this.fails + 1;
    if (this.fails >= this.attempts) throw new Passing(`The download failed ${this.attempts} times in a row (${why}). ${then}`);
    return this.backoff * 2 ** (this.fails - 1);
  }

  /** The try that comes next, said as "(2 of 5)". */
  get next(): string {
    return `(${this.fails + 1} of ${this.attempts})`;
  }

  succeeded(): void {
    this.fails = 0;
  }
}

/**
 * Download `source` into `dest`: written as it comes to `<dest>.part`, picked up with a Range request where it
 * stopped when the connection is cut (from the start again when the site ignores Range), tried again with a
 * growing wait on a cut, a 5xx or nothing coming for a while, and renamed to `dest` only once all of it is there and
 * checked. A stop (the signal) removes the .part, and so does a failure, unless `keepPart`: then only one whose bytes are
 * wrong does, and the next download of the file carries on from it (`takeOver`). Refused is thrown for what trying again
 * would not change. A big file the site serves in parts comes over several connections first (`parts`, inParts), and
 * over one from where they left it.
 */
export async function fetchToFile(o: FetchTo): Promise<{ bytes: number; sha256: string }> {
  const part = `${o.dest}.part`;
  const tries = new Tries(o.attempts ?? 5, o.backoffMs ?? 2000);
  const stallMs = o.stallMs ?? STALL_MS;
  let have = 0;
  let total = 0;
  let hash = createHash("sha256");
  // what Hugging Face says of the file on its first answer, before it sends on to where the bytes are
  const expect = { size: 0, sha: "" };
  // what the source lists (Civitai) is the one held to; Hugging Face's own, read on the way, otherwise
  const listed = shaOf(o.sha256);
  let roomChecked = false;
  // the most this one connection may write when the site says no size: what the disk has free (assertRoom)
  let most = MOST;
  const removePart = () => rm(part, { force: true }).catch(() => {});
  const seen = (res: Response) => {
    const { size, sha256 } = linkedOf(res);
    if (size) expect.size = size;
    if (sha256) expect.sha = sha256;
  };
  const parts = o.parts && o.parts.connections > 1 && !(o.size && o.size < (o.parts.from ?? PARTS_FROM)) ? { ...o.parts, slots: o.parts.slots ?? SLOTS } : null;
  // what an earlier try left, carried on from (never more than the file is said to be: that one is not of this file)
  if (o.takeOver) have = await stat(part).then((s) => (s.isFile() && !(o.size && s.size > o.size) ? s.size : 0), () => 0);
  if (have) hash = await hashOf(part, have);
  else await removePart();
  try {
    if (parts) {
      const got = await inParts(o, parts, part, seen, expect, { have, hash });
      if (got) {
        ({ have, total, hash } = got);
        roomChecked = true;
      }
    }
    while (!total || have < total) {
      if (o.signal.aborted) throw o.signal.reason ?? new Error("stopped");
      const before = have;
      let file: Awaited<ReturnType<typeof open>> | null = null;
      // over several connections, one request takes one of those all downloads share, for as long as it reads
      let release: (() => void) | null = null;
      const stall = stallGuard(o.signal, stallMs);
      try {
        if (parts) release = await parts.slots.take(o.signal);
        stall.poke();
        const res = await fetchPublic(o.source, { headers: { "User-Agent": "afflatus", Accept: "*/*", ...o.headers, ...(have ? { Range: `bytes=${have}-` } : {}) }, signal: stall.signal }, o.allow, 5, seen);
        if (res.status === 416 && have) {
          await res.body?.cancel().catch(() => {});
          // asked for what comes after the last byte: it was all there already
          const size = Number(/^bytes \*\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1] ?? 0);
          if (have === (size || total || expect.size || o.size)) {
            total = have;
            break;
          }
          // what an earlier try left does not end where the file does: from the start again
          have = 0;
          hash = createHash("sha256");
          await removePart();
          throw new Error("the site would not carry on from where the file had stopped");
        }
        if (res.status >= 500 || res.status === 429) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`the site answered ${res.status}`);
        }
        const wrong = await notTheFile(res, o.source, o.headers);
        if (wrong || !res.body) throw new Refused(wrong?.said ?? `The site answered ${res.status}.`);
        const range = res.status === 206 ? rangeOf(res) : null;
        if (range && range.start === have) {
          total = range.size ?? total;
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
        if (!total && expect.size) total = expect.size;
        if (expect.size && total && expect.size !== total) throw new Wrong(`The site says the file is ${expect.size} bytes, and sends ${total}.`);
        heldTo(total, o.size);
        if (!roomChecked) {
          await mkdirFor(o.dest);
          const free = await assertRoom(dirOf(o.dest), total - have, o.free, o.reserved?.() ?? 0);
          // a size not said: written no further than the disk has room for, never till it is full
          if (!total) most = Math.min(MOST, have + free);
          roomChecked = true;
        }
        file = await open(part, have ? "a" : "w");
        o.onBytes(have, total);
        // each piece written before it is counted: what was counted is what the .part holds, so a cut picks up exactly there
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          stall.poke();
          if (!total && have + value.length > most) {
            await reader.cancel().catch(() => {});
            throw new Refused(`The site did not say the file's size, and it came past the room the disk of ${dirOf(o.dest)} has (${sizeText(have)}): make room, then press Download again.`);
          }
          await file.write(value);
          hash.update(value);
          have += value.length;
          o.onBytes(have, total);
        }
        await file.close();
        file = null;
        if (total && have < total) throw new Error(`the connection was cut at ${sizeText(have)} of ${sizeText(total)}`);
        if (total && have > total) throw new Wrong(`The site sent more than the ${total} bytes it said.`);
        break;
      } catch (err) {
        stall.done();
        release?.();
        await file?.close().catch(() => {});
        if (o.signal.aborted) throw err;
        if (err instanceof Refused) throw err;
        // a redirect refused on the way (into the network, down to http, one too many): the same again next time
        if (typeof (err as { statusCode?: unknown }).statusCode === "number") throw new Refused((err as Error).message);
        if (diskFull(err)) throw new Refused(DISK_FULL_SAID(err));
        // a write that failed half way leaves the .part shorter than counted: picked up from what is really there
        const onDisk = await stat(part).then((s) => s.size, () => 0);
        if (onDisk !== have) {
          have = Math.min(onDisk, have);
          hash = await hashOf(part, have);
        }
        // a host that cannot be reached at all (refused, unknown, a bad certificate) before a byte came: trying again changes nothing
        if (!have && cannotReach(err)) throw new Refused(`Could not reach ${hostOf(o.source)} (${failCode(err)}). Check the address, then press Download again.`);
        const why = whyFailed(err, { have, source: o.source });
        const wait = tries.failed(why, have > before, o.keepPart && have ? `Press Download again to carry on from ${sizeText(have)}.` : "Press Download again to start over.");
        o.onRetry?.(`${why[0]!.toUpperCase()}${why.slice(1)}: trying again${have ? ` from ${sizeText(have)}` : ""} ${tries.next}.`);
        await sleep(wait, o.signal);
      } finally {
        stall.done();
        release?.();
      }
    }
    if (expect.size && have !== expect.size) throw new Wrong(`The file came incomplete: ${have} of ${expect.size} bytes. Press Download again.`);
    const sha256 = hash.digest("hex");
    if ((listed || expect.sha) && sha256 !== (listed || expect.sha)) throw new Wrong(`The file came damaged: its SHA-256 is not the one ${listed ? "the site" : "Hugging Face"} lists. Press Download again.`);
    if (SAFETENSORS.test(o.dest) && !(await looksLikeSafetensors(part, have))) throw new Wrong("What came is not a safetensors file (the site sent something else under that name). Check the address.");
    // never over a file that is there: ComfyUI may have it in use, and it was asked for as missing
    if (await stat(o.dest).then(() => true, () => false)) throw new Wrong("A file of that name is in the folder already.");
    await rename(part, o.dest);
    return { bytes: have, sha256 };
  } catch (err) {
    // kept for the next try to carry on from: what came, unless it was stopped or its bytes are wrong
    const keep = o.keepPart && !o.signal.aborted && !(err instanceof Wrong) && (await stat(part).then((s) => s.size > 0, () => false));
    if (!keep) await removePart();
    throw err;
  }
}

/** The site's size for the file held to the one its source lists (Civitai), and to what a model file can be. */
function heldTo(total: number, listed?: number): void {
  if (listed && total && total !== listed) throw new Wrong(`The site sends ${total} bytes, and lists the file as ${listed}. Press Download again.`);
  if (total > MOST) throw new Wrong(`The site says the file is ${sizeText(total)}: no model file is that big.`);
}

/** The site no longer answers parts of the file (a 200 to a Range, a 429, its link refused again and again): the rest over one connection. */
class NoParts extends Error {}

/** A piece's request answered with another status than a part. */
class Answered extends Error {
  constructor(readonly status: number) {
    super(`the site answered ${status}`);
  }
}

/** A piece of the file: from `start` up to `end` (not included), `done` of it on disk. */
interface Piece {
  start: number;
  end: number;
  done: number;
}

/**
 * A big file over several connections at once, as the node pack fetches one on a pod (downloads.py _in_parts, card #199):
 * the source is asked for one byte first, with the key, and a 206 saying the file's size, from the link it sends on to (the
 * file server's signed link: the key never goes there), splits the rest of the file (from `from.have`, what an earlier try
 * left) into pieces, each asked for with its own Range by `connections` at once and written at its place in the .part. Each
 * request takes one of the connections every download shares. The SHA-256 is read as the bytes become whole from the first
 * on, so the check costs no wait at the end. A link refused (it expired: Civitai's last 24 h) is asked for again at the
 * source, by one connection while the others wait. A piece answered shorter than asked (a server that caps its parts) is
 * taken as far as it goes, and the rest of it asked for next.
 *
 * Null when the site does not answer a part (one connection says what is wrong then). However it ends, the .part is cut back
 * to its bytes whole from the first on; a stop or a failure throws, a site that stops answering parts gives back those
 * bytes, for one connection to carry on from.
 */
async function inParts(
  o: FetchTo, p: Required<Pick<Parts, "connections" | "slots">> & Parts, part: string, seen: (res: Response) => void,
  expect: { size: number }, from: { have: number; hash: ReturnType<typeof createHash> },
): Promise<{ have: number; total: number; hash: ReturnType<typeof createHash> } | null> {
  const attempts = o.attempts ?? 5;
  const backoff = o.backoffMs ?? 2000;
  const stallMs = o.stallMs ?? STALL_MS;
  // whatever ends one connection ends them all: a stop, a refusal, the site no longer answering parts
  const quit = new AbortController();
  const stop = () => quit.abort(o.signal.reason);
  if (o.signal.aborted) stop();
  o.signal.addEventListener("abort", stop, { once: true });
  const firstHost = new URL(o.source).host;

  /** One byte asked at the source: its file server's link, and the file's size. A refusal said when `refused` (a link renewed). */
  const ask = async (refused: boolean): Promise<{ link: string; total: number } | null> => {
    const release = await p.slots.take(quit.signal);
    try {
      const res = await fetchPublic(o.source, { headers: { "User-Agent": "afflatus", Accept: "*/*", ...o.headers, Range: "bytes=0-0" }, signal: AbortSignal.any([quit.signal, AbortSignal.timeout(stallMs)]) }, o.allow, 5, seen);
      const range = res.status === 206 ? rangeOf(res) : null;
      if (range?.start === 0 && range.end === 0 && range.size) {
        await res.body?.cancel().catch(() => {});
        return { link: res.url || o.source, total: range.size };
      }
      const wrong = refused ? await notTheFile(res, o.source, o.headers) : null;
      if (wrong?.refused) throw new Refused(wrong.said);
      await res.body?.cancel().catch(() => {});
      return null;
    } finally {
      release();
    }
  };

  let first: Awaited<ReturnType<typeof ask>>;
  try {
    first = await ask(false);
  } catch (err) {
    o.signal.removeEventListener("abort", stop);
    if (o.signal.aborted) throw err;
    // what kept it from answering is said by one connection, which asks the same
    return null;
  }
  const total = first?.total ?? 0;
  if (!first || total < (p.from ?? PARTS_FROM)) {
    o.signal.removeEventListener("abort", stop);
    return null;
  }
  try {
    // the size Hugging Face said on the way, the one the source lists and what a model can be: before a piece is asked
    if (expect.size && expect.size !== total) throw new Wrong(`The site says the file is ${expect.size} bytes, and sends ${total}.`);
    heldTo(total, o.size);
    if (from.have > total) throw new Wrong(`What an earlier try left is ${sizeText(from.have)}, more than the ${sizeText(total)} of the file.`);
    await mkdirFor(o.dest);
    await assertRoom(dirOf(o.dest), total - from.have, o.free, o.reserved?.() ?? 0);
  } catch (err) {
    o.signal.removeEventListener("abort", stop);
    throw err;
  }
  if (from.have === total) {
    o.signal.removeEventListener("abort", stop);
    return { have: total, total, hash: from.hash };
  }
  let link = first.link;

  const size = p.piece ?? Math.min(PIECE_MAX, Math.max(PIECE_MIN, Math.floor((total - from.have) / (p.connections * 4))));
  const pieces: Piece[] = [];
  for (let at = from.have; at < total; at += size) pieces.push({ start: at, end: Math.min(total, at + size), done: 0 });
  const todo = [...pieces];
  const left = (piece: Piece) => piece.end - piece.start - piece.done;
  // the bytes whole from the first on: up to the first piece not all there, and what of it came
  const whole = () => {
    for (const piece of pieces) if (left(piece)) return piece.start + piece.done;
    return total;
  };
  let counted = from.have;
  let ended: unknown = null;
  const end = (err: unknown) => {
    ended ??= err;
    quit.abort();
  };

  // a link refused, asked for again at the source by the first connection to meet it; another that met it waits for that
  let renewing: Promise<void> | null = null;
  let renewals = 0;
  const renew = (stale: string) => {
    if (link !== stale) return Promise.resolve();
    renewing ??= (async () => {
      // refused again and again, the site may not want this many connections: the rest over one
      if (++renewals > 2) throw new NoParts(`the site refused its link ${renewals} times`);
      // a blip on the way is not the site's answer: one connection asks it again, with its own tries
      const fresh = await ask(true).catch((err: unknown) => {
        if (err instanceof Refused || quit.signal.aborted) throw err;
        throw new NoParts(`the link could not be asked for again (${whyFailed(err)})`);
      });
      if (!fresh) throw new NoParts("the site no longer answers parts of the file");
      if (fresh.total !== total) throw new Wrong(`The site says the file is ${fresh.total} bytes now, and said ${total}. Press Download again.`);
      link = fresh.link;
    })().finally(() => (renewing = null));
    return renewing;
  };

  const file = await open(part, from.have ? "r+" : "w");
  const readPiece = async (piece: Piece, url: string) => {
    const at = piece.start + piece.done;
    // the key to the site's own host alone: a file server's link holds what it needs
    const headers = { "User-Agent": "afflatus", Accept: "*/*", ...(new URL(url).host === firstHost ? o.headers : {}), Range: `bytes=${at}-${piece.end - 1}` };
    const stall = stallGuard(quit.signal, stallMs);
    try {
      const res = await fetchPublic(url, { headers, signal: stall.signal }, o.allow);
      if (res.status !== 206 || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw res.status === 200 ? new NoParts("the site sent the whole file to a request for part of it") : new Answered(res.status);
      }
      // from the byte asked, up to the piece's end at most: a server that caps the size of its parts sends less
      const got = rangeOf(res);
      if (!got || got.start !== at || got.end < at || got.end > piece.end - 1 || (got.size !== null && got.size !== total)) {
        await res.body.cancel().catch(() => {});
        throw new Refused(`The site sent bytes ${got ? `${got.start}-${got.end}/${got.size ?? "*"}` : "with no range"} for ${at}-${piece.end - 1}/${total}.`);
      }
      const ends = got.end + 1;
      // each block written at its place before it is counted: what was counted is what the .part holds
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stall.poke();
        if (piece.start + piece.done + value.length > ends) throw new Refused("The site sent more than the part asked for.");
        await file.write(value, 0, value.length, piece.start + piece.done);
        piece.done += value.length;
        counted += value.length;
        o.onBytes(counted, total);
      }
      if (piece.start + piece.done < ends) throw new Error(`the connection was cut ${sizeText(ends - piece.start - piece.done)} before the end of a part`);
    } finally {
      stall.done();
    }
  };

  const connection = async () => {
    const tries = new Tries(attempts, backoff);
    while (!ended && todo.length) {
      const piece = todo.shift()!;
      try {
        while (left(piece) && !ended) {
          const before = piece.done;
          const url = link;
          let why: string;
          try {
            const release = await p.slots.take(quit.signal);
            try {
              await readPiece(piece, url);
            } finally {
              release();
            }
            tries.succeeded();
            continue;
          } catch (err) {
            if (ended || quit.signal.aborted) return;
            if (err instanceof Refused || err instanceof NoParts) throw err;
            // a redirect refused on the way (into the network, down to http): the same again next time
            if (typeof (err as { statusCode?: unknown }).statusCode === "number") throw new Refused((err as Error).message);
            if (diskFull(err)) throw new Refused(DISK_FULL_SAID(err));
            if (err instanceof Answered) {
              // the signed link refused: it expired
              if (err.status === 401 || err.status === 403 || err.status === 410) {
                await renew(url);
                continue;
              }
              if (err.status === 429) throw new NoParts("the site answered 429 to several connections at once");
              if (err.status < 500) throw new Refused(`The site answered ${err.status}.`);
            }
            why = whyFailed(err);
          }
          const wait = tries.failed(why, piece.done > before, o.keepPart ? "Press Download again to carry on from where it stopped." : "Press Download again to start over.");
          o.onRetry?.(`${why[0]!.toUpperCase()}${why.slice(1)}: trying that part again ${tries.next}.`);
          await sleep(wait, quit.signal);
        }
      } finally {
        if (left(piece)) todo.unshift(piece);
      }
    }
  };

  // the SHA-256 read as the bytes become whole from the first on (the pages just written, still in memory); a stop or a
  // failure ends it at once: what is whole is never named then, and a Stop then Download again waited for it (card #236)
  const hash = from.hash;
  let hashed = from.have;
  let over = false;
  const given = () => o.signal.aborted || (ended !== null && !(ended instanceof NoParts));
  const follow = async () => {
    const reader = await open(part, "r");
    const block = Buffer.allocUnsafe(8 * 2 ** 20);
    try {
      for (;;) {
        const edge = whole();
        while (hashed < edge && !given()) {
          const { bytesRead } = await reader.read(block, 0, Math.min(block.length, edge - hashed), hashed);
          if (!bytesRead) throw new Error("the .part is shorter than what was written to it");
          hash.update(block.subarray(0, bytesRead));
          hashed += bytesRead;
        }
        if (given() || hashed >= total || (over && hashed >= whole())) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await reader.close();
    }
  };

  let have = 0;
  try {
    o.onBytes(counted, total);
    const following = follow().catch(() => {});
    await Promise.all(Array.from({ length: Math.min(p.connections, pieces.length) }, () => connection().catch(end)));
    over = true;
    await following;
  } finally {
    o.signal.removeEventListener("abort", stop);
    have = whole();
    await file.truncate(have).finally(() => file.close());
  }
  if (o.signal.aborted) throw o.signal.reason ?? new Error("stopped");
  if (ended && !(ended instanceof NoParts)) throw ended;
  if (ended) o.onRetry?.(`${(ended as Error).message[0]!.toUpperCase()}${(ended as Error).message.slice(1)}: the rest over one connection, from ${sizeText(have)}.`);
  // the follower stopped short (a read that failed): what is whole is read again
  return { have, total, hash: hashed === have ? hash : await hashOf(part, have) };
}

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

const dirOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
const mkdirFor = (path: string) => mkdir(dirOf(path), { recursive: true });

/** Whether `path` is `root` itself or a place under it (both already real paths): fsUtil's isInside. */
export const inside = isInside;

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
  const older = otherName(folder) ?? null;
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
  paths[folder] ?? (otherName(folder) ? paths[otherName(folder)!] : undefined) ?? [];

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
