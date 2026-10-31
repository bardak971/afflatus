import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { envSaid } from "./config";

/**
 * What Afflatus reads from a video when it files it: its size, length, speed, whether it has sound, and
 * one frame to show in grids. This needs ffmpeg and ffprobe (on PATH, or named by FFMPEG and FFPROBE).
 * Without them everything still works: videos are stored and played, their tiles just have no picture.
 */
export const tools = { ffmpeg: envSaid.ffmpeg()?.trim() || "ffmpeg", ffprobe: envSaid.ffprobe()?.trim() || "ffprobe" };

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

/**
 * The containers a file from a stranger may be read as (an upload, MCP's import_from_url, a workflow fetched from an
 * address): videos and sounds, by ffmpeg's demuxer names. Lists of other files (HLS, DASH, concat, an image sequence),
 * lavfi and the rest are refused before anything is opened: with only `file` allowed, a DASH or HLS manifest still opened
 * files elsewhere on the disk, and a frame of one would have come back into the library.
 */
const STRANGER_FORMATS = "mov,mp4,matroska,webm,avi,mpegts,mpeg,flv,ogg,wav,w64,aiff,mp3,flac,aac,asf";

/**
 * The containers browsers' recorders make (webm, ogg, mp4), and WAV: what a take recorded from the microphone is read as.
 * Its body is not probed before it is turned into the WAV the models are given (cut.ts recordingWav).
 */
const RECORDING_FORMATS = "matroska,webm,ogg,mov,mp4,wav";

/**
 * The containers a file kept by Afflatus may be read as, whatever brought it in: a stranger's videos and sounds, the
 * pictures (PNG, JPEG, WebP: their own demuxers, or image2, which reads the one picture named), and ComfyUI's moving
 * takes (GIF, APNG, animated WebP: `webp_anim` on recent builds). Only an upload is probed as a stranger's file: a ComfyUI
 * or pod take, a linked folder's file is kept as it comes, and an `.mp4` that is a DASH manifest or an ffconcat list had
 * every other run read the file it names, elsewhere on the disk. ffmpeg picks the demuxer first, by the content and the
 * name, and refuses it after when it is not listed: the list changes what is refused, never what a file is read as.
 */
const STORED_FORMATS = `${STRANGER_FORMATS},png_pipe,jpeg_pipe,webp_pipe,image2,gif,apng,webp_anim`;

/**
 * Where the file a run reads comes from, and so the containers it may be read as:
 * - `stranger`: a file not yet kept, as it arrived (an upload's probe, MCP's import_from_url, a linked folder's file);
 * - `recording`: a take from the browser's microphone, never probed before it is read;
 * - `stored`: any file Afflatus keeps (a library video, a picture, a ComfyUI or pod take, a sound), and the files it makes
 *   from them (a cut, a WAV, an export's piece). Every run is held to it unless it says otherwise (localInputs).
 * Afflatus's own lists and sources (an export's concat list, lavfi's silence) name their format with `-f`: such an input is
 * read as that format and held to no list.
 */
export type Origin = "stranger" | "recording" | "stored";
export const READ_AS: Record<Origin, string> = { stranger: STRANGER_FORMATS, recording: RECORDING_FORMATS, stored: STORED_FORMATS };

/** The options of each input of a run, from the end of the input before (or the start) to its `-i`, by the index of that `-i`. */
function inputOptions(args: string[], at: number): string[] {
  let from = at;
  while (from > 0 && args[from - 1] !== "-i") from--;
  // past the input before's file, when there is one
  return args.slice(from === 0 ? 0 : from + 1, at);
}

/**
 * A run's arguments with every input it reads held to the containers of `origin`: before each `-i` of ffmpeg, first for
 * ffprobe, whose input is its last argument. An input that names its format (`-f concat`, `-f lavfi`) is left as it is, and
 * so is one already held to a list.
 */
export function readAs(origin: Origin, args: string[]): string[] {
  const only = ["-format_whitelist", READ_AS[origin]];
  const free = (opts: string[]) => !opts.includes("-f") && !opts.includes("-format_whitelist");
  if (!args.includes("-i")) return free(args) ? [...only, ...args] : args;
  return args.flatMap((a, k) => (a === "-i" && free(inputOptions(args, k)) ? [...only, a] : [a]));
}

/**
 * A run's arguments with every input it reads limited to files and pipes, and held to the containers of a kept file unless
 * the run held it to others (readAs). A file from a stranger can be a playlist naming other addresses (a web address on the
 * LAN, a service on this machine) that ffmpeg would otherwise go and read, or other files on the disk. Every run of
 * ffmpeg and ffprobe goes through here (cut.ts ffRun, `run` below).
 */
