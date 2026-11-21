// The bundle's own start, one per version: R/versions/<v>/app/launch.mjs, run by R/Afflatus.bat or R/afflatus.sh
// with that version's node. It sets the environment of a bundle (AFFLATUS_INSTALL, AFFLATUS_ROOT, DATA_DIR, its
// bin/ with ffmpeg first on the PATH), runs the server, and answers for it to the launcher through its exit code: 75 starts
// R/versions/current again (after an update, Go back, or a fall back); anything else stops.
//
// The launchers are kept minimal and never change once unpacked (a running .bat is read from disk as it goes, so
// rewriting it under itself breaks it); what may change from one release to the next lives here instead, and is
// updated with the app. The contract with the server is in HANDOVER-updater.md: the server writes
// AFFLATUS_STARTED_FILE once it listens; a version that stops before that on its first start after an update
// (versions/trial names it), when versions/previous names another one that is installed, is left for that one, with
// the library as it was before the update and a note in DATA_DIR/updates/fallback.json for the server to show.
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { arch, homedir, release, totalmem } from "node:os";
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
  // a stop asked for (Ctrl+C, a SIGTERM or SIGHUP from the system or the person), not a crash: a SIGKILL, SIGSEGV or SIGABRT
  // during a first start is the version's (a native module it ships, its Node) as much as an exit code is
  const byUser = STOP_SIGNALS.includes(s.signal) || s.code === 0xc000013a || s.code === 130;
  const notTheVersion = s.code === PORT_TAKEN || s.code === DATA_FOLDER;
  const firstStart = s.trial !== null && s.trial === s.version;
  if (!s.started && !byUser && !notTheVersion && firstStart && s.previous && s.previous !== s.version && s.previousInstalled) return { action: "fallback", to: s.previous };
  return { action: "stop", code: exitCode(s.code, byUser) };
}

/**
 * The code this launcher exits with once the server stopped for good, as Afflatus.bat's `if errorlevel 1 pause` reads it:
 * cmd takes an exit code as a signed number, so a native crash (0xC0000005 is -1073741819) or an End task (0xFFFFFFFF,
 * -1) was below 1, and the window shut on the line saying why it stopped before it could be read. Any stop that is
 * neither a clean one nor the user's own Ctrl+C gives 1 or more: the server's own small codes (3, 4, 7) as they are, every
 * other 1. The .bat of an unpacked install never changes, so this has to be done here.
 */
export function exitCode(code, byUser = false) {
  if (code === 0 || byUser) return code ?? 1;
  return code !== null && code >= 1 && code <= 255 ? code : 1;
}

/** The signals that ask a process to stop, as Ctrl+C, a closed terminal or a shutdown send them; any other is a crash or a kill. */
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
/** The signals a process dies on when it crashes in its own code (a native module, Node itself). */
const CRASH_SIGNALS = ["SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGABRT", "SIGTRAP", "SIGSYS"];
/** Windows's codes for a process that crashed: an access violation, a stack overrun or overflow, a corrupted heap. */
const WINDOWS_CRASHES = { 0xc0000005: "an access violation", 0xc0000409: "a stack buffer overrun", 0xc00000fd: "a stack overflow", 0xc0000374: "a corrupted heap", 0xc000001d: "an illegal instruction" };

/**
 * The line the launcher says once the server has stopped and it stops too, in the terminal and the log: every way out says
 * why. A server killed by a signal says nothing itself (no handler of its runs on a SIGKILL or a SIGSEGV), and the shell
 * says nothing either, as its own child (this launcher) exits normally: up to 0.10.0 such a stop gave the prompt back with
 * no word at all (macOS, 2026-11-10).
 *
 * @param {{ code: number | null, signal: string | null, log: string | null }} s
 */
