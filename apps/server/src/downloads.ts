import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { filesIn } from "@afflatus/comfy";
import { isModelFile } from "@afflatus/core";
import type { EventEmitter } from "node:events";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import { civitaiSites } from "./civitai";
import type { Comfy } from "./comfy";
import { httpError } from "./errors";
import { fileName } from "./media";
import { assertRoom, BAD_NAME, comfyBase, comfyFolderPaths, fetchToFile, freeBytes, modelRoot, NOT_MODELS, type OtherRoute, placeIn, Refused, refusalOf, shownPlace } from "./modelDownload";
import { olderThan } from "./version";
import { assertPublicUrl, cannotReach, fetchFailure, fetchPublic } from "./outbound";
import { renameOver } from "./storage";

/**
 * Model files fetched straight into ComfyUI's model folders, by the first of three routes this ComfyUI allows:
 *
 * - Afflatus itself ("afflatus"), when it can write the folder ComfyUI reads (ComfyUI on this machine):
 *   modelDownload.ts writes the file as it comes, picks it up where it stopped after a cut, and names it only
 *   once it is whole.
 * - The Afflatus node pack ("pack"), on a ComfyUI on another machine that has a pack recent enough: it fetches
 *   the file to disk the same way, and asks again from where it stopped. From the source's own signed link when
 *   the source gives one (signedLink, pack 0.12.0): Afflatus asks Hugging Face or Civitai with its key, here, and
 *   hands over only the temporary link they answer with, so the file comes straight from their servers, never
 *   through this computer's upload, and a rented ComfyUI that cannot reach Afflatus gets it all the same; a link
 *   that expires half way is sent again. Else from a one-time address on Afflatus (serve() answers a Range).
 * - ComfyUI-Manager ("manager"), the last resort: handed a one-time address on Afflatus, or a public Hugging Face
 *   address it reads itself. Manager reads any other address whole into memory before it writes the file: a
 *   file of several gigabytes may fail, and the download says so.
 *
 * Through a one-time address, Afflatus streams the file from its source, counting the bytes on the way: that
 * is the progress bar, and a Civitai key never leaves Afflatus. Afflatus runs AT_ONCE of its own downloads (and
 * the pack's) at a time; the others wait their turn. The list itself is written to a small file in the data
 * folder at each change: a download cut short by Afflatus stopping or restarting is then listed as interrupted
 * at the next start, instead of vanishing without a word (one already handed whole to ComfyUI is done).
 */

export type Via = "afflatus" | "pack" | "manager";

export interface DownloadView {
  id: string;
  /** The name it will have in ComfyUI, with its sub-folder when it has one. */
  file: string;
  /** The ComfyUI model folder it goes into ("loras", "checkpoints", …). */
  folder: string;
  /** What it is, in words, for the list. */
  title: string;
  bytes: number;
  /** 0 when the source does not say. */
  total: number;
  status: "starting" | "downloading" | "saving" | "done" | "error" | "stopped";
  error?: string;
  /** While starting: what it waits for (Afflatus runs AT_ONCE at a time, ComfyUI-Manager one). */
  waiting?: string;
  /** Who downloads it. */
  via?: Via;
  /** The directory it is written into, when Afflatus or the node pack writes it. */
  into?: string;
  /** What to know while it runs: it was cut and picked up again, or Manager may not cope with its size. */
  note?: string;
  /** Its failure was read (the banner dismissed): a page opened later does not announce it again. */
  seen?: boolean;
  /**
   * A pod's file that its node pack says it has already (409): not a failure for the user. The pod's files (podFiles.ts)
   * read it and confirm the file there; the list the page reads leaves it out (no red banner after a restart of Afflatus).
   */
  quiet?: boolean;
  /** The ComfyUI it goes to (settings.ts machines, by id), when it was asked for one. */
  machine?: string;
  /** Failed or stopped, and askable again as it was first asked (the command bar's "Download again", the Downloads card's Try again). */
  again?: true;
  /** Waiting or under way: its place in its machine's line, the ones under way counted first (1 and 2 run, 3 is next). */
  turn?: number;
  /** Where it goes (under way) or went (done), in a few words: "models\loras" under ComfyUI's folder, else the whole path. */
  shown?: string;
  /** How fast it comes now, in bytes a second, evened out; absent while nothing is measured. */
  rate?: number;
  /** When it ended (done, failed or stopped), in ms since 1970: the Downloads card's "Done today · 14:02". */
  at?: number;
  /**
   * Under way: taken from the queue of Afflatus's own downloads and the pack's. Told the page while it is still "starting"
   * (a node pack whose line is full, 429): it waits, but no longer in the line, and cannot be moved (move()).
   */
  begun?: boolean;
  /**
   * Failed as its source refused it (a Refused: a 401 or a 403, the creator's downloads disabled, a paid version): asking it
   * again there changes nothing. The pod's files (podFiles.ts) take it from elsewhere then (card #206).
   */
  refused?: true;
}

/**
 * A failure that passes (ComfyUI not answering for a moment, restarting, its line full): asked again later by whoever asked
 * for it. The pod's files (podFiles.ts) retry these themselves, so a download they asked for says nothing of one while they
 * still have tries left (quietPassing). The node pack's own last words count too: a source's rate limit or 5xx ("the source
 * answered 429)"), a reset, a DNS blip, a connection closed or an SSL stream cut short, which once failed a pod's file for good
 * on a moment's outage of Hugging Face or Civitai. A 404, an expired link with no fresh one and a full disk stay failures
 * (podFiles.ts reads a full disk before this).
 */
export const PASSING = /not answering|cannot be reached|no longer knows the (download|upload)|did not answer|does not answer with|\((429|5\d\d)[:)]|answered (429|5\d\d)\)|fetch failed|ECONN|Errno -?\d+|reset by peer|Remote end closed|EOF occurred|socket|timed? ?out|aborted/i;

