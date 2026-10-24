import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { environment } from "./config";
import { countFrames, cutArgs, ffRun, inTemp } from "./cut";
import { writeAtomic } from "./updatesModel";

/**
 * Which ffmpeg Afflatus uses, and whether it can do what Afflatus asks of it. Running is not enough: an old ffmpeg on the PATH
 * ran, then cut a join's run-up a frame short ("The frames to join onto could not be cut from that clip", Nicolas, 2026-10-24),
 * and the bundles' LGPL build ran, then had no libx264 for any cut, join or export. So each one found is tried as Afflatus
 * uses it: its version against a minimum, the encoders it is asked for, and one real cut of a small clip it makes itself, its
 * frames counted. The first that passes is used, in this order: FFMPEG / FFPROBE when the person set them (theirs only: never
 * swapped for another, a failure said instead), the PATH's, the one Get ffmpeg put in the data folder, ComfyUI's own
 * (imageio-ffmpeg, a recent static build, in its Python), a bundle's.
 */

/**
 * The oldest ffmpeg Afflatus takes. Measured 2026-10-24 by running the server's 80 real-ffmpeg tests (cuts, ranges, joins,
 * transitions, exports in pieces) with FFMPEG set to each of gyan.dev's builds: 4.4 failed 7, 5.1.2 5, 6.0 4 (an export's
 * clock and sound); 6.1.1, 8.0.1 and 8.1.2 one (a range kept, read a hair differently from just before it), BtbN's 9.0.2 none.
 * 7.0.2 and 7.1 are newer and worse (a join's run-up miscounted): the test cut below refuses them, not the version.
 */
export const FFMPEG_LEAST = "6.1";

/** Where an ffmpeg was found, as said after its version: "ffmpeg 7.1 (ComfyUI's)". */
export type Where = "set" | "path" | "got" | "comfy" | "bundle";
const WHERE_SAID: Record<Where, string> = { set: "FFMPEG", path: "PATH", got: "Get ffmpeg's", comfy: "ComfyUI's", bundle: "Afflatus's bundle" };
/** The same, inside a sentence: "on your PATH", "ComfyUI's". */
const WHERE_IN: Record<Where, string> = { set: "set in FFMPEG", path: "on your PATH", got: "from Get ffmpeg", comfy: "in ComfyUI's Python", bundle: "in a bundle" };
/** The same, before "ffmpeg": "using ComfyUI's ffmpeg 7.1 instead". */
const WHERE_OWN: Record<Where, string> = { set: "FFMPEG's", path: "the PATH's", got: "Get ffmpeg's", comfy: "ComfyUI's", bundle: "the bundle's" };

export interface Candidate {
  ffmpeg: string;
  ffprobe: string;
  where: Where;
}

export interface Tried extends Candidate {
  ok: boolean;
  /** ffmpeg's version as its first line says it ("7.1", "n9.0.2-17-g2a571b6068-20260930"); null when it could not be run. */
  version: string | null;
  probeVersion: string | null;
  /** Why it was refused, in a few words: "is older than 7.0", "has no libx264 encoder", "cut 21 frames where 22 were asked". */
  why: string | null;
}

export interface Choice {
  /** The one in use: the first that passed, else the first found (its failure said). */
  used: Tried | null;
  /** Those tried before it and refused. */
  refused: Tried[];
  /** FFMPEG set by the person: theirs is the only one. */
  pinned: boolean;
}

/** "ffmpeg 7.1 (ComfyUI's)": the ffmpeg as the person reads it. */
export const said = (t: Tried) => `ffmpeg ${shortVersion(t.version) ?? "?"} (${WHERE_SAID[t.where]})`;
/** "ffmpeg 4.4 on your PATH". */
export const saidIn = (t: Tried) => `ffmpeg ${shortVersion(t.version) ?? ""} ${WHERE_IN[t.where]}`.replace(/\s+/g, " ");

/** "n9.0.2-17-g2a571b6068-20260930" → "9.0.2", "7.1-essentials_build-www.gyan.dev" → "7.1", a nightly's "N-112345-g…" as it is. */
export function shortVersion(v: string | null): string | null {
  if (!v) return null;
  return /^n?(\d+(?:\.\d+)*)/.exec(v)?.[1] ?? v;
}

/** Whether a version is the minimum or newer. A build that names no version number (a nightly, "N-112345-g…") is taken as new. */
export function newEnough(version: string, least = FFMPEG_LEAST): boolean {
  const m = /^n?(\d+(?:\.\d+)*)/.exec(version);
  if (!m) return true;
  const a = m[1]!.split(".").map(Number);
  const b = least.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]!;
  }
  return true;
}

