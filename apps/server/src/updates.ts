import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { z } from "zod";
import { environment, envSaid, VERSION } from "./config";
import { now } from "./db";
import { httpError } from "./errors";
import { fetchToFile, freeBytes, Refused, sizeText } from "./modelDownload";
import { assertPublicUrl, fetchFailure, fetchPublic } from "./outbound";
import { RELEASE_KEY } from "./releaseKey";
import type { Services } from "./services";
import { readSettings } from "./settings";

/**
 * Afflatus updating itself (HANDOVER-updater.md). Once a day, when the user leaves it on, GitHub is asked for the latest
 * release (one request, with the ETag of the last answer; nothing about the user is sent), and a newer one is noted for
 * the web (Settings → About). A release bundle (AFFLATUS_INSTALL=bundle, laid out as R/versions/<v>/ beside R/data/) can
 * take it in one click from the computer it runs on: the platform's archive, SHA256SUMS.txt and its Ed25519 signature
 * are downloaded into data/updates/, the signature checked with the key built into the app and the archive's SHA-256
 * with the signed list, the new version unpacked beside the running one and asked to start with --check; then, once the
 * queue has finished what it had (nothing new starts meanwhile), the database is copied to data/backups/before-<v>.db,
 * versions/current names the new version and the process exits with 75, which the launcher reads as "start me again".
 * Docker and a checkout get the notice alone: they are updated with their own commands.
 *
 * Also here: going back to the previous version (its database copy restored), the move of a 0.3 library into a fresh
 * 0.4 bundle beside it, and the note the launcher leaves when a new version did not start (data/updates/fallback.json).
 */

/** GitHub's answer for the latest release; UPDATES_URL stands in for it (the tests, a mirror). */
const GITHUB_LATEST = "https://api.github.com/repos/bardak971/afflatus/releases/latest";
/** How often GitHub is asked, at most: once a day. */
const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** The timer that sees whether a check is due; the check itself is once a day. */
const TICK_MS = 60 * 60_000;
/** The first look after the start: not during it. */
const FIRST_TICK_MS = 30_000;
/** Progress goes out at most four times a second. */
const PROGRESS_EVERY_MS = 250;
/** The settings row the last check is kept in, between restarts (a key the settings schema ignores, like the queue's). */
const CHECK_KEY = "updates.afflatus";
/** The exit code that asks the launcher to start Afflatus again (after an update, Go back or the move). */
export const RESTART_CODE = 75;
/** A 0.3 bundle's folder, as its archive unpacked: afflatus-v0.3.0-win-x64, afflatus-0.3.1. */
const OLD_BUNDLE = /^afflatus-v?(0\.3\.\d+)(?:-[\w.]+)*$/i;

export type InstallKind = "bundle" | "docker" | "sources";

// ---------------------------------------------------------------- versions

interface Parsed { core: [number, number, number]; pre: string[] }

/** A version as releases name it (v1.2.3, 1.2.3-rc.1); null for anything else ("dev"). */
export function parseVersion(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
}

/** A version without its tag's "v": the name of its folder under versions/ and what is said. */
export const bareVersion = (v: string) => v.trim().replace(/^v(?=\d)/, "");

/**
 * A version's name as versions/ holds it ("0.4.1", "0.4.0-rc.2"), or null for anything else. The names read from
 * versions/current and previous, and from the launcher's notes, are joined into paths that are started, written or
 * removed: one that could reach out of versions/ ("../x", "..", or "..." which Windows reads as "..") is never taken.
 */
export function versionName(name: unknown): string | null {
  if (typeof name !== "string" || !/^[\w.+-]+$/.test(name) || name.startsWith(".") || name.endsWith(".")) return null;
  return name;
}

/** Semver order: 1 when `a` comes after `b`, -1 before, 0 the same; null when either is not a version. A prerelease comes before its release. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]! ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) > Number(q) ? 1 : -1;
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

const isPrerelease = (v: string) => Boolean(parseVersion(v)?.pre.length);

/** The version a checkout's code is (the root package.json), for "dev": a release is news only when it is newer than that. */
function codeVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && parseVersion(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the release

const releaseJson = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  html_url: z.string().nullish(),
  published_at: z.string().nullish(),
  prerelease: z.boolean().nullish(),
  draft: z.boolean().nullish(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), size: z.number().nullish() })).nullish(),
});

export interface Release {
  /** Without the tag's "v": "0.4.2". */
  version: string;
  tag: string;
  name: string;
  /** The release's notes as written (Markdown), cut at 20 000 characters. */
  notes: string;
  /** Its first list lines, for the card: "- Faster joins" as "Faster joins". */
  highlights: string[];
  /** The release's page on GitHub. */
  url: string;
  publishedAt: string | null;
  prerelease: boolean;
  /** The text of a "Security: …" line in the notes: the release fixes a security issue, and the web says so once. */
  security: string | null;
  assets: Array<{ name: string; url: string; size: number }>;
}

/** GitHub's release, as kept and shown; null for what is not one (a draft, an answer of another shape). */
export function readRelease(raw: unknown): Release | null {
  const r = releaseJson.safeParse(raw);
  if (!r.success || r.data.draft || !parseVersion(r.data.tag_name)) return null;
  const notes = (r.data.body ?? "").replace(/\r\n/g, "\n").slice(0, 20_000);
  const highlights = notes.split("\n").map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1]?.trim()).filter((l): l is string => Boolean(l)).slice(0, 5);
  const version = bareVersion(r.data.tag_name);
  return {
    version, tag: r.data.tag_name, name: r.data.name?.trim() || `Afflatus ${version}`, notes, highlights,
    url: r.data.html_url ?? "", publishedAt: r.data.published_at ?? null,
    prerelease: Boolean(r.data.prerelease) || isPrerelease(version),
    security: /^[ \t>*_]*Security:[*_]*[ \t]*(.+)$/im.exec(notes)?.[1]?.replace(/[*_]+$/, "").trim() || null,
    assets: (r.data.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size ?? 0 })),
  };
}