/** A path on a disk in a line: quoted (it may hold spaces), a drive's or a share's, or a Unix one of two parts or more. */
const DISK_PATH = /(['"])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"]*)\1|(?<!\w)(?:[A-Za-z]:[\\/]|\\\\)[^\s'"<>|*?]*|(?<![\w.:/\\-])\/(?:[^\s'"<>|/]+\/)+[^\s'"<>|/]*/g;

/**
 * A line of what went wrong without the folders on a disk it names, each path made its file's name: what a download says
 * reaches the page and agents (MCP), and where the user keeps models on this computer is not theirs to read.
 */
export function withoutPaths(text: string): string {
  return text.replace(DISK_PATH, (whole, quote: string | undefined, inner: string | undefined) => {
    const base = (inner ?? whole).split(/[\\/]/).filter(Boolean).pop() ?? "…";
    return quote ? `${quote}${base}${quote}` : base;
  });
}

/** How long a node pack whose line is full (429: its downloads at once under way) is waited for before the download is given up. */
export const PACK_BUSY_MS = 120_000;

/** What a download onto a machine that cannot reach Afflatus (a rented pod) is refused with when its source gives no link of its own. */
export const NO_DIRECT = "Its source gives no download link of its own, and a rented GPU cannot reach Afflatus to be sent the file through it.";
/** What a download is refused with when ComfyUI's machine would have to fetch it through Afflatus at an address it cannot reach. */
export const NO_SELF = "ComfyUI runs on another machine and cannot reach Afflatus at this URL. Open Afflatus by its network URL, or set PUBLIC_URL to it.";

interface Download extends DownloadView {
  /** Its place among the waiting ones: the lowest starts first (move()). */
  order: number;
  /** What it was asked with (fetchFile.ts's body) and the address the page asked from: asked again with them (again, a restart). */
  ask?: unknown;
  from?: string;
  /** The last reading of its bytes, for `rate`. */
  sample?: { bytes: number; at: number };
  /** The node pack's: the place chosen for its folder, asked of the pack (PACK_PLACE). */
  place?: string;
  /** The node pack's: the file's sha256 as its source lists it (Civitai), checked by a pack from 0.44.0 on, passed over by an older one. */
  sha256?: string;
  /** ComfyUI's own folder as it says it: where `shown` is worked out from. */
  base?: string;
  /** Its asker reads the ComfyUI's files again itself once it is there (a pod's files, podFiles.ts landed): not done here too. */
  filesRead?: true;
  token: string;
  source: string;
  headers: Record<string, string>;
  comfy: Comfy;
  finishedAt?: number;
  /** Cuts the download off at its source. */
  abort: AbortController;
  /** Afflatus's own: where the file goes (its .part beside it). */
  dest?: string;
  /** A failure that passes is kept off the page's list: the pod's files ask for the file again (quietPassing). */
  quietPassing?: boolean;
  /** The pack's: the address Afflatus is reached at, and the download's id there. */
  self?: string;
  packId?: string;
  /** The one-time address's stream from the source while one is open: the pack's next request lets it go. */
  upstream?: AbortController;
  /** Manager reads a Hugging Face address itself: no bytes pass through Afflatus. */
  direct?: boolean;
  /** Only from the source's own signed link: ComfyUI's machine cannot reach Afflatus (a rented pod). */
  directOnly?: boolean;
  /**
   * The address Afflatus was asked at is not one ComfyUI's machine reaches (localhost, no PUBLIC_URL): only a link it fetches
   * itself will do, the source's own signed one or a Hugging Face address Manager reads (fetchFile.ts beginDownload).
   */
  noSelf?: boolean;
  /** The pack fetches the source's own signed link (signedLink): no bytes pass through Afflatus; a fresh link is sent when it expires. */
  signed?: boolean;
  /** How many fresh links were sent, and when the last was. */
  renewals?: number;
  renewedAt?: number;
  /** How many times the connection was cut, and the byte it was picked up from last. */
  cuts?: number;
  resumedFrom?: number;
}

/**
 * What the state file keeps of a download: enough to list it again, the .part to remove of one cut short, and what it was
 * asked with: one still waiting its turn (`queued`) is asked again at the next start, in its place in the line.
 */
type Kept = DownloadView & { finishedAt?: number; part?: string; order?: number; ask?: unknown; from?: string; queued?: true };
const INTERRUPTED = "Interrupted: Afflatus was stopped or restarted while it was downloading. Press Download again.";

/** The folders ComfyUI-Manager knows by a type name; any other folder is given to it as a path under models/. */
const MANAGER_TYPE: Record<string, string> = {
  checkpoints: "checkpoints", loras: "lora", vae: "vae", text_encoders: "clip", clip: "clip", diffusion_models: "unet", unet: "unet",
  upscale_models: "upscale", controlnet: "controlnet", clip_vision: "clip_vision", embeddings: "embedding",
};

const KEEP_MS = 60 * 60_000;
/** A failure nobody has read yet stays listed longer: a page opened the next morning still says it. */
const KEEP_UNSEEN_MS = 24 * 60 * 60_000;
const STARTS_WITHIN_MS = 90_000;
/** How many of its own downloads (and the pack's) Afflatus runs at once: two share a fast line well, more only split it. */
export const AT_ONCE = 2;
/** The first node pack that downloads (POST /afflatus/download). */
export const PACK_DOWNLOADS = "0.11.0";

/**
 * Whether the token of a download's one-time address is the one given, compared in constant time: the address is asked
 * for by anyone who reaches Afflatus without a sign-in (SECURITY.md), and a comparison that stops at the first wrong
 * character says, by how long it takes, how much of a guess was right. Both are hashed first, so that their lengths
 * are the same and say nothing either.
 */
export function sameToken(given: unknown, want: string): boolean {
  const hash = (text: string) => createHash("sha256").update(text, "utf8").digest();
  return typeof given === "string" && want.length > 0 && timingSafeEqual(hash(given), hash(want));
}
/** The first node pack that puts a download in ComfyUI's own models/<folder> first, and in the place asked (`dir`) when it lists it. */
export const PACK_PLACE = "0.36.9";
/** The first node pack that downloads from a source's own signed link, and takes a fresh one when it expires. */
export const PACK_SIGNED = "0.12.0";
/** The hosts a signed download link of Hugging Face or Civitai is on: the pack takes no other (downloads.py DIRECT_HOSTS). */
const DIRECT_HOSTS = ["huggingface.co", "hf.co", "civitai.com", "r2.cloudflarestorage.com"];
/**
 * The sites' own pages, which may send a request on to another of their hosts before the file: asked again, not handed
 * over. These hosts exactly, never one under them: Civitai's file server is b2.civitai.com, and taken for one of its pages
 * it was asked again, answered with the file itself, and a pod was told the file had no link of its own.
 */
const API_HOSTS = ["huggingface.co", "www.huggingface.co", "civitai.com", "www.civitai.com"];
const apiPage = (url: URL) => API_HOSTS.includes(url.hostname);
/** Past this many fresh links, a source that keeps refusing its own links from ComfyUI's machine is given up on. */
const MAX_RENEWALS = 4;

const hostIs = (url: URL, hosts: string[]) => hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));

/** Whether an address is one of Hugging Face's or Civitai's own download links: https, on one of their download hosts. */
export function directOk(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && address.length <= 4000 && hostIs(url, DIRECT_HOSTS);
}

/**
 * The source's own temporary download link, asked for here with the key: Hugging Face and Civitai answer a download with
 * a redirect to a signed link on their file servers, which holds no key and lasts an hour or so. The redirects are read,
 * not followed into the file: a page of theirs that sends it on to another of their pages is asked again (the key only to
 * the host first asked), and the first link on a file server is the one. Null when the source answers otherwise, or the
 * link would carry a secret: then the pack fetches through Afflatus, as before. A Refused, with the site's reason, when
 * it refuses the download itself (401 or 403): a rented GPU, which only takes such a link, is told why.
 */