export function stopLine(s) {
  const send = s.log ? ` If it happens again, send the log: ${s.log}` : "";
  if (s.signal === "SIGKILL") return `Afflatus stopped: the server was killed (SIGKILL), with no chance to say why. The system does this when it runs short of memory (on macOS too), or another program did it. Start it again.${send}`;
  if (CRASH_SIGNALS.includes(s.signal)) return `Afflatus stopped: the server crashed (${s.signal}) in native code (the image library, or Node itself). Start it again.${send}`;
  if (s.signal) return `Afflatus stopped: the server was ended by ${s.signal}${STOP_SIGNALS.includes(s.signal) ? ", a stop asked of it (Ctrl+C, a closed terminal, the system or another program)" : ""}.`;
  if (s.code === 0) return "Afflatus stopped.";
  if (s.code === 0xc000013a || s.code === 130) return "Afflatus stopped (Ctrl+C, or its window closed).";
  const crash = WINDOWS_CRASHES[s.code];
  if (crash) return `Afflatus stopped: the server crashed (${crash}, 0x${s.code.toString(16).toUpperCase()}) in native code (the image library, or Node itself). Start it again.${send}`;
  if (s.code === PORT_TAKEN || s.code === DATA_FOLDER) return `Afflatus stopped (exit code ${s.code}): why is said just above.`;
  // Windows's large codes (a process ended from Task Manager is 0xFFFFFFFF) read as they are documented, in hex
  const said = s.code === null ? "none" : s.code > 0xffff ? `0x${s.code.toString(16).toUpperCase()}` : s.code;
  return `Afflatus stopped: the server ended with exit code ${said}; what it said last is just above.${send}`;
}

/** How many days of logs data/logs keeps: the files of older days are taken away at a start, and at each new day of a long run. */
export const LOG_DAYS = 14;
/** A day's log past this size is set aside as afflatus-<day>.old.log (one only, the one before it replaced) and started afresh. */
export const LOG_MAX = 32 * 1024 * 1024;
/** The launcher's log files' names: afflatus-<day>.log and the one set aside, never the server's own afflatus.log (access.ts) beside them. */
const LOG_NAME = /^afflatus-(\d{4}-\d{2}-\d{2})(?:\.old)?\.log$/;

/** A day as the log files are named: the local date, 2026-11-10. */
const dayOf = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/**
 * The user's home folder taken out of the text the log file keeps, as `~`: that log is the one people are asked to send,
 * and its paths (the log's own, the library set aside on a fall back, every line of a crash's stack) named the account it
 * ran under (C:\Users\<name>\...). Each form a path is printed in is caught: either slash, a file:// URL with its spaces as
 * %20, and any case on Windows, where C:\Users and c:\users are the same folder. The paths the launcher works with are
 * left as they are; only what is written down changes.
 *
 * @param {string} home
 * @returns {(text: string) => string}
 */
