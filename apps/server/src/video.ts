import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { FfmpegMissing, ffRun, grabFrame, inTemp, tools } from "./ff";

/**
 * What Afflatus reads from a video when it files it: its size, length, speed, whether it has sound, and
 * one frame to show in grids. This needs ffmpeg and ffprobe (on PATH, or named by FFMPEG and FFPROBE: ff.ts tools).
 * Without them everything still works: videos are stored and played, their tiles just have no picture.
 */
// the tools in use are ff.ts's, where every run is made; named here too, where the files that read videos have always taken them
export { tools };

/**
 * The ffmpeg in use as the person reads it, with its version and where it was found ("ffmpeg 9.0.2 (PATH)"): set by the start-up
 * check (ffmpegCheck.ts), which may choose another than the PATH's; until then, its path.
 */
export const toolsSaid = { ffmpeg: null as string | null };
export const ffmpegSaid = () => toolsSaid.ffmpeg ?? `ffmpeg (${tools.ffmpeg})`;

/** Another ffmpeg chosen (ffmpegCheck.ts): it is used from now on, and its version asked again. */
export function chooseTools(ffmpeg: string, ffprobe: string, said: string | null): void {
  if (tools.ffmpeg !== ffmpeg) major = null;
  tools.ffmpeg = ffmpeg;
  tools.ffprobe = ffprobe;
  toolsSaid.ffmpeg = said;
}

/** The major version in ffmpeg's `-version` line ("ffmpeg version 9.0.2-full_build…" → 9); null when it names none (a nightly names a commit, "N-112345-g…"). */
export function majorOf(line: string): number | null {
  const m = /version\s+n?(\d+)\./i.exec(line);
  return m ? Number(m[1]) : null;
}

let major: Promise<number | null> | null = null;
/** The major version of the ffmpeg in use, asked once; null when it could not be run or names none. */
export function ffmpegMajor(): Promise<number | null> {
  major ??= ffRun(tools.ffmpeg, ["-version"], { timeout: 10_000, readsNothing: true }).then((r) => (r.err ? null : majorOf(r.stdout.split(/\r?\n/)[0] ?? "")));
  return major;
}

/**
 * The option that reads a filter graph from a file: `-/filter_complex` since ffmpeg 7, `-filter_complex_script` before
 * (deprecated in 7, gone by 9). A build that names no version is taken as recent: nightlies are.
 */
export async function graphFileOption(): Promise<string> {
  const m = await ffmpegMajor();
  return m !== null && m < 7 ? "-filter_complex_script" : "-/filter_complex";
}

export interface VideoFacts {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasSound: boolean;
  /** The file's own length, its longest stream's: what a video was stored with before its picture's was read (card #207). */
  fileMs?: number;
}

const warned = new Set<string>();
/** A missing tool is logged once, not per video: everything still works without it, the tiles just have no picture. */
function warnMissing(tool: string): void {
  if (warned.has(tool)) return;
  warned.add(tool);
  console.warn(`[video] "${tool}" was not found: videos get no preview frame and no length. Install ffmpeg, or set FFMPEG and FFPROBE.`);
}

/**
 * How long a tool may take on one video: a quarter of a cut's two minutes (ff.ts must), on purpose. What is read here can
 * be done without (the video is stored and played all the same) and is read again the first time it is asked for, so a
 * file that holds the tool up is given up on soon rather than holding up the filing of a take.
 */
const RUN_MS = 30_000;

/** What a tool gave: its output, or why there is none, said so that a person can act on it. */
export type Ran = { out: string | Buffer; why?: undefined } | { out: null; why: string; passing?: true };

/**
 * Run a tool: its output, or why it gave none. Not installed, out of time and a refusal of the file are three different
 * fixes, so each is said as itself (a refusal with the end of what the tool wrote). Its own words rather than failureOf's
 * (ff.ts): what is said here is kept beside the video as why it has no facts, so it names the tool and leaves the
 * temporary file's path out, and a missing tool or one out of time is `passing` (asked again later, the file may answer).
 */
async function run(tool: string, args: string[]): Promise<Ran> {
  const r = await ffRun(tool, args, { timeout: RUN_MS, maxBuffer: 64 * 1024 * 1024 });
  if (!r.err) return { out: r.stdout };
  if (r.missing) {
    warnMissing(tool);
    return { out: null, why: `"${tool}" was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE.`, passing: true };
  }
  if (r.err.killed || r.err.signal) return { out: null, why: `"${basename(tool)}" took more than ${RUN_MS / 1000} s on this video and was stopped.`, passing: true };
  // the last lines it wrote, without the temporary file's path and the demuxer's address ("[mov,mp4 @ 0x…]"): the reason
  let said = r.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
  for (const a of args) if (isAbsolute(a)) said = said.split(a).join("the file");
  said = said.replace(/\[[^\]]*@ (0x)?[0-9a-f]+\]\s*/gi, "").slice(0, 300);
  return { out: null, why: `"${basename(tool)}" could not read this video (exit code ${r.err.code ?? "?"})${said ? `: ${said}` : "."}` };
}

