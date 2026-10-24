import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { sql } from "kysely";
import { environment, envSaid } from "./config";
import { now, toRun } from "./db";
import { httpError } from "./errors";
import { fetchToFile, freeBytes, Refused, sizeText } from "./modelDownload";
import { assertPublicUrl } from "./outbound";
import { type LastChange, type Release, renameSoon, writeAtomic } from "./updatesModel";
import { bareVersion, UpdatesCheck } from "./updatesCheck";

/**
 * A version's name as versions/ holds it ("0.4.1", "0.4.0-rc.2"), or null for anything else. The names read from
 * versions/current and previous, and from the launcher's notes, are joined into paths that are started, written or
 * removed: one that could reach out of versions/ ("../x", "..", or "..." which Windows reads as "..") is never taken.
 */
export function versionName(name: unknown): string | null {
  if (typeof name !== "string" || !/^[\w.+-]+$/.test(name) || name.startsWith(".") || name.endsWith(".")) return null;
  return name;
}

/** How many of the libraries set aside after an update (backups/after-*.db) an update keeps, the newest. */
export const AFTER_KEPT = 3;

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
export function runProgram(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number | null; said: string }> {
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
export const readVersion = async (path: string) => versionName(await readLine(path));

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
 * Taking a release (updates.ts): downloaded, its signature and sums checked, unpacked beside the running version and
 * asked to start with --check, then switched to once the queue has finished what it had.
 */
export class UpdatesInstall extends UpdatesCheck {
  /** The update presses, counted: the run that owns the flow is the last one, and only it lets go of the queue's hold. */
  private runs = 0;

  /** Why a newer release cannot be installed from here, in one click; null when it can. */
  protected cannot(here: boolean, r: Release): string | null {
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
    const work = this.db.selectFrom("jobs").select("id").where(toRun).execute().then((active) => {
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
    const names = await readdir(backups).catch(() => [] as string[]);
    for (const name of names) {
      if (/^before-.+\.db$/.test(name) && name !== `before-${to}.db`) await rm(join(backups, name), { force: true }).catch(() => {});
    }
    // the libraries set aside by a Go back (updatesGoBack.ts) or a failed first start (launch.mjs), each with what was made
    // after its update: the newest AFTER_KEPT stay, the older ones go with their journal. None was ever removed before, a
    // whole database each
    const aside = await Promise.all(names.filter((n) => /^after-.+\.db$/.test(n)).map(async (name) => ({ name, at: (await stat(join(backups, name)).catch(() => null))?.mtimeMs ?? 0 })));
    for (const { name } of aside.sort((a, b) => b.at - a.at).slice(AFTER_KEPT)) {
      for (const tail of ["", "-wal", "-shm"]) await rm(join(backups, `${name}${tail}`), { force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- going back
}