export function hideHome(home, win = process.platform === "win32") {
  const trimmed = home.replace(/[\\/]+$/, "");
  // a home at the root of a disk (/, C:\) would turn every path into ~
  if (!/[\\/][^\\/]/.test(trimmed)) return (text) => text;
  const forms = [...new Set([trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\"), encodeURI(trimmed.replace(/\\/g, "/"))])];
  const escape = (f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // the whole folder only: /home/bob is not taken out of /home/bobby
  const re = new RegExp(`(?:${forms.map(escape).join("|")})(?![\\w.-])`, win ? "gi" : "g");
  return (text) => text.replace(re, "~");
}

/**
 * The bundle's log file: everything the server prints, and the launcher's own lines, each line stamped with its time, in
 * DATA_DIR/logs/afflatus-<day>.log, a file a day, kept LOG_DAYS days and LOG_MAX bytes at most. Each write goes to the
 * disk at once (a write to the file, not a buffer): a server killed the next moment leaves its last lines in the file.
 * A log that cannot be written never stops Afflatus: it is said once in the terminal and left off. The user's home folder
 * is written as `~` in the file (hideHome), not in the terminal, where the path is there to be opened.
 *
 * @param {string} dir
 * @param {{ now?: () => Date, max?: number, days?: number, warn?: (line: string) => void, home?: string }} [o]
 */
export function openLog(dir, o = {}) {
  const now = o.now ?? (() => new Date());
  const max = o.max ?? LOG_MAX;
  const hide = hideHome(o.home ?? homedir());
  const warn = o.warn ?? ((line) => process.stderr.write(`${line}\n`));
  let fd = null;
  let day = null;
  let size = 0;
  let off = false;
  // whether the next text of each stream starts a line, which then takes a time stamp
  const atStart = new Map();
  const fileOf = (d) => join(dir, `afflatus-${d}.log`);
  const close = () => {
    if (fd !== null) closeSync(fd);
    fd = null;
  };
  const fail = (err) => {
    off = true;
    try {
      close();
    } catch {}
    warn(`[log] the log file in ${dir} cannot be written (${err.message}): Afflatus goes on, its lines in this terminal only.`);
  };
  // the days past LOG_DAYS taken away: at the start, and again when a server left up for weeks reaches a new day, where
  // up to 0.10.0 a long run kept every day's file (up to some 64 MB each)
  const sweep = (at) => {
    const oldest = dayOf(new Date(at.getTime() - (o.days ?? LOG_DAYS) * 86_400_000));
    for (const name of readdirSync(dir)) {
      const m = LOG_NAME.exec(name);
      if (m && m[1] < oldest) rmSync(join(dir, name), { force: true });
    }
  };
  const open = (d) => {
    close();
    mkdirSync(dir, { recursive: true });
    fd = openSync(fileOf(d), "a");
    size = fstatSync(fd).size;
    day = d;
  };
  try {
    const at = now();
    open(dayOf(at));
    sweep(at);
  } catch (err) {
    fail(err);
  }
  /** Text as a stream gives it (a line in pieces, or several at once), from `from` ("out", "err", the launcher's own). */
  const write = (text, from = "launcher") => {
    if (off || !text) return;
    try {
      const at = now();
      const d = dayOf(at);
      if (d !== day) {
        open(d);
        sweep(at);
      } else if (size >= max) {
        close();
        renameSync(fileOf(d), join(dir, `afflatus-${d}.old.log`));
        open(d);
      }
      const stamp = at.toISOString();
      let out = "";
      for (const part of text.split(/(?<=\n)/)) {
        if (atStart.get(from) ?? true) out += `${stamp} ${from === "launcher" ? "[launcher] " : ""}`;
        out += part;
        atStart.set(from, part.endsWith("\n"));
      }
      const bytes = Buffer.from(hide(out));
      writeSync(fd, bytes);
      size += bytes.length;
    } catch (err) {
      fail(err);
    }
  };
  return {
    /** The day's file, null when the log is off. */
    get path() {
      return off ? null : fileOf(day);
    },
    write,
    /** One line of the launcher's: in the terminal (stderr for a warning) and the log. */
    say(line, err = false) {
      (err ? process.stderr : process.stdout).write(`${line}\n`);
      write(`${line}\n`);
    },
    close() {
      try {
        close();
      } catch {}
    },
  };
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
 * renamed over the database last, so that a stop or a failed rename at any point leaves one database or the other in
 * place, never an empty start.
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
  // the database kept under its name aside too (a second link to the same file, or a copy where the disk has no links),
  // so that the copy is renamed straight over it: never a moment with no database
  const had = existsSync(db);
  if (had) {
    try {
      linkSync(db, aside);
    } catch {
      copyFileSync(db, aside);
    }
  }
  const wal = existsSync(`${db}-wal`);
  try {
    // the write-ahead log goes with the database it belongs to: left beside the restored one, SQLite would replay it there
    if (wal) renameSoon(`${db}-wal`, `${aside}-wal`);
    rmSync(`${db}-shm`, { force: true });
    renameSoon(tmp, db);
  } catch (err) {
    // the database as it was stays, its log put back with it
    if (wal && existsSync(`${aside}-wal`)) {
      try {
        renameSoon(`${aside}-wal`, `${db}-wal`);
      } catch {}
    }
    if (had) rmSync(aside, { force: true });
    rmSync(tmp, { force: true });
    throw err;
  }
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
  // `reset-password` (Afflatus.bat reset-password): a command run once on the data folder, not a start. It leaves the
  // markers of a start alone, opens no browser and is never taken for a version that does not start
  const command = process.argv[2] === "reset-password";
  if (!command) {
    rmSync(restarting, { force: true });
    clearStaleMarkers(versionDir);
  }

  const env = { ...process.env };
  env.AFFLATUS_INSTALL = "bundle";
  env.AFFLATUS_ROOT = root;
  env.AFFLATUS_STARTED_FILE = started;
  // the release the app was staged as (v0.4.0), which the web page was built with too; the folder name otherwise
  env.AFFLATUS_VERSION = readLine(join(app, "VERSION")) ?? version;
  if (!env.DATA_DIR) env.DATA_DIR = join(root, "data");
  // the bundle's ffmpeg is found first on the PATH, not set in FFMPEG and FFPROBE: those are the person's own, never swapped
  // for another (apps/server/src/ffmpegCheck.ts), and set here they kept a bundle's ffmpeg that fails the start-up check from
  // being passed over for one that works, or Get ffmpeg from being offered. A person's own FFMPEG is passed on untouched
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${bin}${win ? ";" : ":"}${env[pathKey] ?? ""}`;
  const port = Number(env.PORT) || 8720;
  if (command) {
    const run = spawn(process.execPath, [join(app, "apps", "server", "dist", "index.mjs"), ...process.argv.slice(2)], { env, stdio: "inherit" });
    process.exit(await new Promise((done) => run.on("exit", (code) => done(exitCode(code)))));
  }
  // the log file, which the terminal's lines are lost without: what the server said before a stop that came with no word
  const log = openLog(join(env.DATA_DIR, "logs"));
  log.write(`Afflatus ${env.AFFLATUS_VERSION} starting: ${process.platform} ${release()} ${arch()}, Node ${process.version}, ${Math.round(totalmem() / 2 ** 30)} GB of memory\n`);
  log.say(`Afflatus ${env.AFFLATUS_VERSION} - http://127.0.0.1:${port}  (${win ? "close this window" : "Ctrl+C"} to stop it)${log.path ? `\nIts log: ${log.path}` : ""}`);

  // the server's output through this process, to the terminal and the log both. Its stdin stays the terminal's, and the
  // console the same: Ctrl+C reaches the server as before
  const server = spawn(process.execPath, ["--enable-source-maps", join(app, "apps", "server", "dist", "index.mjs"), ...process.argv.slice(2)], { env, stdio: ["inherit", "pipe", "pipe"] });
  // a terminal closed under it (its SIGHUP is passed on below) leaves writes to it failing: the log still takes them
  for (const to of [process.stdout, process.stderr]) to.on("error", () => {});
  for (const [from, stream, to] of [["out", server.stdout, process.stdout], ["err", server.stderr, process.stderr]]) {
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      to.write(text);
      log.write(text, from);
    });
  }
  // the server's last words read to the end before this says why it stopped: its pipes close after its exit, unless a
  // child of its holds them, which is waited for 2 s at most
  const closed = new Promise((done) => server.on("close", done));
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
  await Promise.race([closed, new Promise((done) => setTimeout(done, 2000))]);
  clearInterval(watch);
  const wasUp = existsSync(started);
  rmSync(started, { force: true });
  const previous = versionName(readLine(join(versions, "previous")));
  const trial = versionName(readLine(join(versions, "trial")));
  const next = decide({ code, signal, started: wasUp, version, trial, previous, previousInstalled: !!previous && installed(root, previous) });
  if (next.action === "restart") {
    log.write("the server asked for a restart (an update, Go back)\n");
    log.close();
    writeFileSync(restarting, "");
    process.exit(RESTART);
  }
  if (next.action === "fallback") {
    // the library as it was before the update: the version this falls back to may not read what this one migrated. A
    // Postgres database (DATABASE_URL) is restored with Postgres's own tools
    if (!env.DATABASE_URL?.trim()) {
      try {
        const aside = restoreLibrary(env.DATA_DIR, version);
        if (aside !== false) log.say(`The library is back as it was before ${version}${aside ? `; the database as ${version} left it is kept in ${aside}` : ""}.`);
      } catch (err) {
        log.say(`The library could not be put back as it was before ${version} (${err.message}): with Afflatus stopped, put ${join(env.DATA_DIR, "backups", `before-${version}.db`)} in place of afflatus.db.`, true);
      }
    }
    // the note goes where the server reads its data, so that it is found whichever DATA_DIR the user set
    const updates = join(env.DATA_DIR, "updates");
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, "fallback.json"), JSON.stringify({ version, previous: next.to, at: new Date().toISOString(), code }) + "\n");
    writeAtomic(join(versions, "current"), `${next.to}\n`);
    rmSync(join(versions, "trial"), { force: true });
    log.say(`Afflatus ${version} did not start (${signal ?? `exit code ${code}`}); starting ${next.to} again.`);
    log.close();
    // a first start that failed has no page open yet: the previous version opens one
    if (!firstStart) writeFileSync(restarting, "");
    process.exit(RESTART);
  }
  log.say(stopLine({ code, signal, log: log.path }), code !== 0 || signal !== null);
  log.close();
  process.exit(next.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
