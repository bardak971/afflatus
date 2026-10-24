import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environment } from "./config";
import { chooseFfmpeg, toolSaid, wordsOf, type Choice } from "./ffmpegCheck";
import { chooseTools } from "./video";

/**
 * What Afflatus needs on the computer it runs on, checked once at start and again on request: the tools
 * it calls (ffmpeg and ffprobe, for every trim, export, join and preview frame), the Node it runs on,
 * and a data folder it can write. ffmpeg is tried as Afflatus uses it, and another one found used in its place when it fails
 * (ffmpegCheck.ts). Nothing here stops the start: the library and the designer work with
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
  /** Said even though it passed: another ffmpeg than the PATH's is used, and why. */
  note?: string;
  /** What the page offers to put it right: Get ffmpeg's download, or Homebrew's line to copy (ffmpeg only). */
  get?: "download" | "brew";
}

export interface Preflight {
  at: string;
  checks: Check[];
  /** Every check passed. */
  ok: boolean;
  /** Which ffmpeg was chosen, and those refused. */
  ffmpeg: Choice;
}

/** The Node this was written for (package.json's engines). */
const NODE_LEAST = "22.16";

const atLeast = (version: string, least: string) => {
  const a = version.replace(/^v/, "").split(".").map(Number);
  const b = least.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > b[i]!) return true;
    if ((a[i] ?? 0) < b[i]!) return false;
  }
  return true;
};

export interface PreflightOptions {
  /** ComfyUI's folders on this computer, where its own ffmpeg may be (known once the settings are read). */
  comfyDirs?: string[];
  /** Every ffmpeg tried again, none of the kept results used (Check again). */
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** `which`: ffmpeg and ffprobe named as FFMPEG and FFPROBE would name them (the tests). */
export async function runPreflight(dataDir: string, which: { ffmpeg?: string; ffprobe?: string } = {}, o: PreflightOptions = {}): Promise<Preflight> {
  const env = { ...(o.env ?? environment()), ...(which.ffmpeg ? { FFMPEG: which.ffmpeg } : {}), ...(which.ffprobe ? { FFPROBE: which.ffprobe } : {}) };
  const data = await (async () => {
    try {
      await mkdir(dataDir, { recursive: true });
      const probeFile = join(dataDir, `.write-check-${process.pid}`);
      await writeFile(probeFile, "ok");
      await unlink(probeFile);
      return { ok: true, detail: dataDir };
    } catch (err) {
      return { ok: false, detail: `${dataDir}: ${(err as Error).message}` };
    }
  })();
  const choice = await chooseFfmpeg({ dataDir, comfyDirs: o.comfyDirs ?? [], env, fresh: o.fresh });
  const words = wordsOf(choice);
  const nodeOk = atLeast(process.version, NODE_LEAST);
  const checks: Check[] = [
    { id: "node", label: "Node", ok: nodeOk, detail: nodeOk ? process.version : `${process.version} is older than ${NODE_LEAST}`, without: "Afflatus may fail in ways that are hard to read.", fix: `Install Node ${NODE_LEAST} or newer.` },
    { id: "ffmpeg", label: "ffmpeg", without: "Trims, exports, joins, slow motion and the audio seam repair fail; videos get no preview frame.", ...words.ffmpeg },
    { id: "ffprobe", label: "ffprobe", without: "Videos are filed without their length, size and sound, and cannot be trimmed or exported.", ...words.ffprobe },
    { id: "data", label: "Data folder", ok: data.ok, detail: data.detail, without: "Nothing can be saved.", fix: "Make the folder writable, or set DATA_DIR to one that is." },
  ];
  return { at: new Date().toISOString(), checks, ok: checks.every((c) => c.ok), ffmpeg: choice };
}

/** The last preflight, for the health route; `run` makes a new one and logs what it found. */
export const preflight = {
  last: null as Preflight | null,
  dataDir: "",
  /** ComfyUI's folders on this computer, read from the settings once the database is open (start.ts). */
  comfyDirs: async (): Promise<string[]> => [],
  /** `fresh`: every ffmpeg tried again (Check again, after Get ffmpeg). The ffmpeg chosen is used from then on. */
  async run(dataDir?: string, opts: { fresh?: boolean } = {}): Promise<Preflight> {
    const dir = dataDir ?? preflight.dataDir;
    preflight.dataDir = dir;
    const comfyDirs = await preflight.comfyDirs().catch(() => []);
    const p = await runPreflight(dir, {}, { comfyDirs, fresh: opts.fresh });
    preflight.last = p;
    const used = p.ffmpeg.used;
    if (used) chooseTools(used.ffmpeg, used.ffprobe, toolSaid(p.ffmpeg));
    for (const c of p.checks) console[c.ok && !c.note ? "log" : "warn"](`[check] ${c.label}: ${c.ok ? `${c.detail}${c.note ? `. ${c.note}` : ""}` : `${c.detail}. ${c.without} ${c.fix}`}`);
    return p;
  },
};
