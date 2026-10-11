// The bundle's own start, one per version: R/versions/<v>/app/launch.mjs, run by R/Afflatus.bat or R/afflatus.sh
// with that version's node. It sets the environment of a bundle (AFFLATUS_INSTALL, AFFLATUS_ROOT, DATA_DIR, the
// ffmpeg beside it), runs the server, and answers for it to the launcher through its exit code: 75 starts
// R/versions/current again (after an update, Go back, the move of a 0.3.0 library, or a fall back); anything
// else stops.
//
// The launchers are kept minimal and never change once unpacked (a running .bat is read from disk as it goes, so
// rewriting it under itself breaks it); what may change from one release to the next lives here instead, and is
// updated with the app. The contract with the server is in HANDOVER-updater.md: the server writes
// AFFLATUS_STARTED_FILE once it listens; a version that stops before that on its first start after an update
// (versions/trial names it), when versions/previous names another one that is installed, is left for that one, with
// the library as it was before the update and a note in DATA_DIR/updates/fallback.json for the server to show.
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The exit code that asks the launcher to start versions/current again. */
export const RESTART = 75;
/**
 * The server's exit codes for a start that stopped on something other than the version itself (apps/server/src/start.ts):
 * the port is taken (another Afflatus, a second double-click, a program of the user's), or the data folder cannot be
 * used. Going back to the previous version would meet the same, and would leave a good update behind.
 */
export const PORT_TAKEN = 3;
export const DATA_FOLDER = 4;

/**
 * What the launcher does once the server has stopped: start again (the server asked for it), fall back to the
 * previous version, or stop with the server's code. It falls back only when this was the version's first start after
 * the update switched to it (versions/trial names it, until the server has listened once) and it never came up: a
 * version that has run once is never left, whatever stops it weeks later. A stop on Ctrl+C or a signal is the user's,
 * and a port taken or a data folder that cannot be used is not the version's doing: neither is a reason to fall back.
 *
 * @param {{ code: number | null, signal: string | null, started: boolean, version: string, trial: string | null, previous: string | null, previousInstalled: boolean }} s
 * @returns {{ action: "restart" } | { action: "fallback", to: string } | { action: "stop", code: number }}
 */
export function decide(s) {
  if (s.code === RESTART) return { action: "restart" };
  // Windows reports a console's Ctrl+C or a closed window as STATUS_CONTROL_C_EXIT (0xC000013A)
  const byUser = s.signal !== null || s.code === 0xc000013a || s.code === 130;
  const notTheVersion = s.code === PORT_TAKEN || s.code === DATA_FOLDER;
  const firstStart = s.trial !== null && s.trial === s.version;
  if (!s.started && !byUser && !notTheVersion && firstStart && s.previous && s.previous !== s.version && s.previousInstalled) return { action: "fallback", to: s.previous };
  return { action: "stop", code: s.code ?? 1 };
}

/**
 * A version's name as versions/ holds it ("0.4.1", "0.4.0-rc.2"), or null for anything else: the names read from
 * versions/current, previous and trial are joined into paths that are started, written or removed, so one that could
 * reach out of versions/ ("../x", "..", or "..." which Windows reads as "..") is never taken.
 */
export function versionName(name) {
  if (typeof name !== "string" || !/^[\w.+-]+$/.test(name) || name.startsWith(".") || name.endsWith(".")) return null;
  return name;
}

/** The first line of a file such as versions/current, trimmed; null when the file is missing or empty. */
export function readLine(file) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/** A version folder that can be started: its node and its app are there. */
export function installed(root, version) {
  const dir = join(root, "versions", version);
  return existsSync(join(dir, "app", "launch.mjs")) && (existsSync(join(dir, "node", "node.exe")) || existsSync(join(dir, "node", "bin", "node")));
}

/** Writes a file through a temporary name, so that a crash halfway never leaves versions/current half written. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** A rename tried again for a few seconds: on Windows a file a process just let go of can stay locked a moment. */
function renameSoon(from, to) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

/** Whether a process of this id still runs: the marker of a run that ended is stale. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * The started markers of runs that ended, taken away. Each run of the launcher has its own (.started-<its pid>), so
 * that a second double-click never takes away the marker of the Afflatus already running, which would then fall back
 * when it stops.
 */
export function clearStaleMarkers(versionDir, isAlive = alive) {
  for (const name of readdirSync(versionDir)) {
    const m = /^\.started(?:-(\d+))?$/.exec(name);
    if (m && !(m[1] && isAlive(Number(m[1])))) rmSync(join(versionDir, name), { force: true });
  }
}

/**
 * The library put back as it was before the update to `version` (DATA_DIR/backups/before-<version>.db, which the
 * update took), once that version did not start: it may have migrated the database already, and the previous version
 * refuses a database a newer one has migrated. The database as it is is set aside, not deleted
 * (backups/after-failed-<version>-<time>.db, its -wal beside it). The copy is written under a temporary name first and
 * renamed in last, so that a stop at any point leaves one database or the other in place, never an empty start.
 * Returns where the database was set aside (null when there was none), or false when there is no copy to put back.
 */