/** The release bundle's platform name for this computer, as the archives are named (scripts/release/bundle.mjs). */
export function platformName(platform = process.platform): string {
  return platform === "win32" ? "win-x64" : platform === "darwin" ? "darwin-arm64" : "linux-x64";
}

/** A release as the web reads it: the archives' addresses are the server's business. */
const withoutAssets = ({ assets: _assets, ...rest }: Release): Omit<Release, "assets"> => rest;

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The archive of a release for a platform: afflatus-<v>-<platform>.zip or .tar.gz (the tag's "v" or not). */
export const assetFor = (r: Release, platform: string) =>
  r.assets.find((a) => new RegExp(`^afflatus-v?${escaped(r.version)}-${escaped(platform)}\\.(zip|tar\\.gz)$`, "i").test(a.name));

// ---------------------------------------------------------------- the signature

/**
 * Whether `signature` (base64, as SHA256SUMS.txt.sig holds it) is the Ed25519 signature of these exact bytes by the key
 * (raw 32 bytes, base64: releaseKey.ts). A key or a signature that cannot be read verifies nothing.
 */
export function verifySignature(data: Buffer, signature: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey.trim(), "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    const sig = Buffer.from(signature.trim(), "base64");
    return sig.length === 64 && verify(null, data, key, sig);
  } catch {
    return false;
  }
}

/** SHA256SUMS.txt read: file name → SHA-256 (lower case), as `sha256sum` writes it ("<hash>  <name>", or "*<name>" in binary mode). */
export function readSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return sums;
}

function sha256Of(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (d) => hash.update(d)).on("end", () => done(hash.digest("hex"))).on("error", fail);
  });
}

// ---------------------------------------------------------------- unpacking and running

/**
 * The tar that unpacks the archive: Windows' own (bsdtar, in System32 from Windows 10 on, which reads zip too) before a
 * `tar` on the PATH, which on Windows is often Git's GNU tar: it reads no zip and takes "C:" for a remote host.
 */
export function systemTar(): string {
  if (process.platform === "win32") {
    const own = join(envSaid.systemRoot() ?? "C:\\Windows", "System32", "tar.exe");
    if (existsSync(own)) return own;
  }
  return "tar";
}