/**
 * How long each of the check's own runs may take, and the whole of one candidate. The check runs before the server listens,
 * and an update's --check of a new version has two minutes (updatesInstall.ts): a hanging ffmpeg given a job's timeouts (two
 * minutes a frame count) held the start about six minutes per candidate. A good one takes about a second in all.
 */
export const CHECK_TIMEOUTS = { version: 10_000, encoders: 10_000, clip: 20_000, cut: 20_000, count: 15_000, candidate: 45_000 };

/** A tool's version from its first line of `-version`; null when it could not be run. */
async function versionOf(tool: string, signal?: AbortSignal): Promise<{ version: string | null; missing: boolean }> {
  const r = await ffRun(tool, ["-version"], { timeout: CHECK_TIMEOUTS.version, signal });
  if (r.err) return { version: null, missing: r.missing };
  const first = r.stdout.split(/\r?\n/)[0]?.trim() ?? "";
  return { version: /version\s+(\S+)/i.exec(first)?.[1] ?? (first || "?"), missing: false };
}

/** The encoders every cut, join and export asks for (cut.ts, exportJoin.ts). */
const ENCODERS = ["libx264", "aac"];
/**
 * The join's run-up the test cuts: the last 22 frames of a 2 s clip at 25 fps, at 24 and at 16 fps. Each catches a build that
 * runs and miscounts: ComfyUI's 7.1 (imageio-ffmpeg) cuts 21 at 24 fps, 7.0.2 cuts 34 at 16 fps (measured 2026-10-24; 4.4 to
 * 6.1 and 8.0 to 9.0 cut 22 at both).
 */
const TEST = { seconds: 2, sourceFps: 25, rates: [24, 16], count: 22 };

/**
 * One ffmpeg and ffprobe tried as Afflatus uses them: about a second, most of it the two small encodes. The version first (an
 * old one is refused without the rest), then the encoders, then the cut, its frames counted by the ffprobe that goes with it.
 */
