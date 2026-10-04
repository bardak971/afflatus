import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tools } from "./video";

/**
 * What Afflatus needs on the computer it runs on, checked once at start and again on request: the tools
 * it calls (ffmpeg and ffprobe, for every trim, export, join and preview frame), the Node it runs on,
 * and a data folder it can write. Nothing here stops the start: the library and the designer work with
 * none of it, so a missing tool is said, in the log and in the app, and the rest goes on.
 */

export interface Check {
  id: "node" | "ffmpeg" | "ffprobe" | "data";
  label: string;
  ok: boolean;
  /** What was found (a version, a path), or what is wrong. */
  detail: string;
  /** What stops working without it: said in the app when it is missing. */
  without: string;
  /** How to put it right. */
  fix: string;
}

export interface Preflight {
  at: string;
  checks: Check[];
  /** Every check passed. */
  ok: boolean;
}

/** The Node this was written for (package.json's engines). */
export const NODE_LEAST = "22.16";

const atLeast = (version: string, least: string) => {
  const a = version.replace(/^v/, "").split(".").map(Number);
  const b = least.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > b[i]!) return true;
    if ((a[i] ?? 0) < b[i]!) return false;
  }
  return true;
};

/** A tool's first line of `-version`, or why it could not be run. */
function versionOf(tool: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    execFile(tool, ["-version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        done({ ok: false, detail: code === "ENOENT" ? `"${tool}" was not found on this computer` : `"${tool}" could not be run (${code ?? err.message})` });
        return;
      }
      const first = String(stdout).split(/\r?\n/)[0]?.trim() ?? "";
      const m = /version\s+(\S+)/i.exec(first);
      done({ ok: true, detail: m ? `${m[1]}${tool === "ffmpeg" || tool === "ffprobe" ? "" : ` (${tool})`}` : first || tool });
    });
  });
}

export async function runPreflight(dataDir: string, which: { ffmpeg?: string; ffprobe?: string } = {}): Promise<Preflight> {
  const ffmpeg = which.ffmpeg ?? tools.ffmpeg;
  const ffprobe = which.ffprobe ?? tools.ffprobe;
  const [mpeg, probe, data] = await Promise.all([
    versionOf(ffmpeg),
    versionOf(ffprobe),
    (async () => {
      try {
        await mkdir(dataDir, { recursive: true });
        const probeFile = join(dataDir, `.write-check-${process.pid}`);
        await writeFile(probeFile, "ok");
        await unlink(probeFile);
        return { ok: true, detail: dataDir };
      } catch (err) {
        return { ok: false, detail: `${dataDir}: ${(err as Error).message}` };
      }
    })(),
  ]);
  const nodeOk = atLeast(process.version, NODE_LEAST);
  const checks: Check[] = [
    { id: "node", label: "Node", ok: nodeOk, detail: nodeOk ? process.version : `${process.version} is older than ${NODE_LEAST}`, without: "Afflatus may fail in ways that are hard to read.", fix: `Install Node ${NODE_LEAST} or newer.` },
    { id: "ffmpeg", label: "ffmpeg", ok: mpeg.ok, detail: mpeg.detail, without: "Trims, exports, joins, slow motion and the audio seam repair fail; videos get no preview frame.", fix: `Install ffmpeg and have it on the PATH, or set FFMPEG to its path (now: ${ffmpeg}).` },
    { id: "ffprobe", label: "ffprobe", ok: probe.ok, detail: probe.detail, without: "Videos are filed without their length, size and sound, and cannot be trimmed or exported.", fix: `It comes with ffmpeg; or set FFPROBE to its path (now: ${ffprobe}).` },
    { id: "data", label: "Data folder", ok: data.ok, detail: data.detail, without: "Nothing can be saved.", fix: "Make the folder writable, or set DATA_DIR to one that is." },
  ];
  return { at: new Date().toISOString(), checks, ok: checks.every((c) => c.ok) };
}

/** The last preflight, for the health route; `run` makes a new one and logs what it found. */
export const preflight = {
  last: null as Preflight | null,
  dataDir: "",
  async run(dataDir?: string): Promise<Preflight> {
    const dir = dataDir ?? preflight.dataDir;
    preflight.dataDir = dir;
    const p = await runPreflight(dir);
    preflight.last = p;
    for (const c of p.checks) console[c.ok ? "log" : "warn"](`[check] ${c.label}: ${c.ok ? c.detail : `${c.detail}. ${c.without} ${c.fix}`}`);
    return p;
  },
};