export async function signedLink(source: string, headers: Record<string, string>, fetcher: typeof fetch = fetch): Promise<string | null> {
  const first = new URL(source).host;
  const secrets = Object.values(headers).map((v) => v.replace(/^bearer\s+/i, "").trim()).filter((v) => v.length >= 8);
  let at = source;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetcher(at, { method: "HEAD", headers: { "User-Agent": "afflatus", ...(new URL(at).host === first ? headers : {}) }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    // refused: asked again in full, as a HEAD has no body to say why (Civitai's Early Access, a key it refuses), and said
    // at once if the answer is the same; a host that refuses only HEADs (a signed link of another site) is fetched as before
    if (res.status === 401 || res.status === 403) {
      const again = await fetcher(at, { headers: { "User-Agent": "afflatus", ...(new URL(at).host === first ? headers : {}) }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (again.status === 401 || again.status === 403) throw new Refused(await refusalOf(again, at, new URL(at).host === first ? headers : {}));
      await again.body?.cancel().catch(() => {});
      return null;
    }
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, at);
      if (!directOk(next.href) || secrets.some((s) => next.href.includes(s))) return null;
      // a file server's link is the one; a page of theirs is asked again
      if (!apiPage(next)) return next.href;
      at = next.href;
      continue;
    }
    // the file itself, with no key needed: the address is a download link as it is
    return res.ok && hop === 0 && !Object.keys(headers).length && directOk(source) ? source : null;
  }
  return null;
}
/** Past this, ComfyUI-Manager reading the file whole into memory is a real risk. */
export const BIG = 2 ** 30;
export const MANAGER_BIG =
  "Through ComfyUI-Manager, which holds the whole file in memory before writing it: a file over 1 GB may fail. To download straight to disk, set ComfyUI's folder in Settings › ComfyUI (ComfyUI on this machine), or update the Afflatus node pack (ComfyUI on another machine).";
export const MANAGER_HF = "ComfyUI-Manager downloads it from Hugging Face itself: no progress shows until it is saved.";

export type Route = { via: "afflatus"; root: string } | { via: "pack" } | { via: "manager"; direct?: string; note?: string };

/**
 * Who downloads a file: Afflatus when it can write the folder (`root`), else the node pack when this ComfyUI
 * has one that can, else ComfyUI-Manager. Manager streams a public huggingface.co address to disk on its own
 * (it is handed that address); any other it reads whole into memory, which a file over 1 GB may not survive.
 */
export function chooseRoute(o: { root: string | null; pack: boolean; source: string; headers: Record<string, string>; total: number }): Route {
  if (o.root) return { via: "afflatus", root: o.root };
  if (o.pack) return { via: "pack" };
  if (/^https:\/\/huggingface\.co\//i.test(o.source) && !Object.keys(o.headers).length) return { via: "manager", direct: o.source, note: MANAGER_HF };
  return { via: "manager", note: o.total > BIG ? MANAGER_BIG : undefined };
}

const unreachable = (err: unknown) => /fetch failed|ECONNREFUSED|did not answer/i.test((err as Error).message);
const running = (d: DownloadView) => d.status === "starting" || d.status === "downloading";
/** Whether a time is on today's date, here. */
const today = (at: number, now: number) => new Date(at).toDateString() === new Date(now).toDateString();
/**
 * Whether a finished download is still listed at `now`: an hour after it ended, a day for a failure nobody read, and one
 * done the whole of the day it was done (the Downloads card's "Done today", where each landed).
 */
const stillListed = (d: DownloadView & { finishedAt?: number }, now: number) =>
  !d.finishedAt || now - d.finishedAt < (d.status === "error" && !d.seen ? KEEP_UNSEEN_MS : KEEP_MS) || (d.status === "done" && today(d.finishedAt, now));

export class Downloads {
  private readonly all = new Map<string, Download>();
  /** Downloads of an earlier run, read from the state file: finished ones still shown, interrupted ones said so. */
  private past: Kept[] = [];
  /** Done once the state file was read: list() before that shows this run's only. */
  readonly restored: Promise<void>;
  /** The writes of the state file, one after the other: two at once would interleave. */
  private writing: Promise<void> = Promise.resolve();
  private lastTold = 0;
  /** The next waiting download's place in the line. */
  private nextOrder = 1;
  /** Those still waiting their turn when Afflatus last stopped, in their order: asked again once resume() is given how. */
  private toResume: Kept[] = [];
  /** How long Manager has to come and fetch before the download is given up (shorter in tests). */
  startsWithinMs = STARTS_WITHIN_MS;
  /** How often ComfyUI is asked whether the file is listed, once all of it was sent. */
  listedEveryMs = 3000;
  /** How often the node pack is asked how its download goes, and how long it may say nothing before the download is given up. */
  packEveryMs = 1000;
  /** How often a pack whose line is full is asked again (PACK_BUSY_MS in all). */
  packBusyEveryMs = 3000;
  packBusyMs = PACK_BUSY_MS;
  /** Where a source's own signed link is asked for (signedLink): a test's stand-in. */
  signer: (source: string, headers: Record<string, string>) => Promise<string | null> = signedLink;
  packSilentMs = 120_000;
  /** Tries in a row that gain nothing before Afflatus gives a download up, and the first wait between them (shorter in tests). */
  attempts = 5;
  backoffMs = 2000;
  /** The free bytes of a directory's disk (a stand-in in the tests). */
  free: (dir: string) => Promise<number> = freeBytes;

  constructor(private readonly events: EventEmitter, private readonly stateFile?: string) {
    this.restored = this.restore();
  }

  /** The state file read: what was still under way when Afflatus last ran is listed as interrupted, and its .part removed. */
  private async restore(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const kept = JSON.parse(await readFile(this.stateFile, "utf8")) as Kept[];
      const now = Date.now();
      // still waiting its turn, and asked through the page (its body kept): asked again in its place, not said interrupted
      const waiting = (k: Kept) => Boolean(k && k.queued && k.status === "starting" && k.ask !== undefined && typeof k.from === "string");
      this.toResume = kept.filter(waiting).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const k of this.toResume) this.nextOrder = Math.max(this.nextOrder, (k.order ?? 0) + 1);
      for (const k of kept) if (k && (k.status === "starting" || k.status === "downloading") && typeof k.part === "string" && k.part.endsWith(".part")) await rm(k.part, { force: true }).catch(() => {});
      this.past = kept
        .filter((k) => k && typeof k.id === "string" && !this.toResume.includes(k))
        // "saving": every byte was handed to ComfyUI or is in its folder already, and it lists it whether Afflatus runs or not
        .map((k) => (k.status === "saving" ? { ...k, status: "done" as const, finishedAt: now } : k))
        .map((k) => (k.status === "starting" || k.status === "downloading" ? { ...k, status: "error" as const, error: INTERRUPTED, finishedAt: now, waiting: undefined, note: undefined } : k))
        .map(({ part: _p, queued: _q, order: _o, ...k }) => k)
        .filter((k) => stillListed(k, now));
      if (this.past.some((k) => k.error === INTERRUPTED)) this.tell(true);
    } catch {
      // no file yet, or one that cannot be read: nothing to restore
    }
  }

  /** What the browser is told of a download: never its source, its key or its one-time address. */
  private view(d: Download): DownloadView {
    this.measure(d);
    const { id, file, folder, title, bytes, total, status, error, waiting, via, into, note, seen, machine, quiet, shown, refused } = d;
    const turn = status === "starting" || status === "downloading" ? d.turn : undefined;
    const rate = status === "downloading" && d.rate ? Math.round(d.rate) : undefined;
    const again = (status === "error" || status === "stopped") && d.ask !== undefined ? (true as const) : undefined;
    const begun = status === "starting" && d.begun ? true : undefined;
    const all: DownloadView = { id, file, folder, title, bytes, total, status, error, waiting, via, into, note, seen, machine, quiet, shown, turn, rate, again, at: d.finishedAt, begun, refused };
    for (const k of Object.keys(all) as Array<keyof DownloadView>) if (all[k] === undefined) delete all[k];
    return all;
  }

  /**
   * How fast a download comes, from one reading of its bytes to the next a second or more later, evened out: a slow site
   * then reads as slow, not as stuck. What the line's time left is worked out from.
   */
  private measure(d: Download): void {
    const now = Date.now();
    if (d.status !== "downloading") {
      delete d.sample;
      delete d.rate;
      return;
    }
    if (!d.sample || d.bytes < d.sample.bytes) {
      d.sample = { bytes: d.bytes, at: now };
      return;
    }
    const seconds = (now - d.sample.at) / 1000;
    if (seconds < 1) return;
    const just = (d.bytes - d.sample.bytes) / seconds;
    d.rate = d.rate ? d.rate * 0.6 + just * 0.4 : just;
    d.sample = { bytes: d.bytes, at: now };
  }

  /** The list as it stands, written for the next run. Never awaited: a failure to write changes nothing here. */
  private persist(): void {
    if (!this.stateFile) return;
    // the one being asked again is listed already once its start has it (resume()): kept once, not twice
    const asked = (k: Kept) => [...this.all.values()].some((d) => running(d) && d.file === k.file && d.folder === k.folder && d.machine === k.machine);
    const kept: Kept[] = [...this.past, ...this.toResume.filter((k) => !asked(k)), ...[...this.all.values()].map((d) => {
      const { turn: _t, rate: _r, again: _a, at: _at, begun: _b, ...view } = this.view(d);
      return {
        ...view, order: d.order,
        ...(d.ask !== undefined ? { ask: d.ask, from: d.from } : {}),
        // waiting its turn here, asked again after a restart; never one handed to ComfyUI-Manager, which has it in its own
        // queue already (it is "starting" until Manager comes for the bytes): asked again, Manager was given it twice
        ...(d.status === "starting" && !d.begun && d.via !== "manager" ? { queued: true as const } : {}),
        ...(d.finishedAt ? { finishedAt: d.finishedAt } : {}),
        ...(d.dest ? { part: `${d.dest}.part` } : {}),
      };
    })];
    const file = this.stateFile;
    // written beside it, then put in its place: a stop in the middle of a write leaves the last whole list, never half of one
    this.writing = this.writing
      .then(async () => {
        await writeFile(`${file}.tmp`, JSON.stringify(kept));
        await renameOver(`${file}.tmp`, file);
      })
      .catch((err) => console.warn(`[downloads] the list could not be saved: ${(err as Error).message}`));
  }

  /**
   * Done once every write of the state file asked for so far has ended (a write queued meanwhile is waited for too). For
   * the tests: a test that ends while a write is under way would remove its folder under the open file. @internal
   */
  async flushed(): Promise<void> {
    let at: Promise<void>;
    do {
      at = this.writing;
      await at;
    } while (at !== this.writing);
  }

  private tell(now = false): void {
    // bytes arrive many times a second: say so twice a second at most; the state file is written on the changes of state only
    if (now) this.persist();
    if (!now && Date.now() - this.lastTold < 500) return;
    this.lastTold = Date.now();
    this.events.emit("downloads");
  }

  private fail(d: Download, error: string, refused = false): void {
    if (d.status === "done" || d.status === "error" || d.status === "stopped") return;
    d.status = "error";
    if (refused) d.refused = true;
    // an fs error names the file's whole path (EACCES, ENOSPC on "D:\models\loras\x.part"): said by its name only
    d.error = withoutPaths(error);
    d.finishedAt = Date.now();
    delete d.waiting;
    delete d.note;
    // a failure that passes, on a pod whose files ask for it again: not news yet (the last try is not quiet, and says it)
    const passing = Boolean(d.quietPassing) && PASSING.test(error);
    if (d.machine && (/\(409: that file is there already/.test(error) || passing)) {
      d.quiet = true;
      d.seen = true;
      console.log(passing ? `[downloads] ${d.file} (${d.folder}) on ${d.machine}: ${error}; it is asked again` : `[downloads] ${d.file} (${d.folder}) is on ${d.machine} already, or coming there`);
      return this.tell(true);
    }
    // in the server's log too: a failure is read there when nobody had a page open
    console.warn(`[downloads] ${d.file} (${d.folder}, via ${d.via ?? "?"}) failed: ${error}`);
    this.tell(true);
  }

  /** One download as it stands, by its id; null when it is not (or no longer) listed. */
  get(id: string): DownloadView | null {
    const d = this.all.get(id);
    return d ? this.view(d) : null;
  }

  /**
   * Whether a download runs in this ComfyUI's process now (its node pack's or its Manager's): a restart of that ComfyUI
   * would cut it off, so one for node packs waits for it (queuePacks.ts). Afflatus's own writes go on through a restart.
   */
  runsIn(comfy: Comfy): boolean {
    return [...this.all.values()].some((d) => d.via !== "afflatus" && d.comfy.client.baseUrl === comfy.client.baseUrl
      && (d.status === "downloading" || d.status === "saving" || (d.status === "starting" && Boolean(d.begun))));
  }

  /** Newest first. What finished is forgotten after an hour, a failure nobody read after a day. */
  list(): DownloadView[] {
    const now = Date.now();
    for (const [id, d] of this.all) if (!stillListed(d, now)) this.all.delete(id);
    this.past = this.past.filter((k) => stillListed(k, now));
    const strip = ({ finishedAt, ask, from: _from, order: _o, queued: _q, ...view }: Kept): DownloadView => ({
      ...view,
      ...(finishedAt ? { at: finishedAt } : {}),
      ...((view.status === "error" || view.status === "stopped") && ask !== undefined ? { again: true as const } : {}),
    });
    return [...[...this.all.values()].reverse().map((d) => this.view(d)), ...this.past.slice().reverse().map(strip)].filter((d) => !d.quiet);
  }

  /** Its failure was read: kept on the list (and in the file the list is kept in), no longer announced. */
  seen(id: string): boolean {
    const d = this.all.get(id) ?? this.past.find((k) => k.id === id);
    if (!d) return false;
    if (!d.seen) {
      d.seen = true;
      this.tell(true);
    }
    return true;
  }

  /**
   * Stop a download that is under way, or take a finished one off the list. Nothing is left behind: a .part is
   * removed, and ComfyUI-Manager only writes a file once it has all of it. False when there is no such download,
   * "late" when every byte was already handed over and ComfyUI is saving it, "manager" for one Manager reads
   * from Hugging Face itself (it cannot be stopped from here). `keepPart`: the node pack keeps its .part (0.36.6; an older one
   * removes it), for the next download of that file on that machine to carry on from (a pod's file put back in line).
   */
  stop(id: string, keepPart = false): boolean | "late" | "manager" {
    const d = this.all.get(id);
    if (!d) {
      // one of an earlier run: taken off the list
      const was = this.past.length;
      this.past = this.past.filter((k) => k.id !== id);
      if (this.past.length === was) return false;
      this.tell(true);
      return true;
    }
    if (d.status === "saving") return "late";
    if (d.direct && running(d)) return "manager";
    if (running(d)) {
      d.status = "stopped";
      d.finishedAt = Date.now();
      delete d.waiting;
      delete d.note;
      d.abort.abort();
      // the pack is told too, and removes its .part, or keeps it to carry on from
      if (d.packId) void d.comfy.client.raw(`/afflatus/download/${encodeURIComponent(d.packId)}${keepPart ? "?keep=1" : ""}`, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
      this.pump();
    } else this.all.delete(id);
    this.tell(true);
    return true;
  }

  /** The Manager answers by ComfyUI: a pod's Models tab and the first ComfyUI's banner, read in turn, each asked again (up to 5 s) with one kept. */
  private readonly managerSeen = new Map<string, { at: number; value: { found: boolean; version?: string; unknown?: true } }>();
  /** The questions under way, by ComfyUI: callers meanwhile share the answer. */
  private readonly managerAsking = new Map<string, Promise<{ found: boolean; version?: string; unknown?: true }>>();

  /**
   * Whether this ComfyUI has ComfyUI-Manager, and which. Asked at most every half minute: the list of downloads is read often.
   * A ComfyUI that does not answer (restarting, too busy to answer in time) says nothing either way: `unknown`, kept a few
   * seconds only. Read as "no Manager", it had the queue run jobs without the packs they asked for, saying none could come.
   */
  async manager(comfy: Comfy): Promise<{ found: boolean; version?: string; unknown?: true }> {
    const seen = this.managerSeen.get(comfy.client.baseUrl);
    if (seen && Date.now() - seen.at < (seen.value.unknown ? 5000 : 30_000)) return seen.value;
    // one question at a time per ComfyUI: the planner asks for each machine several times in a pass, and a ComfyUI that does
    // not answer would otherwise have each of them wait out its own 5 s
    const asking = this.managerAsking.get(comfy.client.baseUrl);
    if (asking) return asking;
    const ask = (async () => {
      let value: { found: boolean; version?: string; unknown?: true };
      try {
        const res = await comfy.client.raw("/v2/manager/version", { signal: AbortSignal.timeout(5000) });
        value = res.ok ? { found: true, version: (await res.text()).trim().slice(0, 40) } : res.status >= 500 ? { found: false, unknown: true } : { found: false };
      } catch {
        value = { found: false, unknown: true };
      }
      this.managerSeen.set(comfy.client.baseUrl, { at: Date.now(), value });
      if (this.managerSeen.size > 32) this.managerSeen.delete(this.managerSeen.keys().next().value!);
      return value;
    })().finally(() => this.managerAsking.delete(comfy.client.baseUrl));
    this.managerAsking.set(comfy.client.baseUrl, ask);
    return ask;
  }

  /** Whether this ComfyUI runs a node pack that downloads (PACK_DOWNLOADS or newer). */
  private async packCan(comfy: Comfy): Promise<boolean> {
    const version = await comfy.client.packVersion().catch(() => null);
    return version !== null && !olderThan(version, PACK_DOWNLOADS);
  }

  /**
   * Who downloads into this ComfyUI where Afflatus cannot write itself, for the places the page is told (folderPlaces):
   * the node pack (an older one keeps to ComfyUI's first path), else ComfyUI-Manager, else nobody.
   */
  async others(comfy: Comfy): Promise<OtherRoute> {
    const version = await comfy.client.packVersion().catch(() => null);
    if (version !== null && !olderThan(version, PACK_DOWNLOADS)) return olderThan(version, PACK_PLACE) ? "old-pack" : "pack";
    return (await this.manager(comfy)).found ? "manager" : "none";
  }

  /**
   * route()'s answers, by ComfyUI (and the folder the Settings give it): one per machine, so that two machines asked in
   * turn (the list is read up to twice a second during a download) do not each push the other's out and have their
   * folders, the pack and Manager asked again each time, a pod's over the internet.
   */
  private readonly routeSeen = new Map<string, { at: number; value: Via | "none" }>();

  /**
   * Who downloads into this ComfyUI, in general (one folder Afflatus cannot write may still go another way):
   * for the Settings, and for what a Download button says before it is pressed. Asked at most every half minute.
   */
  async route(comfy: Comfy, comfyDir: string): Promise<Via | "none"> {
    const key = `${comfy.client.baseUrl}|${comfyDir}`;
    const seen = this.routeSeen.get(key);
    if (seen && Date.now() - seen.at < 30_000) return seen.value;
    const paths = await comfyFolderPaths(comfy.client);
    let value: Via | "none" = "none";
    for (const folder of ["checkpoints", "loras", "diffusion_models"]) if (value === "none" && (await modelRoot(paths, folder, comfy.client.baseUrl, comfyDir))) value = "afflatus";
    if (value === "none" && (await this.packCan(comfy))) value = "pack";
    if (value === "none" && (await this.manager(comfy)).found) value = "manager";
    this.routeSeen.set(key, { at: Date.now(), value });
    // kept small, as managerSeen: a machine's address that changed leaves its old answer behind
    if (this.routeSeen.size > 32) this.routeSeen.delete(this.routeSeen.keys().next().value!);
    return value;
  }

  /**
   * Start fetching a file into ComfyUI. `self` is the address ComfyUI can reach Afflatus at (for the one-time
   * address the pack or Manager fetches); `comfyDir` is ComfyUI's folder from the Settings, read for a ComfyUI
   * too old to say its folders.
   */
  async start(comfy: Comfy, self: string, want: {
    file: string; folder: string; title: string; source: string; headers?: Record<string, string>; total?: number; comfyDir?: string; machine?: string;
    directOnly?: boolean; quietPassing?: boolean; filesRead?: boolean;
    /** ComfyUI's machine cannot reach Afflatus at `self` (Download.noSelf). */
    noSelf?: boolean;
    /** The place chosen for its folder (settings.ts downloadPlaces): one of the paths ComfyUI lists for it. */
    place?: string;
    /** The file's sha256 as its source lists it: the node pack checks the file against it before naming it. */
    sha256?: string;
    /** What it was asked with through the page (fetchFile.ts), kept to ask it again: a restart while it waits, a Try again. */
    ask?: unknown;
  }): Promise<DownloadView> {
    // the same file to the same ComfyUI once at a time, from the first word: the look at the list in startNow() comes before
    // several awaits (ComfyUI's folders, the pack's version, the disk), and two starts at once (a double click, two tabs,
    // the command bar's several at once, a resume beside a click) both passed it and wrote the one .part together. The
    // second is given the first's answer instead.
    const key = `${comfy.client.baseUrl}|${want.folder}|${want.file}`;
    const under = this.starting.get(key);
    if (under) return under;
    const begun = this.startNow(comfy, self, want).finally(() => this.starting.delete(key));
    this.starting.set(key, begun);
    return begun;
  }

  /** The starts under way, by ComfyUI, folder and file (start()). */
  private readonly starting = new Map<string, Promise<DownloadView>>();

  private async startNow(comfy: Comfy, self: string, want: Parameters<Downloads["start"]>[2]): Promise<DownloadView> {
    const name = want.file.split(/[\\/]/).pop() ?? "";
    const sub = want.file.split(/[\\/]/).slice(0, -1).filter(Boolean).join("/");
    if (!isModelFile(name) || want.file.split(/[\\/]/).some((p) => BAD_NAME.test(p))) throw httpError(`"${name}" is not a model file Afflatus can download.`);
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(want.folder) || /\.\./.test(`${want.folder}/${sub}`) || NOT_MODELS.has(want.folder.split("/")[0]!)) throw httpError("that is not a models folder");
    // the source has to be out on the internet, ComfyUI's machine included: the server can reach what a browser on this
    // network cannot (outbound.ts). A pretend Civitai (the tests, the demo) is the one exception, by its host and port
    assertPublicUrl(want.source, civitaiSites());
    // the same file to the same ComfyUI once at a time; to another machine it is another download
    const busy = [...this.all.values()].find((d) => d.file === want.file && d.folder === want.folder && d.comfy === comfy && (running(d) || d.status === "saving"));
    if (busy) return this.view(busy);

    const headers = want.headers ?? {};
    // a rented GPU is sent its files by its node pack alone (directOnly), whatever folders it says: a pod answering on this
    // machine (the demo's pretend ones, a proxy) took the "Afflatus writes it here" route, which it then refused
    const paths = await comfyFolderPaths(comfy.client);
    const root = want.directOnly ? null : await modelRoot(paths, want.folder, comfy.client.baseUrl, want.comfyDir ?? "", want.place);
    const route = chooseRoute({ root, pack: !root && (await this.packCan(comfy)), source: want.source, headers, total: want.total ?? 0 });
    const base = comfyBase(paths, want.comfyDir ?? "");
    const d: Download = {
      id: randomUUID(), token: randomBytes(24).toString("hex"), comfy, source: want.source, headers, order: this.nextOrder++,
      file: want.file, folder: want.folder, title: want.title, bytes: 0, total: want.total ?? 0, status: "starting", abort: new AbortController(), via: route.via,
      ...(want.machine ? { machine: want.machine } : {}),
      ...(want.ask !== undefined ? { ask: want.ask, from: self } : {}),
      ...(want.place && route.via === "pack" ? { place: want.place } : {}),
      ...(want.sha256 && /^[0-9a-f]{64}$/i.test(want.sha256) && route.via === "pack" ? { sha256: want.sha256.toLowerCase() } : {}),
      ...(base ? { base } : {}),
      ...(want.directOnly ? { directOnly: true } : {}),
      ...(want.noSelf ? { noSelf: true } : {}),
      ...(want.quietPassing ? { quietPassing: true } : {}),
      ...(want.filesRead ? { filesRead: true as const } : {}),
    };
    // a machine that cannot reach Afflatus takes its files from the node pack only, and from the source's own link
    if (want.directOnly && route.via !== "pack") throw httpError("A rented GPU gets its files through the Afflatus node pack (0.12.0 or later), which this one does not answer with.");
    // Manager handed the one-time address, which its machine cannot reach: refused before it is asked
    if (want.noSelf && route.via === "manager" && !route.direct) throw httpError(NO_SELF);
    if (route.via === "afflatus") {
      try {
        const dest = await placeIn(route.root, sub, name);
        if (await stat(dest).then(() => true, () => false)) throw new Refused(`${name} is in ${dirname(dest)} already.`);
        // refused before anything is fetched when the size is known (Civitai says it); else once the site says it
        if (want.total) await assertRoom(dirname(dest), want.total, this.free);
        d.dest = dest;
        d.into = dirname(dest);
        d.shown = shownPlace(d.into, d.base ?? null);
      } catch (err) {
        throw err instanceof Refused ? httpError(err.message) : err;
      }
    }
    if (route.via === "pack") d.self = self;
    this.all.set(d.id, d);
    if (route.via === "manager") await this.runManager(d, route, sub, name, self);
    else this.pump();
    this.tell(true);
    return this.view(d);
  }

  /**
   * ComfyUI-Manager is handed the download: the one-time address, or a public Hugging Face address it reads itself;
   * then watched until it comes for the bytes. A refusal fails the download here.
   */
  private async runManager(d: Download, route: Extract<Route, { via: "manager" }>, sub: string, name: string, self: string): Promise<void> {
    const comfy = d.comfy;
    if (route.note) d.note = route.note;
    const post = (path: string, body: unknown) =>
      comfy.client.raw(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const type = MANAGER_TYPE[d.folder];
    try {
      const res = await post("/v2/manager/queue/install_model", {
        client_id: "afflatus", ui_id: d.id, name: d.title, type: type ?? "etc", base: "",
        // always a path under ComfyUI's models folder, as the page says it: "default" is the first path ComfyUI lists for the
        // kind, its older name (models/unet) or another app's folder from extra_model_paths.yaml (card #59)
        save_path: [d.folder, sub].filter(Boolean).join("/"),
        url: route.direct ?? this.oneTime(self, d),
        filename: name,
      });
      if (res.status === 404) throw new Error("This ComfyUI has no ComfyUI-Manager, which does the downloading here. Install the custom node, then try again.");
      if (!res.ok) throw new Error(`ComfyUI-Manager refused the download (${res.status}: ${(await res.text()).slice(0, 160)})`);
      await post("/v2/manager/queue/start", {});
    } catch (err) {
      this.fail(d, unreachable(err) ? "ComfyUI is not answering." : (err as Error).message);
      return;
    }
    if (route.direct) {
      // Manager reads it from Hugging Face itself: nothing passes through here to count, so the folder is watched until the file is in it
      d.direct = true;
      d.status = "downloading";
      void this.untilListed(d, 12 * 60 * 60_000);
      return;
    }
    // Manager checks what it is allowed to do before it fetches: when it never comes, say why. But it
    // fetches one file at a time: behind another download (ours, or any task of its queue) the fetch
    // comes later, and the download waits its turn instead of being given up on
    const watch = async () => {
      if (d.status !== "starting") return;
      const other = [...this.all.values()].find((o) => o !== d && o.via === "manager" && (o.status === "downloading" || o.status === "saving"));
      let queued = false;
      if (!other) {
        try {
          const res = await comfy.client.raw("/v2/manager/queue/status", { signal: AbortSignal.timeout(5_000) });
          const q = res.ok ? ((await res.json()) as { in_progress_count?: number; pending_count?: number }) : null;
          // a task under way that is not ours (ours would be fetching already), or more than ours pending
          queued = Boolean(q && ((q.in_progress_count ?? 0) > 0 || (q.pending_count ?? 0) > 1));
        } catch {
          queued = false;
        }
      }
      if (other || queued) {
        d.waiting = other ? `behind ${other.file}` : "behind another task of ComfyUI-Manager";
        this.tell(true);
        setTimeout(() => void watch(), this.startsWithinMs).unref();
        return;
      }
      this.fail(d, "ComfyUI-Manager did not start the download. Either it is not allowed to (in its config.ini, set network_mode = personal_cloud or security_level = normal, then restart ComfyUI), or ComfyUI cannot reach Afflatus at the address it was given.");
    };
    setTimeout(() => void watch(), this.startsWithinMs).unref();
  }

  /** The one-time address a download's bytes are fetched from by ComfyUI (the pack, or Manager). */
  private oneTime(self: string, d: Download): string {
    return `${self.replace(/\/+$/, "")}/api/downloads/fetch/${d.id}?t=${d.token}`;
  }

  /**
   * Start what waits, AT_ONCE of Afflatus's own downloads and the pack's at a time on each ComfyUI, in the order they
   * were asked for unless one was moved (move()); the others say what they wait behind, and each its place in the line
   * (`turn`). Each machine has its own line: a rented pod's files do not wait behind this computer's.
   */
  private pump(): void {
    const ours = [...this.all.values()].filter((d) => d.via !== "manager");
    let changed = false;
    for (const d of ours.filter((o) => !o.begun && o.status === "starting").sort((a, b) => a.order - b.order)) {
      const under = ours.filter((o) => o.comfy === d.comfy && o.begun && running(o));
      if (under.length < AT_ONCE) {
        d.begun = true;
        delete d.waiting;
        under.push(d);
        void (d.via === "pack" ? this.runPack(d) : this.runHere(d));
        changed = true;
        continue;
      }
      const behind = `behind ${under.map((o) => o.file).join(" and ")}`;
      if (d.waiting !== behind) changed = true;
      d.waiting = behind;
    }
    // each one's place in its machine's line: those under way first (in the order they began), then the waiting ones
    for (const comfy of new Set(ours.map((o) => o.comfy))) {
      const line = ours.filter((o) => o.comfy === comfy && running(o)).sort((a, b) => Number(Boolean(b.begun)) - Number(Boolean(a.begun)) || a.order - b.order);
      line.forEach((o, i) => {
        if (o.turn !== i + 1) changed = true;
        o.turn = i + 1;
      });
    }
    if (changed) this.tell(true);
  }

  /** The waiting ones of the same machine as `d`, in their order. */
  private lineOf(d: Download): Download[] {
    return [...this.all.values()].filter((o) => o.comfy === d.comfy && o.via !== "manager" && o.status === "starting" && !o.begun).sort((a, b) => a.order - b.order);
  }

  /**
   * A waiting download moved in its machine's line: before `before` (another waiting one of that machine), or to the end
   * when it is null. Its place is kept in the state file, so a restart keeps the line as it was left. False when either is
   * not waiting (under way already, done, gone, or on another machine).
   */
  move(id: string, before: string | null): boolean {
    const d = this.all.get(id);
    if (!d || d.via === "manager" || d.status !== "starting" || d.begun) return false;
    const line = this.lineOf(d).filter((o) => o !== d);
    const at = before === null ? line.length : line.findIndex((o) => o.id === before);
    if (at < 0) return false;
    line.splice(at, 0, d);
    // the orders the line had, given out again in its new order: the others keep their place relative to each other
    const orders = [...line.map((o) => o.order)].sort((a, b) => a - b);
    line.forEach((o, i) => (o.order = orders[i]!));
    this.pump();
    this.tell(true);
    return true;
  }

  /** Every download still waiting its turn taken out of the line (those `mine` takes: one machine's, or all): how many went. */
  cancelWaiting(mine: (d: DownloadView) => boolean = () => true): number {
    const waiting = [...this.all.values()].filter((d) => d.status === "starting" && !d.begun && d.via !== "manager" && mine(d));
    for (const d of waiting) this.stop(d.id);
    return waiting.length;
  }

  /** The finished ones taken off the list (on one machine, as cancelWaiting): what was done, and what failed or was stopped. */
  clearDone(mine: (d: DownloadView) => boolean = () => true): number {
    const ended = (d: DownloadView) => d.status === "done" || d.status === "error" || d.status === "stopped";
    const gone = [...this.all.values()].filter((d) => ended(d) && mine(d));
    for (const d of gone) this.all.delete(d.id);
    const was = this.past.length;
    this.past = this.past.filter((k) => !(ended(k) && mine(k)));
    const count = gone.length + was - this.past.length;
    if (count) this.tell(true);
    return count;
  }

  /** What a download was asked with through the page, and from where: to ask it again as it was (Try again). */
  askOf(id: string): { ask: unknown; from: string } | null {
    const d = this.all.get(id) ?? this.past.find((k) => k.id === id);
    return d && d.ask !== undefined && d.from ? { ask: d.ask, from: d.from } : null;
  }

  /**
   * The downloads still waiting their turn when Afflatus last stopped, asked again in their order with `again` (fetchFile.ts
   * beginDownload, from the API's registration). One that cannot be asked again (ComfyUI not answering, the file there
   * meanwhile) is listed failed with why, and keeps what it was asked with for its Try again.
   */
  async resume(again: (ask: unknown, from: string) => Promise<unknown>): Promise<void> {
    await this.restored;
    // each taken off only once it was asked again: the state file keeps those not asked yet (persist()), so that a second
    // restart while the first ones are asked (each a call to ComfyUI) does not lose the rest of the line
    while (this.toResume.length) {
      const k = this.toResume[0]!;
      try {
        await again(k.ask, k.from!);
      } catch (err) {
        const { part: _p, queued: _q, order: _o, ...rest } = k;
        this.past.push({ ...rest, status: "error", error: `Not asked again after the restart: ${(err as Error).message}`, finishedAt: Date.now() });
      } finally {
        this.toResume.shift();
      }
    }
    this.tell(true);
  }

  /** Afflatus downloads it itself, into the folder ComfyUI reads (modelDownload.ts). */
  private async runHere(d: Download): Promise<void> {
    d.status = "downloading";
    this.tell(true);
    try {
      await fetchToFile({
        source: d.source, headers: d.headers, allow: civitaiSites(), dest: d.dest!, signal: d.abort.signal,
        attempts: this.attempts, backoffMs: this.backoffMs, free: this.free,
        onBytes: (bytes, total) => {
          d.bytes = bytes;
          if (total) d.total = total;
          // flowing again after a cut: the note says it was picked up, no longer that it is being tried
          if (d.cuts && d.resumedFrom !== undefined && bytes > d.resumedFrom) {
            d.note = `Picked up again after ${d.cuts === 1 ? "a cut" : `${d.cuts} cuts`}.`;
            d.resumedFrom = undefined;
            this.tell(true);
          }
          this.tell();
        },
        onRetry: (note) => {
          d.cuts = (d.cuts ?? 0) + 1;
          d.resumedFrom = d.bytes;
          d.note = note;
          this.tell(true);
        },
      });
      // a stop that came once the file was whole and named (fetchToFile had put it in its place) stopped nothing: the file is
      // there, and saying "stopped, nothing is kept" left a file the list said was not. It is said done when ComfyUI lists it
      if (d.abort.signal.aborted) {
        d.status = "saving";
        delete d.finishedAt;
        this.tell(true);
        void this.untilListed(d);
        return;
      }
      // whole, and named: ComfyUI lists it once it looks at the folder again
      d.status = "saving";
      this.tell(true);
      void this.untilListed(d);
    } catch (err) {
      // stopped: said so already, and the .part is gone
      if (d.abort.signal.aborted) return;
      this.fail(d, err instanceof Refused ? err.message : `The download did not finish: ${(err as Error).message}`, err instanceof Refused);
    } finally {
      this.pump();
    }
  }

  /** The node pack downloads it, from the source's own signed link when there is one, else from the one-time address; it is asked how it goes until it is done. */
  private async runPack(d: Download): Promise<void> {
    try {
      const version = await d.comfy.client.packVersion().catch(() => null);
      const signed = version && !olderThan(version, PACK_SIGNED) ? await this.signer(d.source, d.headers).catch((err: unknown) => {
        // the source refused it (paid, a key refused): said as it is, not as "no link of its own"
        if (err instanceof Refused) throw err;
        return null;
      }) : null;
      d.signed = Boolean(signed);
      if (!signed && d.directOnly) throw new Error(NO_DIRECT);
      if (!signed && d.noSelf) throw new Error(NO_SELF);
      // the place chosen for the folder, to a pack that takes one (an older one keeps to ComfyUI's first path)
      const dir = d.place && version && !olderThan(version, PACK_PLACE) ? { dir: d.place } : {};
      const body = JSON.stringify({ url: signed ?? this.oneTime(d.self!, d), folder: d.folder, filename: d.file.replace(/\\/g, "/"), total: d.total, ...dir, ...(d.sha256 ? { sha256: d.sha256 } : {}) });
      const ask = () => d.comfy.client.raw("/afflatus/download", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000), body });
      let res = await ask();
      // its line full (429: the pack takes so many at once): one just stopped there may not have heard its stop yet. Waited
      // for, as a download waiting its turn, never a failure: a pod getting its files asked for more than its line once gave a
      // red banner per file, though each came
      const busySince = Date.now();
      while (res.status === 429 && running(d) && Date.now() - busySince < this.packBusyMs) {
        await res.body?.cancel().catch(() => {});
        d.waiting = "the node pack's downloads at once are under way: waiting for one to end";
        this.tell();
        await new Promise((r) => setTimeout(r, this.packBusyEveryMs));
        if (!running(d)) return;
        res = await ask();
      }
      delete d.waiting;
      if (!res.ok) throw new Error(`The Afflatus node pack refused the download (${res.status}: ${(await res.text()).slice(0, 200)})`);
      const got = (await res.json()) as { id: string; path?: string; root?: string };
      d.packId = got.id;
      if (got.path) d.into = got.path.replace(/[\\/][^\\/]*$/, "");
      // the model folder it goes in (0.36.9 says it; an older pack, the file's own folder)
      if (got.root || d.into) d.shown = shownPlace(got.root ?? d.into!, d.base ?? null);
      // from the source's own link nothing passes through Afflatus (serve() says "downloading" for the one-time address)
      if (d.signed && d.status === "starting") d.status = "downloading";
      if (!running(d)) {
        void d.comfy.client.raw(`/afflatus/download/${encodeURIComponent(got.id)}`, { method: "DELETE" }).catch(() => {});
        return;
      }
      this.tell(true);
      let silent = 0;
      while (running(d)) {
        await new Promise((r) => setTimeout(r, this.packEveryMs));
        if (!running(d)) return;
        const asked = await d.comfy.client.raw(`/afflatus/download/${encodeURIComponent(got.id)}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (asked?.status === 404) throw new Error("ComfyUI no longer knows the download: was it restarted? Press Download again.");
        // an answer that says nothing (a 5xx, a page instead of the state, a body cut short) counts as no answer: two
        // minutes of them and the download is given up, never left "downloading" for good
        const s = asked?.ok ? ((await asked.json().catch(() => null)) as { state?: string; bytes?: number; error?: string; note?: string; expired?: boolean } | null) : null;
        if (!s || typeof s !== "object") {
          await asked?.body?.cancel().catch(() => {});
          if (++silent * this.packEveryMs > this.packSilentMs) throw new Error(asked ? `The Afflatus node pack says nothing usable about the download (HTTP ${asked.status}): look at ComfyUI's own window.` : "ComfyUI is not answering.");
          continue;
        }
        silent = 0;
        if (s.note) d.note = s.note;
        // from the source's own link, no byte passes through Afflatus to count: the pack's count is the progress
        if (d.signed && typeof s.bytes === "number" && s.bytes > d.bytes) {
          d.bytes = s.bytes;
          this.tell();
        }
        // its signed link expired half way: a fresh one, asked for here with the key as the first was; the pack carries on
        if (s.expired && d.signed && Date.now() - (d.renewedAt ?? 0) > 10_000) {
          d.renewals = (d.renewals ?? 0) + 1;
          if (d.renewals > MAX_RENEWALS) throw new Error("The source kept refusing its own download links on ComfyUI's machine: press Download again.");
          d.renewedAt = Date.now();
          const fresh = await this.signer(d.source, d.headers).catch(() => null);
          if (fresh) await d.comfy.client.raw(`/afflatus/download/${encodeURIComponent(got.id)}/url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: fresh }), signal: AbortSignal.timeout(10_000) }).catch(() => null);
        }
        if (s.state === "error") throw new Error(`The Afflatus node pack could not download it: ${s.error ?? "no reason given"}`);
        if (s.state === "done") {
          d.bytes = s.bytes ?? d.bytes;
          d.total = s.bytes ?? d.total;
          delete d.note;
          d.upstream?.abort();
          d.status = "saving";
          this.tell(true);
          void this.untilListed(d);
          return;
        }
      }
    } catch (err) {
      d.upstream?.abort();
      this.fail(d, unreachable(err) ? "ComfyUI is not answering." : (err as Error).message, err instanceof Refused);
    } finally {
      this.pump();
    }
  }

  /**
   * The one-time address the pack or Manager fetches: the file streamed through, its bytes counted. Manager's
   * works once; the pack's as long as its download runs, and from where it asks (`range`, "bytes=<n>-"): the
   * source is asked for the same, and a source that does not resume sends the whole (the pack then starts over).
   * Null when the id and token do not match a download that is waiting.
   */
  async serve(id: string, token: string, range?: string): Promise<{ stream: Readable; size: number; partial?: string } | { error: string; status: number } | null> {
    const d = this.all.get(id);
    if (!d || !sameToken(token, d.token) || d.direct) return null;
    if (d.via === "pack" ? !running(d) || !d.begun : d.status !== "starting") return null;
    // one stream at a time: the pack asks again after a cut, and what may be left of the earlier one is let go
    d.upstream?.abort();
    const upstream = new AbortController();
    d.upstream = upstream;
    const from = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
    d.status = "downloading";
    delete d.waiting;
    this.tell(true);
    let res: Response;
    try {
      // each redirect judged as the source was (but never on to ComfyUI's machine), and the Civitai key kept for the host first asked
      res = await fetchPublic(d.source, { headers: { "User-Agent": "afflatus", Accept: "*/*", ...d.headers, ...(from ? { Range: `bytes=${from}-` } : {}) }, signal: AbortSignal.any([d.abort.signal, upstream.signal]) }, civitaiSites());
    } catch (err) {
      const said = `The download did not start: ${fetchFailure(err, d.source)}`;
      // the pack tries again on its own, unless trying again changes nothing (a redirect refused, a host that is not
      // there); Manager does not
      const final = d.via === "manager" || typeof (err as { statusCode?: unknown }).statusCode === "number" || cannotReach(err);
      if (final) this.fail(d, said);
      return { error: said, status: final ? 403 : 502 };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || /text\/html|application\/json/.test(type)) {
      const refused = res.status === 401 || res.status === 403 || /text\/html/.test(type);
      if (!refused) await res.body?.cancel().catch(() => {});
      const said = refused ? await refusalOf(res, d.source, d.headers) : `The site answered ${res.status}.`;
      // a 5xx or a 429 may pass, the pack asks again; anything else is the end of it, and the pack is told so with
      // the site's own 4xx (a 502 would have it try four times more)
      const final = d.via === "manager" || (res.status < 500 && res.status !== 429);
      if (final) this.fail(d, said);
      return { error: said, status: res.status >= 400 && res.status < 500 && res.status !== 429 ? res.status : refused ? 403 : final ? 422 : 502 };
    }
    const size = Number(res.headers.get("content-length")) || 0;
    const partial = from > 0 && res.status === 206 ? res.headers.get("content-range") ?? undefined : undefined;
    const whole = partial ? Number(/\/(\d+)$/.exec(partial)?.[1]) || 0 : size;
    if (whole) d.total = whole;
    if (d.via === "manager" && d.total > BIG) d.note = MANAGER_BIG;
    d.bytes = partial ? from : 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        d.bytes += chunk.length;
        this.tell();
        done(null, chunk);
      },
    });
    // pipe() does not pass an error on: a source that breaks (the site drops it, or it is stopped) ends what ComfyUI is reading
    const source = Readable.fromWeb(res.body as WebStream);
    source.on("error", (err) => counter.destroy(err));
    const stream = source.pipe(counter);
    // the reader gone (the pack cut off, Manager dropped it): its stream from the source goes too, not left open
    stream.on("close", () => upstream.abort());
    stream.on("error", (err) => {
      if (d.via === "manager") this.fail(d, `The download was interrupted: ${err.message}`);
    });
    stream.on("end", () => {
      // the pack says itself when it has all of it and has named the file
      if (d.status !== "downloading" || d.via !== "manager") return;
      // Manager writes the file once it has all of it: wait until ComfyUI lists it
      d.status = "saving";
      this.tell(true);
      void this.untilListed(d);
    });
    return { stream, size, partial };
  }

  /** The other end of the one-time address went away before the end. The pack asks again on its own; Manager does not. */
  dropped(id: string): void {
    const d = this.all.get(id);
    if (d?.status === "downloading" && d.via === "manager") this.fail(d, "ComfyUI-Manager dropped the connection.");
  }

  /** Until ComfyUI lists the file: `withinMs` (3 minutes at the usual pace) for one whole already, hours for one Manager reads itself. */
  private async untilListed(d: Download, withinMs = 60 * this.listedEveryMs): Promise<void> {
    const name = fileName(d.file);
    const every = d.direct ? Math.max(this.listedEveryMs, 5000) : this.listedEveryMs;
    for (let waited = 0; waited < withinMs; waited += every) {
      await new Promise((r) => setTimeout(r, every));
      if (d.status !== "saving" && d.status !== "downloading") return;
      // a .gguf one is in the GGUF pack's list only (filesIn): never in ComfyUI's own, it was never said done
      const files = await filesIn(d.comfy.client, d.folder).catch(() => [] as string[]);
      if (files.some((f) => fileName(f) === name)) {
        d.status = "done";
        d.finishedAt = Date.now();
        delete d.note;
        // what was worked out about its files no longer holds: it has one more (the pictures sent to it are still there)
        if (!d.filesRead) d.comfy.forgetFiles();
        this.tell(true);
        this.events.emit("models");
        this.events.emit("setup");
        return;
      }
    }
    this.fail(d, d.via === "afflatus"
      ? `The file is in ${d.into}, but ComfyUI does not list it. Refresh ComfyUI's model list, or restart ComfyUI.`
      : d.direct
        ? "ComfyUI-Manager has not saved the file. Look at ComfyUI's own window for what went wrong."
        : `All of it was sent, but ComfyUI does not list the file. Look at ComfyUI's own window for what went wrong${d.via === "manager" ? " (a full disk, or not enough memory to hold the file)" : ""}.`);
  }
}