export function localInputs(args: string[]): string[] {
  const only = ["-protocol_whitelist", "file,pipe"];
  const held = readAs("stored", args);
  return held.includes("-i") ? held.flatMap((a) => (a === "-i" ? [...only, a] : [a])) : [...only, ...held];
}

/** The major version in ffmpeg's `-version` line ("ffmpeg version 9.0.2-full_build…" → 9); null when it names none (a nightly names a commit, "N-112345-g…"). */
export function majorOf(line: string): number | null {
  const m = /version\s+n?(\d+)\./i.exec(line);
  return m ? Number(m[1]) : null;
}

let major: Promise<number | null> | null = null;
/** The major version of the ffmpeg in use, asked once; null when it could not be run or names none. */
export function ffmpegMajor(): Promise<number | null> {
  major ??= new Promise((done) => {
    execFile(tools.ffmpeg, ["-version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }, (err, stdout) => done(err ? null : majorOf(String(stdout).split(/\r?\n/)[0] ?? "")));
  });
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
}

const warned = new Set<string>();
/** How long a tool may take on one video. */
const RUN_MS = 30_000;

/** What a tool gave: its output, or why there is none, said so that a person can act on it. */
export type Ran = { out: string | Buffer; why?: undefined } | { out: null; why: string };

/**
 * Run a tool: its output, or why it gave none. Not installed, out of time and a refusal of the file are three different
 * fixes, so each is said as itself (a refusal with the end of what the tool wrote). A missing tool is logged once, not per video.
 */
function run(tool: string, args: string[], encoding: "utf8" | "buffer"): Promise<Ran> {
  return new Promise((done) => {
    execFile(tool, localInputs(args), { encoding, timeout: RUN_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true } as never, (err, stdout, stderr) => {
      if (!err) return done({ out: stdout as string | Buffer });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: string | number };
      if (e.code === "ENOENT") {
        if (!warned.has(tool)) {
          warned.add(tool);
          console.warn(`[video] "${tool}" was not found: videos get no preview frame and no length. Install ffmpeg, or set FFMPEG and FFPROBE.`);
        }
        return done({ out: null, why: `"${tool}" was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE.` });
      }
      if (e.killed || e.signal) return done({ out: null, why: `"${basename(tool)}" took more than ${RUN_MS / 1000} s on this video and was stopped.` });
      // the last lines it wrote, without the temporary file's path and the demuxer's address ("[mov,mp4 @ 0x…]"): the reason
      let said = String(stderr ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
      for (const a of args) if (isAbsolute(a)) said = said.split(a).join("the file");
      said = said.replace(/\[[^\]]*@ (0x)?[0-9a-f]+\]\s*/gi, "").slice(0, 300);
      done({ out: null, why: `"${basename(tool)}" could not read this video (exit code ${e.code ?? "?"})${said ? `: ${said}` : "."}` });
    });
  });
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
  const dir = await mkdtemp(join(tmpdir(), "afflatus-video-"));
  const file = join(dir, `in.${ext}`);
  try {
    await writeFile(file, bytes);
    return await read(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

/** The same, with why there are none when there are none (ffprobe missing, out of time, the file refused, no picture in it). */
export async function probeVideo(file: string): Promise<{ facts: VideoFacts | null; why?: string }> {
  const probed = await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file], "utf8");
  if (probed.out === null) return { facts: null, why: probed.why };
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

/** The facts read out of ffprobe's answer (probeMediaFile in cut.ts asks ffprobe once and reads them from the same answer). */
export function factsOf(info: ProbeInfo): VideoFacts | null {
  const picture = info.streams?.find((s) => s.codec_type === "video");
  if (!picture) return null;
  return {
    width: Number(picture.width) || 0,
    height: Number(picture.height) || 0,
    durationMs: Math.round(Number(info.format?.duration ?? 0) * 1000),
    fps: rate(picture.avg_frame_rate),
    hasSound: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
  };
}

/** The first frame of a video file, as a PNG; null when ffmpeg is not there or could not read it. */
export async function firstFrame(file: string): Promise<Uint8Array | null> {
  const out = join(dirname(file), `${basename(file)}.frame.png`);
  const made = await run(tools.ffmpeg, readAs("stranger", ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", out]), "utf8");
  const frame = made.out === null ? null : await readFile(out).then((b) => new Uint8Array(b), () => null);
  await rm(out, { force: true }).catch(() => {});
  return frame;
}
