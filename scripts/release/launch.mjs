// The bundle's own start, one per version: R/versions/<v>/app/launch.mjs, run by R/Afflatus.bat or R/afflatus.sh
// with that version's node. It sets the environment of a bundle (AFFLATUS_INSTALL, AFFLATUS_ROOT, DATA_DIR, the
// ffmpeg beside it), runs the server, and answers for it to the launcher through its exit code: 75 starts
// R/versions/current again (after an update, Go back, the move of a 0.3.0 library, or a fall back); anything
// else stops.
//
// The launchers are kept minimal and never change once unpacked (a running .bat is read from disk as it goes, so
// rewriting it under itself breaks it); what may change from one release to the next lives here instead, and is
// updated with the app. The contract with the server is in HANDOVER-updater.md: the server writes
// AFFLATUS_STARTED_FILE once it listens; a version that stops before that, when versions/previous names another
// one that is installed, is left for that one, with a note in DATA_DIR/updates/fallback.json for the server to
// show.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The exit code that asks the launcher to start versions/current again. */
export const RESTART = 75;

/**
 * What the launcher does once the server has stopped: start again (the server asked for it), fall back to the
 * previous version (this one never came up, and there is another one to go back to), or stop with the server's
 * code. A version that stopped after it was up is never left: it ran, so whatever stopped it is not the update's
 * doing. A stop on Ctrl+C or a signal is the user's, never a reason to fall back.
 *
 * @param {{ code: number | null, signal: string | null, started: boolean, version: string, previous: string | null, previousInstalled: boolean }} s
 * @returns {{ action: "restart" } | { action: "fallback", to: string } | { action: "stop", code: number }}
 */
export function decide(s) {
  if (s.code === RESTART) return { action: "restart" };
  // Windows reports a console's Ctrl+C or a closed window as STATUS_CONTROL_C_EXIT (0xC000013A)
  const byUser = s.signal !== null || s.code === 0xc000013a || s.code === 130;
  if (!s.started && !byUser && s.previous && s.previous !== s.version && s.previousInstalled) return { action: "fallback", to: s.previous };
  return { action: "stop", code: s.code ?? 1 };
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

async function main() {
  const app = dirname(fileURLToPath(import.meta.url));
  const versionDir = dirname(app);
  const version = basename(versionDir);
  const root = resolve(versionDir, "..", "..");
  const versions = join(root, "versions");
  const win = process.platform === "win32";
  const bin = join(versionDir, "bin");
  const started = join(versionDir, ".started");
  // the launcher's restarts open no new browser tab: the page already open follows the server back
  const restarting = join(versions, ".restarting");
  const firstStart = !existsSync(restarting);
  rmSync(restarting, { force: true });
  rmSync(started, { force: true });

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
  const previous = readLine(join(versions, "previous"));
  const next = decide({ code, signal, started: existsSync(started), version, previous, previousInstalled: !!previous && installed(root, previous) });
  if (next.action === "restart") {
    writeFileSync(restarting, "");
    process.exit(RESTART);
  }
  if (next.action === "fallback") {
    // the note goes where the server reads its data, so that it is found whichever DATA_DIR the user set
    const updates = join(env.DATA_DIR, "updates");
    mkdirSync(updates, { recursive: true });
    writeFileSync(join(updates, "fallback.json"), JSON.stringify({ version, previous: next.to, at: new Date().toISOString(), code }) + "\n");
    writeAtomic(join(versions, "current"), `${next.to}\n`);
    console.log(`Afflatus ${version} did not start; starting ${next.to} again.`);
    // a first start that failed has no page open yet: the previous version opens one
    if (!firstStart) writeFileSync(restarting, "");
    process.exit(RESTART);
  }
  process.exit(next.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