export function restoreLibrary(dataDir, version, at = new Date()) {
  const db = join(dataDir, "afflatus.db");
  const backup = join(dataDir, "backups", `before-${version}.db`);
  if (!existsSync(backup)) return false;
  const tmp = `${db}.tmp`;
  copyFileSync(backup, tmp);
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const aside = join(dataDir, "backups", `after-failed-${version}-${at.toISOString().replace(/[:.]/g, "-")}.db`);
  // the write-ahead log goes with the database it belongs to: left beside the restored one, SQLite would replay it there
  if (existsSync(`${db}-wal`)) renameSoon(`${db}-wal`, `${aside}-wal`);
  rmSync(`${db}-shm`, { force: true });
  const had = existsSync(db);
  if (had) renameSoon(db, aside);
  renameSoon(tmp, db);
  return had ? aside : null;
}

async function main() {
  const app = dirname(fileURLToPath(import.meta.url));
  const versionDir = dirname(app);
  const version = basename(versionDir);
  const root = resolve(versionDir, "..", "..");
  const versions = join(root, "versions");
  const win = process.platform === "win32";
  const bin = join(versionDir, "bin");
  // this run's own marker: another run's (the Afflatus already running, when this one is a second double-click) is left alone
  const started = join(versionDir, `.started-${process.pid}`);
  // the launcher's restarts open no new browser tab: the page already open follows the server back
  const restarting = join(versions, ".restarting");
  const firstStart = !existsSync(restarting);
  rmSync(restarting, { force: true });
  clearStaleMarkers(versionDir);

  const env = { ...process.env };
  env.AFFLATUS_INSTALL = "bundle";
  env.AFFLATUS_ROOT = root;
  env.AFFLATUS_STARTED_FILE = started;
  // the release the app was staged as (v0.4.0), which the web page was built with too; the folder name otherwise
  env.AFFLATUS_VERSION = readLine(join(app, "VERSION")) ?? version;
  if (!env.DATA_DIR) env.DATA_DIR = join(root, "data");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const exe = join(bin, win ? `${tool}.exe` : tool);
    if (existsSync(exe) && !env[tool.toUpperCase()]) env[tool.toUpperCase()] = exe;
  }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${bin}${win ? ";" : ":"}${env[pathKey] ?? ""}`;
  const port = Number(env.PORT) || 8720;
  console.log(`Afflatus ${env.AFFLATUS_VERSION} - http://127.0.0.1:${port}  (${win ? "close this window" : "Ctrl+C"} to stop it)`);

  const server = spawn(process.execPath, ["--enable-source-maps", join(app, "apps", "server", "dist", "index.mjs"), ...process.argv.slice(2)], { env, stdio: "inherit" });
  // Ctrl+C reaches the server by itself (same console, same process group): this one only waits for it to close
  // its database and stop, and passing it on would cut that short (on Windows a kill is a TerminateProcess). A
  // SIGTERM or SIGHUP sent to this process alone is passed on, rather than leaving the server running
  process.on("SIGINT", () => {});
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => server.kill("SIGTERM"));

  // the browser, once, when the server says it is up
  let watch;
  if (firstStart && env.AFFLATUS_NO_BROWSER !== "1") {
    watch = setInterval(() => {
      if (!existsSync(started)) return;
      clearInterval(watch);
      const url = `http://127.0.0.1:${port}`;
      const [cmd, args] = win ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      try {
        spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
      } catch {
        // no browser to open (a server without a desktop): the address is printed above
      }
    }, 250);
  }

  const [code, signal] = await new Promise((done) => server.on("exit", (c, s) => done([c, s])));
  clearInterval(watch);
  const wasUp = existsSync(started);
  rmSync(started, { force: true });
  const previous = versionName(readLine(join(versions, "previous")));
  const trial = versionName(readLine(join(versions, "trial")));
  const next = decide({ code, signal, started: wasUp, version, trial, previous, previousInstalled: !!previous && installed(root, previous) });
  if (next.action === "restart") {
    writeFileSync(restarting, "");
    process.exit(RESTART);
  }
  if (next.action === "fallback") {
    // the library as it was before the update: the version this falls back to may not read what this one migrated. A
    // Postgres database (DATABASE_URL) is restored with Postgres's own tools
    if (!env.DATABASE_URL?.trim()) {
      try {
        const aside = restoreLibrary(env.DATA_DIR, version);
        if (aside !== false) console.log(`The library is back as it was before ${version}${aside ? `; the database as ${version} left it is kept in ${aside}` : ""}.`);
      } catch (err) {
        console.error(`The library could not be put back as it was before ${version} (${err.message}): with Afflatus stopped, put ${join(env.DATA_DIR, "backups", `before-${version}.db`)} in place of afflatus.db.`);
      }
    }
    // the note goes where the server reads its data, so that it is found whichever DATA_DIR the user set
    const updates = join(env.DATA_DIR, "updates");
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, "fallback.json"), JSON.stringify({ version, previous: next.to, at: new Date().toISOString(), code }) + "\n");
    writeAtomic(join(versions, "current"), `${next.to}\n`);
    rmSync(join(versions, "trial"), { force: true });
    console.log(`Afflatus ${version} did not start; starting ${next.to} again.`);
    // a first start that failed has no page open yet: the previous version opens one
    if (!firstStart) writeFileSync(restarting, "");
    process.exit(RESTART);
  }
  process.exit(next.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
