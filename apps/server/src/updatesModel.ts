import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { envSaid, VERSION } from "./config";
import { RELEASE_KEY } from "./releaseKey";
import type { Services } from "./services";

/** Progress goes out at most four times a second. */
const PROGRESS_EVERY_MS = 250;

export type InstallKind = "bundle" | "docker" | "sources";

// ---------------------------------------------------------------- versions

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

/** The release bundle's platform name for this computer, as the archives are named (scripts/release/bundle.mjs). */
export function platformName(platform = process.platform): string {
  return platform === "win32" ? "win-x64" : platform === "darwin" ? "darwin-arm64" : "linux-x64";
}

/**
 * A small file written whole or not at all (versions/current, data/updates/last.json and the like): a temporary file,
 * flushed to the disk, then renamed over the old one. A disk that fills up halfway leaves the old file as it was, never an
 * empty one; and whoever reads it meanwhile (the next start, the launcher, the page) finds the old file or the new, never
 * one still being written, which a slow or busy disk makes easy to catch. Each write has a temporary file of its own: two
 * at once (Check again and Get ffmpeg's own check) wrote into the one name, and what was renamed could be both mixed.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const file = await open(tmp, "w");
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await renameSoon(tmp, path);
  } catch (err) {
    // not left behind under a name no later write takes again
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** A rename tried again for a few seconds: on Windows a folder whose files were just closed can stay locked a moment. */
export async function renameSoon(from: string, to: string): Promise<void> {
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

/** The last update or Go back done here (data/updates/last.json), for "Updated today" and the like. */
export interface LastChange { kind: "updated" | "went-back" | "failed"; from: string; to: string; at: string; error?: string }

/**
 * A last.json as read back. One of another kind, such as the "moved" that the retired move of a 0.3 library left, is no
 * last change here and says nothing; neither does one that is not an object, nor one that is not JSON at all (a file cut
 * short by a disk full or a copy by hand): it only says "Updated today", and must never stop Afflatus from starting.
 */
export function readLastChange(text: string): LastChange | null {
  let kept: Partial<LastChange> | null;
  try {
    kept = JSON.parse(text) as Partial<LastChange> | null;
  } catch {
    return null;
  }
  return kept && (kept.kind === "updated" || kept.kind === "went-back" || kept.kind === "failed") ? (kept as LastChange) : null;
}

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
}

/** Kept between restarts: the last answer and its ETag. */
export interface CheckState { etag: string | null; checkedAt: string | null; triedAt: string | null; error: string | null; release: Release | null }

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

/**
 * What every part of the updater shares (updates.ts): its options, where it runs from, the flow the web follows, and the
 * last change noted. The parts are layered, each reading only those below it: the check, the update, going back, then
 * updates.ts (the start, what the web reads).
 */
export class UpdatesCore {
  readonly version: string;
  readonly install: InstallKind;
  protected readonly root: string | null;
  protected readonly key: string;
  protected readonly platform: string;
  protected state: CheckState = { etag: null, checkedAt: null, triedAt: null, error: null, release: null };
  protected flow: UpdateFlow | null = null;
  protected abort: AbortController | null = null;
  protected work: Promise<void> | null = null;

  /** The folder under versions/ this process runs from, when it is a bundle. */
  protected running: string | null = null;

  /** A version that did not start here (the launcher went back from it): not offered again; the next release is. */
  protected failed: string | null = null;
  protected last: LastChange | null = null;

  private lastProgress = 0;
  protected goingAway = false;

  constructor(protected readonly o: UpdatesOptions) {
    this.version = o.version ?? VERSION;
    const said = o.install ?? envSaid.install()?.trim();
    this.install = said === "bundle" || said === "docker" ? said : "sources";
    const root = o.root !== undefined ? o.root : envSaid.root()?.trim() || null;
    this.root = root ? resolve(root) : null;
    this.key = o.key ?? RELEASE_KEY;
    this.platform = o.platform ?? platformName();
  }

  protected get db() {
    return this.o.services.db;
  }
  protected get updatesDir() {
    return join(this.o.dataDir, "updates");
  }
  protected get versionsDir() {
    return this.root ? join(this.root, "versions") : null;
  }

  protected backupOf(version: string) {
    return join(this.o.dataDir, "backups", `before-${version}.db`);
  }

  /** What goes out on the event stream ("updates"): the flow, which the web shows as it moves. */
  protected emit(force = false): void {
    if (!force && Date.now() - this.lastProgress < PROGRESS_EVERY_MS) return;
    this.lastProgress = Date.now();
    this.o.services.queue.events.emit("updates", { flow: this.flow });
  }

  protected set(change: Partial<UpdateFlow>, force = true): void {
    if (!this.flow) return;
    this.flow = { ...this.flow, ...change };
    this.emit(force);
  }

  // ---------------------------------------------------------------- the update

  protected async note(change: LastChange): Promise<void> {
    await mkdir(this.updatesDir, { recursive: true });
    await writeAtomic(join(this.updatesDir, "last.json"), JSON.stringify(change));
  }
}
