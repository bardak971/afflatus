import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareVersions, parseVersion } from "@afflatus/core";
import { envSaid } from "./config";
import { now } from "./db";
import { fetchFailure, fetchPublic } from "./outbound";
import { readSettings } from "./settings";
import { type CheckState, type Release, UpdatesCore } from "./updatesModel";

/** GitHub's answer for the latest release; UPDATES_URL stands in for it (the tests, a mirror). */
const GITHUB_LATEST = "https://api.github.com/repos/bardak971/afflatus/releases/latest";
/** How often GitHub is asked, at most: once a day. */
const CHECK_EVERY_MS = 24 * 60 * 60_000;

/** The settings row the last check is kept in, between restarts (a key the settings schema ignores, like the queue's). */
export const CHECK_KEY = "updates.afflatus";

// the order of versions is core's, read by the page too (Go back's question)
export { compareVersions };

/** A version without its tag's "v": the name of its folder under versions/ and what is said. */
export const bareVersion = (v: string) => v.trim().replace(/^v(?=\d)/, "");

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

/** A release as the web reads it: the archives' addresses are the server's business. */
export const withoutAssets = ({ assets: _assets, ...rest }: Release): Omit<Release, "assets"> => rest;

/**
 * The daily check of GitHub's latest release (updates.ts): one request with the last answer's ETag, its answer kept
 * between restarts.
 */
export class UpdatesCheck extends UpdatesCore {
  private checking: Promise<void> | null = null;

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
  protected isNewer(r: Release | null): boolean {
    if (!r) return false;
    const running = parseVersion(this.version) ? this.version : this.version === "dev" ? codeVersion() : null;
    // a checkout of unknown version: any release is worth saying
    if (!running) return true;
    // a prerelease is offered only to a prerelease (a release candidate tested on its way to the release)
    if (r.prerelease && !isPrerelease(running)) return false;
    return compareVersions(r.version, running) === 1;
  }

  // ---------------------------------------------------------------- what the web reads
}