/** "16/1", "30000/1001" → frames per second. */
function rate(text: unknown): number {
  const [n, d] = String(text ?? "").split("/").map(Number);
  return n && d ? Math.round((n / d) * 1000) / 1000 : 0;
}

/** What is read of a video: its facts and its first frame, either null when it could not be read; `why`: why the facts could not be. */
export interface VideoRead {
  facts: VideoFacts | null;
  frame: Uint8Array | null;
  why?: string;
}

/** The facts and the first frame (a PNG) of a video. Either is null when it could not be read. */
export function readVideo(bytes: Uint8Array, ext: string): Promise<VideoRead> {
  return inVideoFile(bytes, ext, readVideoFile);
}

/** `read` given a video held in memory, written to a temporary file for it and removed after. */
export async function inVideoFile<T>(bytes: Uint8Array, ext: string, read: (file: string) => Promise<T>): Promise<T> {
  // both tools need a file they can seek in: an MP4 keeps its index at the end
  return inTemp(async (dir) => {
    const file = join(dir, `in.${ext}`);
    await writeFile(file, bytes);
    return read(file);
  }, "video");
}

/** The same for a video that is a file on this machine already (an upload written as it arrived). */
export async function readVideoFile(file: string): Promise<VideoRead> {
  const probed = await probeVideo(file);
  return { facts: probed.facts, frame: await firstFrame(file), ...(probed.why ? { why: probed.why } : {}) };
}

/** What ffprobe says of a video file: its size, length, speed and whether it has sound. Null when it could not be read. */
export async function videoFacts(file: string): Promise<VideoFacts | null> {
  return (await probeVideo(file)).facts;
}

/**
 * The same, with why there are none when there are none (ffprobe missing, out of time, the file refused, no picture in it).
 * `passing`: none for want of the tool or of time, not for the file's sake: asked again later, the file may answer.
 */
export async function probeVideo(file: string): Promise<{ facts: VideoFacts | null; why?: string; passing?: true }> {
  const probed = await run(tools.ffprobe, ["-v", "error", "-show_entries", FACT_ENTRIES, "-of", "json", file]);
  if (probed.out === null) return { facts: null, why: probed.why, ...(probed.passing ? { passing: true as const } : {}) };
  try {
    const facts = factsOf(JSON.parse(String(probed.out)) as ProbeInfo);
    return facts ? { facts } : { facts: null, why: "ffprobe found no picture in this file." };
  } catch {
    // an answer that is not JSON is no answer
    return { facts: null, why: "ffprobe gave an answer that could not be read." };
  }
}

/** The shape of ffprobe's JSON answer, as far as the facts need it. */
export interface ProbeInfo {
  streams?: Array<Record<string, unknown>>;
  format?: { duration?: string };
}

/** What ffprobe is asked of a video's streams and its file for its facts (probeMediaFile asks the same, with more). */
const FACT_ENTRIES = "stream=codec_type,width,height,avg_frame_rate,duration:stream_tags=DURATION:format=duration";

/** "00:00:05.146000000" (Matroska's tag) → seconds; NaN when it is not that. */
const clockSeconds = (text: unknown) => {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(text ?? "").trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};

/**
 * How long a video's picture lasts, in milliseconds: its video stream's own length (an MP4's, or a WebM's DURATION tag),
 * the file's only when the stream says none. The file's is its longest stream's: a pod's ComfyUI muxed the smoothed
 * render with its sound padded 35–113 ms past the last frame, and the clip after was handed over that much past the
 * picture, its last frame held there with the sound gone at every join (card #207).
 */
export function pictureMs(picture: Record<string, unknown>, info: ProbeInfo): number {
  const own = Number(picture.duration);
  const tagged = clockSeconds((picture.tags as Record<string, unknown> | undefined)?.DURATION);
  const seconds = own > 0 ? own : tagged > 0 ? tagged : Number(info.format?.duration ?? 0);
  return Math.round(seconds * 1000) || 0;
}

/** The facts read out of ffprobe's answer (probeMediaFile in cut.ts asks ffprobe once and reads them from the same answer). */
export function factsOf(info: ProbeInfo): VideoFacts | null {
  const picture = info.streams?.find((s) => s.codec_type === "video");
  if (!picture) return null;
  return {
    width: Number(picture.width) || 0,
    height: Number(picture.height) || 0,
    durationMs: pictureMs(picture, info),
    fps: rate(picture.avg_frame_rate),
    hasSound: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
    fileMs: Math.round(Number(info.format?.duration ?? 0) * 1000) || 0,
  };
}

/**
 * The first frame of a video file, as a PNG; null when ffmpeg is not there or could not read it. Read as a stranger's file
 * (an upload not yet kept is read here), within the facts' time limit (RUN_MS).
 */
export async function firstFrame(file: string): Promise<Uint8Array | null> {
  const out = join(dirname(file), `${basename(file)}.frame.png`);
  const frame = await grabFrame(file, out, { origin: "stranger", timeout: RUN_MS }).catch((err: unknown) => {
    if (err instanceof FfmpegMissing) warnMissing(tools.ffmpeg);
    return null;
  });
  await rm(out, { force: true }).catch(() => {});
  return frame;
}
