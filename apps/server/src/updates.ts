import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { envSaid } from "./config";
import { now } from "./db";
import { readSettings } from "./settings";
import { type CheckState, type Fallback, readLastChange, type UpdatesView, writeAtomic } from "./updatesModel";
import { bareVersion, CHECK_KEY, readRelease, withoutAssets } from "./updatesCheck";
import { UpdatesGoBack } from "./updatesGoBack";
import { readVersion, versionName } from "./updatesInstall";

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
 * Also here: going back to the previous version (its database copy restored), and the note the launcher leaves when a
 * new version did not start (data/updates/fallback.json).
 */

/** The timer that sees whether a check is due; the check itself is once a day. */
const TICK_MS = 60 * 60_000;
/** The first look after the start: not during it. */
const FIRST_TICK_MS = 30_000;

/** The exit code that asks the launcher to start Afflatus again (after an update or Go back). */
export const RESTART_CODE = 75;

export class AfflatusUpdates extends UpdatesGoBack {
  private fallback: Fallback | null = null;

  private timers: NodeJS.Timeout[] = [];

  /** Read what the last run left: the last check, the launcher's note, the last change. */
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
    this.last = await readFile(join(this.updatesDir, "last.json"), "utf8").then(readLastChange, () => null);
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
    };
  }
}