export async function tryTools(c: Candidate): Promise<Tried> {
  // each run has its own bound, and all of them together the candidate's: one that hangs at every step is still left in time
  const signal = AbortSignal.timeout(CHECK_TIMEOUTS.candidate);
  const [mpeg, probe] = await Promise.all([versionOf(c.ffmpeg, signal), versionOf(c.ffprobe, signal)]);
  const out = (why: string | null): Tried => ({ ...c, ok: why === null, version: mpeg.version, probeVersion: probe.version, why });
  if (!mpeg.version) return out(mpeg.missing ? "was not found" : "could not be run");
  if (!probe.version) return out(probe.missing ? "has no ffprobe beside it" : "has an ffprobe that could not be run");
  if (!newEnough(mpeg.version)) return out(`is older than ${FFMPEG_LEAST}`);
  if (!newEnough(probe.version)) return out(`has an ffprobe older than ${FFMPEG_LEAST} (${shortVersion(probe.version)})`);
  const listed = await ffRun(c.ffmpeg, ["-hide_banner", "-encoders"], { timeout: CHECK_TIMEOUTS.encoders, signal });
  const lacking = ENCODERS.filter((e) => !new RegExp(`^\\s*\\S+\\s+${e}\\s`, "m").test(listed.stdout));
  if (lacking.length) return out(`has no ${lacking.join(" or ")} encoder`);
  return out(await inTemp(async (dir) => {
    const clip = join(dir, "clip.mp4");
    const made = await ffRun(c.ffmpeg, [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=64x48:rate=${TEST.sourceFps}:duration=${TEST.seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${TEST.seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
    ], { timeout: CHECK_TIMEOUTS.clip, signal });
    if (made.err) return `could not make a test clip (${lastLine(made.stderr)})`;
    for (const fps of TEST.rates) {
      const cut = join(dir, `cut-${fps}.mp4`);
      const start = TEST.seconds * fps - TEST.count;
      const ran = await ffRun(c.ffmpeg, cutArgs(clip, cut, { fps, start, count: TEST.count, hasSound: true }), { timeout: CHECK_TIMEOUTS.cut, signal });
      if (ran.err) return `could not cut frames (${lastLine(ran.stderr)})`;
      const got = await countFrames(cut, c.ffprobe, { timeout: CHECK_TIMEOUTS.count, signal }).catch(() => -1);
      if (got < 0) return "has an ffprobe that could not count the frames";
      if (got !== TEST.count) return `cut ${got} frames where ${TEST.count} were asked (at ${fps} fps)`;
    }
    return null;
  }));
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).pop()?.slice(0, 160) || "no reason given";

// ---------------------------------------------------------------- where to look

const exe = (name: string, platform: string) => (platform === "win32" ? `${name}.exe` : name);

/** A program on the PATH, as the system would find it: its full path, or null. `skip`: folders passed over. */
export function onPath(name: string, env: NodeJS.ProcessEnv = environment(), platform = process.platform, skip?: (dir: string) => boolean): string | null {
  const path = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  for (const dir of path.split(platform === "win32" ? ";" : delimiter)) {
    if (!dir.trim()) continue;
    const folder = dir.trim().replace(/^"|"$/g, "");
    if (skip?.(folder)) continue;
    const file = join(folder, exe(name, platform));
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Whether a folder is a bundle's own bin/ (<AFFLATUS_ROOT>/versions/<v>/bin, in a bundle run): what is there is the bundle's
 * ffmpeg, not one the person chose. The launcher puts that folder first on the PATH, and up to 0.6.1 it also set FFMPEG and
 * FFPROBE to it (an older version's launcher still does, after a Go back): read as set by the person, the bundle's ffmpeg was
 * never swapped for another and Get ffmpeg never offered.
 */
export function inBundleBin(dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  const root = env.AFFLATUS_ROOT?.trim();
  if (env.AFFLATUS_INSTALL !== "bundle" || !root) return false;
  const rel = relative(join(resolve(root), "versions"), resolve(dir));
  const parts = (platform === "win32" ? rel.toLowerCase() : rel).split(/[\\/]/);
  return parts.length === 2 && !!parts[0] && parts[0] !== ".." && parts[1] === "bin";
}

/** A tool as FFMPEG or FFPROBE names it, found on the PATH when it is a bare name ("ffmpeg"); null when it is not there. */
function located(tool: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (tool.includes("/") || tool.includes("\\")) return tool;
  return onPath(platform === "win32" ? tool.replace(/\.exe$/i, "") : tool, env, platform);
}

/** The FFMPEG and FFPROBE the person set; those a bundle's launcher set to its own bin/ are not theirs (inBundleBin). */
export function setByPerson(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { ffmpeg: string | null; ffprobe: string | null } {
  const theirs = (value: string | undefined) => {
    const tool = value?.trim();
    if (!tool) return null;
    const at = located(tool, env, platform);
    return at && inBundleBin(dirname(at), env, platform) ? null : tool;
  };
  return { ffmpeg: theirs(env.FFMPEG), ffprobe: theirs(env.FFPROBE) };
}

/** The folder Get ffmpeg downloads into: the data folder's bin/. */
export const gotDir = (dataDir: string) => join(dataDir, "bin");

/**
 * The ffmpeg in a ComfyUI's Python, from imageio-ffmpeg (which ComfyUI's video nodes bring): a static build named with its
 * version (ffmpeg-win-x86_64-v7.1.exe, ffmpeg-linux-x86_64-v7.0.2). Looked for in the venv beside ComfyUI (venv, .venv) and
 * in the Windows portable build's python_embeded, beside the ComfyUI folder.
 */
export async function comfyFfmpegs(comfyDir: string, platform = process.platform): Promise<string[]> {
  const dir = comfyDir.trim();
  if (!dir) return [];
  const sites: string[] = [];
  for (const base of [join(dir, "venv"), join(dir, ".venv"), join(dir, "..", "python_embeded"), join(dir, "python_embeded")]) {
    if (platform === "win32") sites.push(join(base, "Lib", "site-packages"));
    else {
      const lib = join(base, "lib");
      for (const py of await readdir(lib).catch(() => [] as string[])) if (/^python3/.test(py)) sites.push(join(lib, py, "site-packages"));
    }
  }
  const found: string[] = [];
  for (const site of sites) {
    const bins = join(site, "imageio_ffmpeg", "binaries");
    for (const f of await readdir(bins).catch(() => [] as string[])) {
      if (/^ffmpeg-/i.test(f) && (platform === "win32" ? /\.exe$/i.test(f) : !/\.(exe|txt|md|py)$/i.test(f))) found.push(join(bins, f));
    }
  }
  return found;
}

/**
 * A bundle's ffmpeg, newest version first (versions/<v>/bin, under AFFLATUS_ROOT): the one of the version running is found
 * first on the PATH already; the others are tried last.
 */
async function bundleFfmpegs(root: string | undefined, platform: string): Promise<string[]> {
  if (!root) return [];
  const versions = join(root, "versions");
  const names = (await readdir(versions).catch(() => [] as string[])).filter((v) => /^v?\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return names.map((v) => join(versions, v, "bin", exe("ffmpeg", platform))).filter((f) => existsSync(f));
}

export interface LookIn {
  dataDir: string;
  /** ComfyUI's folders on this computer (Settings › ComfyUI's folder, each machine's). */
  comfyDirs: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Every ffmpeg worth trying, in order, each with the ffprobe that goes with it: the one beside it, else the one set in FFPROBE,
 * else Get ffmpeg's or the PATH's (imageio-ffmpeg ships no ffprobe). FFMPEG set: that one alone. In a bundle its own bin/ is
 * first on the PATH (the launcher puts it there): the ffmpeg found there is said as the bundle's, and the next one on the PATH
 * is tried after it as the PATH's.
 */
export async function candidates(o: LookIn): Promise<Candidate[]> {
  const env = o.env ?? environment();
  const platform = o.platform ?? process.platform;
  const { ffmpeg: setMpeg, ffprobe: setProbe } = setByPerson(env, platform);
  const got = gotDir(o.dataDir);
  const gotProbe = join(got, exe("ffprobe", platform));
  const pathProbe = onPath("ffprobe", env, platform);
  const probeFor = (ffmpeg: string) => {
    if (setProbe) return setProbe;
    const beside = join(dirname(ffmpeg), exe("ffprobe", platform));
    if (ffmpeg.includes("/") || ffmpeg.includes("\\")) if (existsSync(beside)) return beside;
    // Get ffmpeg's before the PATH's: it is the known build, put there because what was found did not pass, and the PATH's
    // may be the old one that did not
    return existsSync(gotProbe) ? gotProbe : pathProbe ?? "ffprobe";
  };
  if (setMpeg) return [{ ffmpeg: setMpeg, ffprobe: probeFor(setMpeg), where: "set" }];
  const list: Candidate[] = [];
  const add = (ffmpeg: string | null, where: Where) => {
    if (ffmpeg && !list.some((c) => c.ffmpeg.toLowerCase() === ffmpeg.toLowerCase())) list.push({ ffmpeg, ffprobe: probeFor(ffmpeg), where });
  };
  const first = onPath("ffmpeg", env, platform);
  if (first && inBundleBin(dirname(first), env, platform)) {
    add(first, "bundle");
    add(onPath("ffmpeg", env, platform, (dir) => inBundleBin(dir, env, platform)), "path");
  } else add(first, "path");
  const gotMpeg = join(got, exe("ffmpeg", platform));
  if (existsSync(gotMpeg)) add(gotMpeg, "got");
  for (const dir of o.comfyDirs) for (const f of await comfyFfmpegs(dir, platform)) add(f, "comfy");
  for (const f of await bundleFfmpegs(env.AFFLATUS_ROOT, platform)) add(f, "bundle");
  return list;
}

// ---------------------------------------------------------------- choosing, kept between starts

/**
 * What a tool file is now: its path, size and time, so that a result kept for it is used only while it is the same file. A bare
 * name (FFMPEG=ffmpeg) is stamped as the file the PATH gives for it: stamped as the name alone, another ffmpeg put on the PATH
 * would reuse the verdict kept for the one before.
 */
function stamp(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const at = located(file, env, platform) ?? file;
  try {
    const st = statSync(at);
    return `${at}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    return `${at}|-`;
  }
}

const keptFile = (dataDir: string) => join(dataDir, "ffmpeg-check.json");

/**
 * What the check asks, put in each kept result's key: a later release that raises the minimum or changes the test cut tries
 * again an ffmpeg kept as "ok" by this one, rather than trusting a pass to a test it never took.
 */
const CHECK_ID = `${FFMPEG_LEAST}/${TEST.seconds}s${TEST.sourceFps}:${TEST.count}@${TEST.rates.join("+")}`;

/**
 * The results kept from an earlier start. The file can be empty or cut short (a crash, a full disk): read as nothing kept, so
 * the start tries the candidates again rather than failing on it.
 */
async function readKept(dataDir: string): Promise<Record<string, Tried>> {
  try {
    const kept: unknown = JSON.parse(await readFile(keptFile(dataDir), "utf8"));
    return kept && typeof kept === "object" && !Array.isArray(kept) ? (kept as Record<string, Tried>) : {};
  } catch {
    return {};
  }
}

/**
 * The ffmpeg to use: the candidates tried in order until one passes. A result kept from an earlier start is used again while
 * its two files have not changed (a new ffmpeg on the PATH, FFMPEG pointed elsewhere, a Get ffmpeg: tried anew); `fresh`
 * (Settings › About's Check again) tries them all again.
 */
export async function chooseFfmpeg(o: LookIn & { fresh?: boolean; tryOne?: (c: Candidate) => Promise<Tried> }): Promise<Choice> {
  const env = o.env ?? environment();
  const platform = o.platform ?? process.platform;
  const pinned = !!setByPerson(env, platform).ffmpeg;
  const list = await candidates(o);
  const tryOne = o.tryOne ?? tryTools;
  // no data folder named (a check asked before the start named one): nothing kept, nothing read, rather than files in the working folder
  const keeps = !!o.dataDir.trim();
  const kept: Record<string, Tried> = o.fresh || !keeps ? {} : await readKept(o.dataDir);
  const keep: Record<string, Tried> = {};
  const refused: Tried[] = [];
  let used: Tried | null = null;
  for (const c of list) {
    const key = `${CHECK_ID}>${stamp(c.ffmpeg, env, platform)}>${stamp(c.ffprobe, env, platform)}`;
    const before = kept[key];
    const t = before && before.ffmpeg === c.ffmpeg && before.where === c.where ? before : await tryOne(c);
    keep[key] = t;
    if (t.ok) {
      used = t;
      break;
    }
    refused.push(t);
  }
  // none passed: the first is said with its failure (theirs, when FFMPEG is set), the others with theirs
  if (!used && refused.length) used = refused.shift()!;
  // written whole or not at all, each write through a file of its own: Check again and Get ffmpeg's own check can write it
  // at the same time, the last one renamed is what is kept
  if (keeps) await writeAtomic(keptFile(o.dataDir), JSON.stringify(keep, null, 1)).catch(() => {});
  return { used, refused, pinned };
}

/** Get ffmpeg can put one in the data folder here (BtbN builds Windows and Linux x64 only); on macOS, Homebrew's line. */
export function getterOn(platform = process.platform, arch = process.arch): "download" | "brew" | null {
  if (platform === "darwin") return "brew";
  if ((platform === "win32" || platform === "linux") && arch === "x64") return "download";
  return null;
}

export const BREW_LINE = "brew install ffmpeg";

/** The ffmpeg and ffprobe checks as Settings › About and the banners say them (preflight.ts's Check). */
export function wordsOf(choice: Choice, platform = process.platform): {
  ffmpeg: { ok: boolean; detail: string; fix: string; note?: string; get?: "download" | "brew" };
  ffprobe: { ok: boolean; detail: string; fix: string };
} {
  const u = choice.used;
  const get = choice.pinned ? null : getterOn(platform);
  const how = get === "brew" ? `Run ${BREW_LINE}` : get === "download" ? "Get ffmpeg downloads one into Afflatus's data folder; or install it" : "Install it";
  const fix = choice.pinned
    ? `FFMPEG is set to ${u?.ffmpeg ?? "?"}: point it to ffmpeg ${FFMPEG_LEAST} or newer, or take it out so that Afflatus finds one.`
    : `${how} (${FFMPEG_LEAST} or newer, with libx264) and have it on the PATH, or set FFMPEG to its path.`;
  if (!u) {
    return {
      ffmpeg: { ok: false, detail: "not found on this computer", fix, ...(get ? { get } : {}) },
      ffprobe: { ok: false, detail: "not found on this computer", fix: "It comes with ffmpeg; or set FFPROBE to its path." },
    };
  }
  const first = choice.refused[0];
  const note = u.ok && first ? `${saidIn(first)} ${first.why}: using ${WHERE_OWN[u.where]} ffmpeg ${shortVersion(u.version)} instead.` : undefined;
  // ffprobe is said wrong only when it is what failed: an ffmpeg refused for itself leaves a good ffprobe good
  const probeFailed = !u.probeVersion || (!u.ok && /ffprobe/.test(u.why ?? ""));
  const probeFix = "It comes with ffmpeg; or set FFPROBE to its path.";
  return {
    ffmpeg: u.ok
      ? { ok: true, detail: `${shortVersion(u.version)} (${WHERE_SAID[u.where]})`, fix, ...(note ? { note } : {}) }
      : { ok: false, detail: `${u.version ? shortVersion(u.version) : u.ffmpeg} (${WHERE_SAID[u.where]}) ${u.why}`, fix, ...(get ? { get } : {}) },
    ffprobe: u.probeVersion
      ? { ok: !probeFailed, detail: probeFailed ? `${shortVersion(u.probeVersion)}: ${u.why}` : shortVersion(u.probeVersion)!, fix: probeFix }
      : { ok: false, detail: `"${u.ffprobe}" was not found on this computer`, fix: probeFix },
  };
}

/** The ffmpeg for the cut messages (video.ts toolsSaid): "ffmpeg 4.4 (PATH)". */
export const toolSaid = (choice: Choice) => (choice.used ? said(choice.used) : null);