/** A program run to its end: its exit code (null when it could not be run or was stopped) and the end of what it said. */
function runProgram(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; said: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, signal: opts.signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const said = `${stderr}\n${stdout}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null) : 0;
      done({ code, said: said || (err && code === null ? err.message : "") });
    });
  });
}

/** A file's text, trimmed; null when it is not there. */
const readLine = (path: string) => readFile(path, "utf8").then((t) => t.trim() || null, () => null);
/** A version named in a file under versions/ (current, previous, trial); null when there is none, or the name is not one. */
const readVersion = async (path: string) => versionName(await readLine(path));

/**
 * The node of an installed version, as the launchers run it: node/node.exe on Windows, node/bin/node elsewhere (the
 * layout of nodejs.org's archives), else node/node.exe as afflatus.sh falls back to.
 */
export function nodeIn(versionDir: string, platform: string): string {
  const exe = join(versionDir, "node", "node.exe");
  if (platform.startsWith("win")) return exe;
  const bin = join(versionDir, "node", "bin", "node");
  return existsSync(bin) || !existsSync(exe) ? bin : exe;
}

/**
 * A small file written whole or not at all (versions/current, data/updates/last.json and the like): a temporary file,
 * flushed to the disk, then renamed over the old one. A disk that fills up halfway leaves the old file as it was, never an
 * empty one; and whoever reads it meanwhile (the next start, the launcher, the page) finds the old file or the new, never
 * one still being written, which a slow or busy disk makes easy to catch.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const file = await open(tmp, "w");
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await renameSoon(tmp, path);
}

/** A rename tried again for a few seconds: on Windows a folder whose files were just closed can stay locked a moment. */
async function renameSoon(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 20 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * A copy of the library put in place of its database (Go back): the copy written beside it under a temporary name and
 * flushed first, then the database set aside (its -wal with it, which must not be replayed into the copy), then the copy
 * renamed in. A stop at any point leaves one database or the other in place: never none, which a start would take for
 * an empty library.
 */
export async function restoreDatabase(db: string, copy: string, aside: string): Promise<void> {
  const tmp = `${db}.tmp`;
  await copyFile(copy, tmp);
  const file = await open(tmp, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  if (existsSync(`${db}-wal`)) await renameSoon(`${db}-wal`, `${aside}-wal`);
  await rm(`${db}-shm`, { force: true });
  if (existsSync(db)) await renameSoon(db, aside);
  await renameSoon(tmp, db);
}

/** The size of the files under a folder, its subfolders included; links are not followed (a linked folder is not the library's). */
async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(path);
    else if (e.isFile()) total += await stat(path).then((s) => s.size, () => 0);
  }
  return total;
}

/**
 * What a library (a data folder) holds: its items (not in the bin), timelines and drafts, counted in its database opened
 * read-only, and the size of its files folder. A database that cannot be read (another program holds it, a version whose
 * tables are named otherwise) gives no counts, only the size: the move is still offered, the dialog says less.
 */
export async function librarySummary(dataDir: string): Promise<LibrarySummary> {
  const counts: Pick<LibrarySummary, "items" | "timelines" | "drafts"> = { items: null, timelines: null, drafts: null };
  try {
    const db = new DatabaseSync(join(dataDir, "afflatus.db"), { readOnly: true });
    try {
      const count = (query: string) => {
        try {
          return Number((db.prepare(query).get() as { n: number | bigint } | undefined)?.n ?? 0);
        } catch {
          return null;
        }
      };
      counts.items = count("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL");
      counts.timelines = count("SELECT COUNT(*) AS n FROM timelines");
      counts.drafts = count("SELECT COUNT(*) AS n FROM drafts");
    } finally {
      db.close();
    }
  } catch {
    // not a database this can open: the counts stay unknown
  }
  return { ...counts, bytes: await folderBytes(join(dataDir, "files")) };
}

// ---------------------------------------------------------------- what the web reads

/** Where an update stands. `failed` keeps the error until it is tried again or another check comes. */
export type UpdatePhase = "downloading" | "verifying" | "unpacking" | "starting" | "waiting" | "switching" | "restarting" | "failed";

export interface UpdateFlow {
  phase: UpdatePhase;
  /** The version being installed. */
  version: string;
  /** Downloaded so far, of the archive's size (both 0 until it is known). */
  bytes: number;
  total: number;
  /** While waiting: the jobs still to finish before the switch. */
  left: number;
  /** Why it did not go through (phase "failed"), said for the user; the running version is untouched. */
  error: string | null;
}

/** What the launcher wrote when a new version exited before it was up, and it started the previous one again. */
export interface Fallback { version: string; previous: string; at: string; code: number | null }

/** The last update, Go back or move done here (data/updates/last.json), for "Updated today" and the like. */
export interface LastChange { kind: "updated" | "went-back" | "moved" | "failed"; from: string; to: string; at: string; error?: string }

export interface UpdatesView {
  /** The version running, as the build names it ("0.4.1", "dev"). */
  version: string;
  install: InstallKind;
  /** The switch in Settings → About (settings.afflatusUpdateChecks). */
  checks: boolean;
  /** The last check that got an answer; null before the first. */
  checkedAt: string | null;
  /** Why the last check got no answer; null when it did. */
  checkError: string | null;
  /** The latest release GitHub gave (notes and all), whether or not it is newer. */
  latest: Omit<Release, "assets"> | null;
  /** The latest release is newer than what runs (for "dev": than the checkout's package.json); a prerelease only for a prerelease. */
  newer: boolean;
  /** This request comes from the computer Afflatus runs on: Update, Go back and the move are offered only there. */
  here: boolean;
  /** Update can be pressed now (a bundle, here, a newer release with an archive for this platform, nothing under way). */
  canUpdate: boolean;
  /** Why not, when a newer release cannot be taken in one click (null otherwise). */
  cannot: string | null;
  /** An update under way, or the last one that failed; null when there is none. */
  flow: UpdateFlow | null;
  /** The version before the last update, still installed: Go back returns to it. `restoresLibrary`: the database copy taken at the update is there. */
  previous: { version: string; restoresLibrary: boolean } | null;
  last: LastChange | null;
  /** The launcher went back to the previous version because the new one did not start (read once, at this start). */
  fallback: Fallback | null;
  /** A 0.3 library beside this fresh bundle, which the move would bring in: its data folder, its version and what it holds. */
  move: (OldLibrary & LibrarySummary) | null;
}

/** A 0.3 bundle's library found beside this one: its data folder and its version. */
interface OldLibrary { from: string; version: string }

/** What a library holds, for the move's dialog: its counts (null when its database could not be read) and its files' size. */
export interface LibrarySummary { items: number | null; timelines: number | null; drafts: number | null; bytes: number }

/** Kept between restarts: the last answer and its ETag. */
interface CheckState { etag: string | null; checkedAt: string | null; triedAt: string | null; error: string | null; release: Release | null }

export interface UpdatesOptions {
  services: Services;
  dataDir: string;
  /**
   * Close everything, run `between` (with the database closed: a file swapped, a folder renamed), and exit with 75 for the
   * launcher to start Afflatus again (start.ts).
   */
  restart(between?: () => Promise<void>): Promise<void>;
  // the rest are for the tests: each defaults to the environment and this computer
  /** The public key releases are checked with (releaseKey.ts). */
  key?: string;
  version?: string;
  install?: InstallKind;
  /** The bundle's root R (AFFLATUS_ROOT). */
  root?: string | null;
  /** AFFLATUS_STARTED_FILE: R/versions/<v>/.started, which also names the version folder this is. */
  startedFile?: string | null;
  platform?: string;
  free?: (dir: string) => Promise<number>;
  /** The node of an installed version (nodeIn: node/node.exe, node/bin/node). */
  nodeOf?: (versionDir: string) => string;
  /** How often the wait for the queue looks again. */
  waitPollMs?: number;
  /** The first wait before a download tries again. */
  backoffMs?: number;
  /** Whether the daily check runs by itself (off in the tests). */
  timers?: boolean;
}

export class AfflatusUpdates {
  readonly version: string;
  readonly install: InstallKind;
  private readonly root: string | null;
  private readonly key: string;
  private readonly platform: string;
  private state: CheckState = { etag: null, checkedAt: null, triedAt: null, error: null, release: null };
  private flow: UpdateFlow | null = null;
  private abort: AbortController | null = null;
  private work: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  /** The folder under versions/ this process runs from, when it is a bundle. */
  private running: string | null = null;
  private fallback: Fallback | null = null;
  /** A version that did not start here (the launcher went back from it): not offered again; the next release is. */
  private failed: string | null = null;
  private last: LastChange | null = null;
  private moveFrom: OldLibrary | null = null;
  /** What the 0.3 library holds, read once (a walk of its files folder) on the first view that offers the move. */
  private moveSummary: Promise<LibrarySummary> | null = null;
  /** The library had something in it once: the move is never offered again in this run. */
  private filled = false;
  private timers: NodeJS.Timeout[] = [];
  private lastProgress = 0;
  private goingAway = false;
  /** The update presses, counted: the run that owns the flow is the last one, and only it lets go of the queue's hold. */
  private runs = 0;

  constructor(private readonly o: UpdatesOptions) {
    this.version = o.version ?? VERSION;
    const said = o.install ?? envSaid.install()?.trim();
    this.install = said === "bundle" || said === "docker" ? said : "sources";
    const root = o.root !== undefined ? o.root : envSaid.root()?.trim() || null;
    this.root = root ? resolve(root) : null;
    this.key = o.key ?? RELEASE_KEY;
    this.platform = o.platform ?? platformName();
  }

  private get db() {
    return this.o.services.db;
  }
  private get updatesDir() {
    return join(this.o.dataDir, "updates");
  }
  private get versionsDir() {
    return this.root ? join(this.root, "versions") : null;
  }

  /** Read what the last run left (the last check, the launcher's note, the last change) and look for a 0.3 library. */
  async init(): Promise<void> {
    const row = await this.db.selectFrom("settings").select("value").where("key", "=", CHECK_KEY).executeTakeFirst().catch(() => undefined);
    if (row) {
      try {
        const kept = JSON.parse(row.value) as Partial<CheckState>;
        this.state = { etag: kept.etag ?? null, checkedAt: kept.checkedAt ?? null, triedAt: kept.triedAt ?? null, error: kept.error ?? null, release: kept.release ? readRelease(kept.release) ?? kept.release : null };
      } catch {
        // a row that does not read is asked for again at the next check
      }
    }
    if (this.install === "bundle" && this.versionsDir) {
      const started = this.o.startedFile !== undefined ? this.o.startedFile : envSaid.startedFile()?.trim() || null;
      this.running = started ? versionName(basename(dirname(started))) : await readVersion(join(this.versionsDir, "current"));
    }
    // the launcher's note is said once: read and taken away, so that the next start does not say it again
    const fallbackFile = join(this.updatesDir, "fallback.json");
    const fell = await readFile(fallbackFile, "utf8").then((t) => JSON.parse(t) as Partial<Fallback>, () => null);
    const fellFrom = versionName(fell?.version);
    const fellTo = versionName(fell?.previous);
    if (fell && fellFrom && fellTo) {
      this.fallback = { version: fellFrom, previous: fellTo, at: typeof fell.at === "string" ? fell.at : now(), code: typeof fell.code === "number" ? fell.code : null };
      console.warn(`[updates] ${fellFrom} did not start; back on ${fellTo}`);
      // remembered past this start, and its folder taken away: it is not offered again, and nothing starts it by mistake
      await writeAtomic(join(this.updatesDir, "failed.json"), JSON.stringify({ version: bareVersion(fellFrom) })).catch(() => {});
      if (this.versionsDir && fellFrom !== this.running) await rm(join(this.versionsDir, fellFrom), { recursive: true, force: true }).catch(() => {});
    }
    await rm(fallbackFile, { force: true }).catch(() => {});
    this.failed = await readFile(join(this.updatesDir, "failed.json"), "utf8").then((t) => versionName((JSON.parse(t) as { version?: unknown }).version), () => null);
    this.last = await readFile(join(this.updatesDir, "last.json"), "utf8").then((t) => JSON.parse(t) as LastChange, () => null);
    this.moveFrom = await this.findOldLibrary().catch(() => null);
    if (this.o.timers !== false) {
      const tick = () => void this.daily().catch((err) => console.warn("[updates]", (err as Error).message));
      const first = setTimeout(tick, FIRST_TICK_MS);
      const every = setInterval(tick, TICK_MS);
      first.unref();
      every.unref();
      this.timers.push(first, every);
    }
  }

  /**
   * The server listens: this version has started once, so versions/trial (written at the switch to it) goes, and from now
   * on the launcher never falls back from it (scripts/release/launch.mjs decide). versions/previous stays, for Go back.
   */
  async listening(): Promise<void> {
    if (this.install !== "bundle" || !this.versionsDir || !this.running) return;
    const trial = join(this.versionsDir, "trial");
    if ((await readVersion(trial)) === this.running) await rm(trial, { force: true }).catch((err: Error) => console.warn(`[updates] ${trial} was not taken away: ${err.message}`));
  }

  /** The timers stopped and an update under way given up (the server is closing). */
  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (!this.goingAway) {
      this.abort?.abort(new Error("Afflatus is stopping"));
      await this.work?.catch(() => {});
    }
  }

  // ---------------------------------------------------------------- the check

  /** A check, when the switch is on and the last one was a day ago or more. */
  async daily(): Promise<void> {
    if (!(await readSettings(this.db)).afflatusUpdateChecks) return;
    const tried = this.state.triedAt ? Date.parse(this.state.triedAt) : 0;
    if (Date.now() - tried < CHECK_EVERY_MS) return;
    await this.check();
  }

  /** GitHub asked for the latest release now (one at a time). */
  check(): Promise<void> {
    this.checking ??= this.ask().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async ask(): Promise<void> {
    const own = envSaid.updatesUrl()?.trim();
    // the demo asks no site on the internet: without a stand-in address, nothing is asked
    if (!own && envSaid.pretendSites()) return;
    const url = own || GITHUB_LATEST;
    const at = now();
    const next: CheckState = { ...this.state, triedAt: at };
    try {
      const res = await fetchPublic(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "afflatus", ...(this.state.etag && this.state.release ? { "If-None-Match": this.state.etag } : {}) },
        signal: AbortSignal.timeout(20_000),
      }, [own]);
      if (res.status === 304) {
        await res.body?.cancel().catch(() => {});
      } else if (res.status === 404) {
        // no release yet
        await res.body?.cancel().catch(() => {});
        next.release = null;
        next.etag = null;
      } else if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(res.status === 403 || res.status === 429 ? `GitHub asks to wait before asking again (${res.status})` : `GitHub answered ${res.status}`);
      } else {
        const release = readRelease(await res.json());
        if (!release) throw new Error("GitHub's answer is not a release");
        next.release = release;
        next.etag = res.headers.get("etag");
      }
      next.checkedAt = at;
      next.error = null;
    } catch (err) {
      next.error = /fetch failed/i.test((err as Error).message) ? fetchFailure(err, url) : (err as Error).message;
      console.warn(`[updates] the check got no answer: ${next.error}`);
    }
    this.state = next;
    // a failed update is forgotten when a new answer comes: the card shows the release again
    if (this.flow?.phase === "failed") this.flow = null;
    await this.db.insertInto("settings").values({ key: CHECK_KEY, value: JSON.stringify(next), updated_at: at })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify(next), updated_at: at })).execute()
      .catch((err) => console.warn(`[updates] the check's answer was not kept: ${(err as Error).message}`));
    this.emit(true);
  }

  /** Whether the latest release is news for what runs here. */
  private isNewer(r: Release | null): boolean {
    if (!r) return false;
    const running = parseVersion(this.version) ? this.version : this.version === "dev" ? codeVersion() : null;
    // a checkout of unknown version: any release is worth saying
    if (!running) return true;
    // a prerelease is offered only to a prerelease (a release candidate tested on its way to the release)
    if (r.prerelease && !isPrerelease(running)) return false;
    return compareVersions(r.version, running) === 1;
  }

  // ---------------------------------------------------------------- what the web reads

  async view(here: boolean): Promise<UpdatesView> {
    const settings = await readSettings(this.db);
    const release = this.state.release;
    const newer = this.isNewer(release);
    const cannot = newer ? this.cannot(here, release!) : null;
    const busy = Boolean(this.flow && this.flow.phase !== "failed");
    return {
      // said as releases are said: 0.4.0, not the tag's v0.4.0
      version: this.version === "dev" ? this.version : bareVersion(this.version),
      install: this.install,
      checks: settings.afflatusUpdateChecks,
      checkedAt: this.state.checkedAt,
      checkError: this.state.error,
      latest: release ? withoutAssets(release) : null,
      newer,
      here,
      canUpdate: newer && !cannot && !busy,
      cannot,
      flow: this.flow,
      previous: await this.previous(),
      last: this.last,
      fallback: this.fallback,
      move: here && (await this.moveOffer()) ? { ...this.moveFrom!, ...(await (this.moveSummary ??= librarySummary(this.moveFrom!.from))) } : null,
    };
  }

  /** Why a newer release cannot be installed from here, in one click; null when it can. */
  private cannot(here: boolean, r: Release): string | null {
    if (this.install === "docker") return "A container cannot replace its own image: pull the new one.";
    if (this.install === "sources") return "Run from the sources: pull and build the new version.";
    if (!this.versionsDir || !this.running) return "This bundle is not laid out to update itself (versions/ beside data/): download the new one by hand.";
    if (!here) return "Only on the computer Afflatus runs on.";
    if (this.failed && r.version === this.failed) return `${r.version} did not start here: the next release will be offered.`;
    if (this.o.services.dbKind !== "sqlite") return "With a Postgres database, update by hand (the database is backed up with Postgres's tools).";
    if (!assetFor(r, this.platform)) return `This release has no download for ${this.platform}.`;
    if (!r.assets.some((a) => a.name === "SHA256SUMS.txt") || !r.assets.some((a) => a.name === "SHA256SUMS.txt.sig")) return "This release is not signed: download it by hand.";
    return null;
  }

  /** The version installed before the running one, which Go back starts again. */
  private async previous(): Promise<UpdatesView["previous"]> {
    if (this.install !== "bundle" || !this.versionsDir || !this.running) return null;
    const p = await readVersion(join(this.versionsDir, "previous"));
    if (!p || p === this.running || !existsSync(join(this.versionsDir, p))) return null;
    return { version: p, restoresLibrary: this.o.services.dbKind === "sqlite" && existsSync(this.backupOf(this.running)) };
  }

  private backupOf(version: string) {
    return join(this.o.dataDir, "backups", `before-${version}.db`);
  }

  /** What goes out on the event stream ("updates"): the flow, which the web shows as it moves. */
  private emit(force = false): void {
    if (!force && Date.now() - this.lastProgress < PROGRESS_EVERY_MS) return;
    this.lastProgress = Date.now();
    this.o.services.queue.events.emit("updates", { flow: this.flow });
  }

  private set(change: Partial<UpdateFlow>, force = true): void {
    if (!this.flow) return;
    this.flow = { ...this.flow, ...change };
    this.emit(force);
  }

  // ---------------------------------------------------------------- the update

  /** Update to the latest release: started here, carried on in the background (the flow says where it is). */
  async update(here: boolean): Promise<void> {
    if (this.flow && this.flow.phase !== "failed") throw httpError("An update is under way already.", 409);
    const release = this.state.release;
    if (!release || !this.isNewer(release)) throw httpError("There is no newer version to update to.", 409);
    const why = this.cannot(here, release);
    if (why) throw httpError(why, here ? 409 : 403);
    const asset = assetFor(release, this.platform)!;
    // the flow and the hold are taken before anything is awaited: a second press meanwhile finds the update under way
    // (409), rather than starting a second one whose failure would let go of the hold the first one waits behind
    const run = ++this.runs;
    const abort = new AbortController();
    this.abort = abort;
    this.flow = { phase: "downloading", version: release.version, bytes: 0, total: asset.size, left: 0, error: null };
    this.o.services.queue.holdNew(new Set());
    this.emit(true);
    // what is in the queue now finishes; what is asked for from now on waits for the new version
    const allowed = new Set<string>();
    const work = this.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute().then((active) => {
      for (const r of active) allowed.add(r.id);
      if (run === this.runs) this.o.services.queue.holdNew(allowed);
      return this.install_(release, asset, allowed, abort.signal);
    });
    this.work = work.then(
      () => undefined,
      async (err: Error) => {
        // only the run that owns the flow lets the queue go: another one's is not this one's to release
        if (run !== this.runs) return;
        this.o.services.queue.holdNew(null);
        if (abort.signal.aborted) {
          this.flow = null;
        } else {
          const said = (err instanceof Refused ? err.message : err.message.replace(/\.$/, "")).replace(/press Download again/gi, "press Try again");
          console.warn(`[updates] the update to ${release.version} did not go through: ${said}`);
          this.flow = { ...this.flow!, phase: "failed", error: `${said.replace(/\.$/, "")}. Nothing was changed: you are on ${this.version}.` };
        }
        this.emit(true);
      },
    ).finally(() => {
      if (run !== this.runs) return;
      this.work = null;
      this.abort = null;
    });
  }

  /** Not now: the update under way stopped (until it is switching), what it unpacked taken away, the download kept. */
  async cancel(): Promise<void> {
    if (!this.flow) return;
    if (this.flow.phase === "failed") {
      this.flow = null;
      this.emit(true);
      return;
    }
    if (this.flow.phase === "switching" || this.flow.phase === "restarting") throw httpError("The update is switching over: it can no longer be stopped.", 409);
    this.abort?.abort(new Error("stopped"));
    await this.work?.catch(() => {});
  }

  private async install_(release: Release, asset: Release["assets"][number], allowed: Set<string>, signal: AbortSignal): Promise<void> {
    const dir = this.updatesDir;
    const versions = this.versionsDir!;
    await mkdir(dir, { recursive: true });
    const free = this.o.free ?? freeBytes;
    // the archive, then the version it unpacks to, then the database's copy: about three times the archive
    const need = asset.size * 3;
    const has = await free(versions).catch(() => Number.POSITIVE_INFINITY);
    if (need > 0 && has < need) throw new Refused(`Not enough free space: the update needs about ${sizeText(need)} and the disk of ${versions} has ${sizeText(has)} free. Make room, then press Try again`);
    const own = envSaid.updatesUrl()?.trim();
    const allow = [own];
    const fetchOne = async (a: { name: string; url: string }, onBytes: (bytes: number, total: number) => void) => {
      // the address a release gives is fetched only from the internet over https (or from the stand-in site of UPDATES_URL)
      if (!own && !/^https:\/\//.test(a.url)) throw new Refused(`The release names ${a.name} at an address that is not https.`);
      if (!own) assertPublicUrl(a.url);
      const dest = join(dir, a.name);
      await rm(dest, { force: true });
      return fetchToFile({ source: a.url, headers: {}, allow, dest, signal, onBytes, free: this.o.free, backoffMs: this.o.backoffMs });
    };
    const sumsAsset = release.assets.find((a) => a.name === "SHA256SUMS.txt")!;
    const sigAsset = release.assets.find((a) => a.name === "SHA256SUMS.txt.sig")!;
    await fetchOne(sumsAsset, () => {});
    await fetchOne(sigAsset, () => {});
    const sums = await readFile(join(dir, sumsAsset.name));
    const sig = await readFile(join(dir, sigAsset.name), "utf8");
    // the list is checked before anything is read from it: a list the release key did not sign names nothing
    if (!verifySignature(sums, sig, this.key)) throw new Refused("The download's signature does not match Afflatus's release key, so it was not used");
    const expected = readSums(sums.toString("utf8")).get(asset.name);
    if (!expected) throw new Refused(`The signed list of checksums does not name ${asset.name}, so it was not used`);
    const archive = join(dir, asset.name);
    // an archive downloaded before (an update stopped while it waited) is used again when it is the one signed
    let sha = existsSync(archive) ? await sha256Of(archive) : null;
    if (sha !== expected) {
      await rm(archive, { force: true });
      sha = (await fetchOne(asset, (bytes, total) => this.set({ bytes, total: total || asset.size }, false))).sha256;
    }
    const size = (await stat(archive)).size;
    this.set({ phase: "verifying", bytes: size, total: size });
    if (sha !== expected) {
      await rm(archive, { force: true });
      throw new Refused("The download is damaged: its SHA-256 is not the one the signed list gives, so it was not used");
    }
    if (signal.aborted) throw signal.reason;

    // unpacked beside the running version: versions/<v>.tmp, then the version folder it holds renamed into versions/
    this.set({ phase: "unpacking" });
    const tmp = join(versions, `${release.version}.tmp`);
    let unpacked: string | null = null;
    try {
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      // run from the archive's folder with its bare name: GNU tar reads "C:\…" as a remote host
      const out = await runProgram(systemTar(), ["-xf", basename(archive), "-C", tmp], { cwd: dir, timeoutMs: 10 * 60_000, signal });
      if (out.code !== 0) throw new Error(`The archive could not be unpacked (${out.said || `tar exited with ${out.code}`})`);
      const top = (await readdir(tmp, { withFileTypes: true })).filter((d) => d.isDirectory());
      const base = !existsSync(join(tmp, "versions")) && top.length === 1 ? join(tmp, top[0]!.name) : tmp;
      const inside = await readVersion(join(base, "versions", "current"));
      if (!inside || !existsSync(join(base, "versions", inside))) throw new Refused("The archive holds no version to start (versions/current)");
      if (bareVersion(inside) !== release.version) throw new Refused(`The archive holds version ${inside}, not ${release.version}`);
      if (inside === this.running) throw new Refused(`${inside} is the version running`);
      const target = join(versions, inside);
      await rm(target, { recursive: true, force: true });
      await renameSoon(join(base, "versions", inside), target);
      unpacked = target;
      await rm(tmp, { recursive: true, force: true });
      if (signal.aborted) throw signal.reason;

      // the new version asked to start, without starting: it loads all of its code and checks the data folder (--check)
      this.set({ phase: "starting" });
      const node = this.o.nodeOf?.(target) ?? nodeIn(target, this.platform);
      const env: NodeJS.ProcessEnv = { ...environment(), DATA_DIR: this.o.dataDir };
      delete env.AFFLATUS_STARTED_FILE;
      const smoke = await runProgram(node, [join(target, "app", "apps", "server", "dist", "index.mjs"), "--check"], { cwd: target, env, timeoutMs: 2 * 60_000, signal });
      if (signal.aborted) throw signal.reason;
      if (smoke.code !== 0) throw new Refused(`${release.version} does not start here (its start check ${smoke.code === null ? "did not finish" : `exited with ${smoke.code}`}${smoke.said ? `: ${smoke.said}` : ""})`);

      // the queue finishes what it had when Update was pressed; nothing else starts meanwhile (Queue.holdNew)
      this.set({ phase: "waiting", left: await this.left(allowed) });
      const stopped = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      for (;;) {
        const left = await this.left(allowed);
        if (left !== this.flow!.left) this.set({ left });
        if (!left) break;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([stopped, new Promise<void>((r) => (timer = setTimeout(r, this.o.waitPollMs ?? 1000)))]);
        clearTimeout(timer);
        if (signal.aborted) throw signal.reason;
      }
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (unpacked) await rm(unpacked, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    // the switch: from here on nothing is stopped
    this.set({ phase: "switching" });
    const from = this.running!;
    const to = basename(unpacked);
    const backup = this.backupOf(to);
    const before = await readLine(join(versions, "previous"));
    try {
      await mkdir(join(this.o.dataDir, "backups"), { recursive: true });
      await rm(backup, { force: true });
      await sql`VACUUM INTO ${backup}`.execute(this.db);
      // versions/trial: the new version's first start, from which alone the launcher falls back (the server takes it away
      // once it listens); then previous, and current last, each written whole or not at all
      await writeAtomic(join(versions, "trial"), to);
      await writeAtomic(join(versions, "previous"), from);
      await writeAtomic(join(versions, "current"), to);
      const last: LastChange = { kind: "updated", from: bareVersion(from), to: bareVersion(to), at: now() };
      await writeAtomic(join(dir, "last.json"), JSON.stringify(last));
      this.last = last;
    } catch (err) {
      // a switch that did not go through is undone: the running version stays the one started, and nothing names the new one
      await writeAtomic(join(versions, "current"), from).catch((e: Error) => console.warn(`[updates] versions/current could not be set back to ${from}: ${e.message}`));
      if (before) await writeAtomic(join(versions, "previous"), before).catch(() => {});
      else await rm(join(versions, "previous"), { force: true }).catch(() => {});
      await rm(join(versions, "trial"), { force: true }).catch(() => {});
      await rm(unpacked, { recursive: true, force: true }).catch(() => {});
      await rm(backup, { force: true }).catch(() => {});
      throw err;
    }
    // one previous version kept, never more; the downloads and the older database copies go
    await this.tidy(versions, new Set([from, to]), to);
    this.goingAway = true;
    this.set({ phase: "restarting" });
    console.log(`[updates] updated to ${to}: restarting`);
    await this.o.restart();
  }

  /**
   * The jobs of those allowed still to finish; a queued one is waited for only while a machine open now could take it (it
   * would never start otherwise: the queue paused, its machine paused or gone, none taking its kind).
   */
  private async left(allowed: Set<string>): Promise<number> {
    if (!allowed.size) return 0;
    const rows = await this.db.selectFrom("jobs").select(["id", "status"]).where("id", "in", [...allowed]).where("status", "in", ["queued", "running"]).execute();
    const takeable = await this.o.services.queue.takeable(rows.filter((r) => r.status === "queued").map((r) => r.id));
    return rows.filter((r) => r.status === "running" || takeable.has(r.id)).length;
  }

  /** Version folders other than those kept, the update's downloads, and the database copies of updates before this one. */
  private async tidy(versions: string, keep: Set<string>, to: string): Promise<void> {
    for (const e of await readdir(versions, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && !keep.has(e.name)) await rm(join(versions, e.name), { recursive: true, force: true }).catch(() => {});
    }
    for (const e of await readdir(this.updatesDir, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile() && !/^(last|fallback|failed)\.json$/.test(e.name)) await rm(join(this.updatesDir, e.name), { force: true }).catch(() => {});
    }
    const backups = join(this.o.dataDir, "backups");
    for (const name of await readdir(backups).catch(() => [] as string[])) {
      if (/^before-.+\.db$/.test(name) && name !== `before-${to}.db`) await rm(join(backups, name), { force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- going back

  /**
   * What Go back would leave on RunPod, asked before its question: refused (`refused` says why) while a rented GPU runs
   * or a GPU hunt is on, as the version before has no Rented GPUs screen, no idle stop and no spending cap to stop them;
   * else what keeps billing stopped (`billing`: disks, volumes), named in the question.
   */
  async goBackCheck(): Promise<{ refused: string | null; billing: string[]; unknown: boolean }> {
    const prev = (await this.previous())?.version ?? "the previous version";
    const left = await this.o.services.rented.goingBack();
    const hunt = this.o.services.hunt.view().hunt;
    const refused = left.running.length
      ? `A rented GPU runs: ${left.running.join(", ")}. Stop or terminate it first: ${prev} has no Rented GPUs screen, idle stop or spending cap, and it would bill unseen.`
      : hunt ? `A GPU hunt is on: cancel it first. ${prev} has no Rented GPUs screen: a pod it deploys would bill unseen.` : null;
    return { refused, billing: left.billing, unknown: left.unknown };
  }

  /** Back to the previous version, with the library as it was at the update: the database copy restored, then a restart. */
  async goBack(): Promise<void> {
    if (this.flow && this.flow.phase !== "failed") throw httpError("An update is under way: stop it first.", 409);
    const prev = await this.previous();
    if (!prev) throw httpError("There is no previous version to go back to.", 409);
    if (!prev.restoresLibrary) throw httpError(`The copy of the library taken at the update to ${this.running} is not there: going back is not done.`, 409);
    const running = await this.db.selectFrom("jobs").select("id").where("status", "=", "running").executeTakeFirst();
    if (running) throw httpError("A job is running: go back once it is done, or stop it.", 409);
    const refused = (await this.goBackCheck()).refused;
    if (refused) throw httpError(refused, 409);
    const versions = this.versionsDir!;
    const from = this.running!;
    const db = join(this.o.dataDir, "afflatus.db");
    const backup = this.backupOf(from);
    this.goingAway = true;
    this.flow = { phase: "restarting", version: prev.version, bytes: 0, total: 0, left: 0, error: null };
    this.emit(true);
    console.log(`[updates] going back to ${prev.version}: restarting`);
    const at = now();
    // after the reply has gone out: the page hears that it restarts before the server closes
    setTimeout(() => void this.o.restart(async () => {
      // the database as it is now is set aside, not deleted: what was made since stays on disk
      const aside = join(this.o.dataDir, "backups", `after-${from}-${at.replace(/[:.]/g, "-")}.db`);
      try {
        await restoreDatabase(db, backup, aside);
      } catch (err) {
        await this.note({ kind: "failed", from, to: prev.version, at, error: `Going back did not go through: ${(err as Error).message}` });
        throw err;
      }
      await writeAtomic(join(versions, "current"), prev.version);
      await rm(join(versions, "previous"), { force: true });
      await rm(join(versions, "trial"), { force: true });
      await this.note({ kind: "went-back", from: bareVersion(from), to: bareVersion(prev.version), at });
    }), 200);
  }

  private async note(change: LastChange, dataDir = this.o.dataDir): Promise<void> {
    await mkdir(join(dataDir, "updates"), { recursive: true });
    await writeAtomic(join(dataDir, "updates", "last.json"), JSON.stringify(change));
  }

  // ---------------------------------------------------------------- the 0.3 move

  /** A 0.3 bundle's library beside this one (../afflatus-v0.3.*-<platform>/data), the newest when there are several. */
  private async findOldLibrary(): Promise<OldLibrary | null> {
    if (this.install !== "bundle" || !this.root || this.o.services.dbKind !== "sqlite") return null;
    // only the data folder the launcher set: one set by hand is the user's choice, and is left as it is
    const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (!same(resolve(this.o.dataDir), join(this.root, "data"))) return null;
    // where an archive lands: unzipped in place, this bundle's Afflatus folder sits beside the 0.3 folder; with Windows'
    // Extract All, each archive gets a folder of its own name first (…\afflatus-v0.3.0-win-x64\afflatus-v0.3.0-win-x64\data
    // beside …\afflatus-v0.4.0-win-x64\Afflatus), so the folder above this one's is looked in too, and one level inside each
    const parents = [dirname(this.root), dirname(dirname(this.root))].filter((p, i, all) => all.indexOf(p) === i);
    let found: OldLibrary | null = null;
    for (const parent of parents) {
      for (const e of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
        const m = OLD_BUNDLE.exec(e.name);
        if (!m || !e.isDirectory() || same(join(parent, e.name), this.root)) continue;
        const data = [join(parent, e.name, "data"), join(parent, e.name, e.name, "data")].find((d) => existsSync(join(d, "afflatus.db")));
        if (!data) continue;
        if (!found || (compareVersions(m[1]!, found.version) ?? 0) > 0) found = { from: data, version: m[1]! };
      }
    }
    return found;
  }

  /** The move is offered while this library is still empty: no item, draft or timeline. */
  private async moveOffer(): Promise<boolean> {
    if (!this.moveFrom || this.filled) return false;
    if (!existsSync(this.moveFrom.from)) return false;
    const one = async (table: "assets" | "drafts" | "timelines") => Boolean(await this.db.selectFrom(table).select("id").limit(1).executeTakeFirst());
    if ((await one("assets")) || (await one("drafts")) || (await one("timelines"))) this.filled = true;
    return !this.filled;
  }

  /** Bring the 0.3 library in: the services closed, the empty data folder renamed aside, the old one renamed in (no copy), a restart. */
  async moveIn(): Promise<void> {
    if (this.flow && this.flow.phase !== "failed") throw httpError("An update is under way: stop it first.", 409);
    if (!(await this.moveOffer())) throw httpError("There is no 0.3 library to bring over, or this one is no longer empty.", 409);
    const { from, version } = this.moveFrom!;
    const data = resolve(this.o.dataDir);
    // a rename moves a folder only on its own disk: across disks it would be a copy of the whole library, which is not done here
    const [a, b] = await Promise.all([stat(dirname(from)), stat(dirname(data))]);
    if (a.dev !== b.dev) throw httpError(`The 0.3 library (${from}) is on another disk: move its data folder here by hand, with Afflatus stopped.`, 409);
    const at = now();
    const aside = `${data}-empty-${at.slice(0, 19).replace(/[:T]/g, "-")}`;
    this.goingAway = true;
    this.flow = { phase: "restarting", version: this.version, bytes: 0, total: 0, left: 0, error: null };
    this.emit(true);
    console.log(`[updates] bringing the ${version} library in from ${from}: restarting`);
    setTimeout(() => void this.o.restart(async () => {
      await renameSoon(data, aside);
      try {
        await renameSoon(from, data);
      } catch (err) {
        await renameSoon(aside, data).catch(() => {});
        await this.note({ kind: "failed", from: version, to: bareVersion(this.version), at, error: `The 0.3 library was not brought over: ${(err as Error).message}` });
        throw err;
      }
      await this.note({ kind: "moved", from: version, to: bareVersion(this.version), at }, data);
    }), 200);
  }
}
