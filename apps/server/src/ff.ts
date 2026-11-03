import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envSaid } from "./config";
import { ffmpegPool } from "./pool";

/**
 * How ffmpeg and ffprobe are run, in one place: which ones (tools), what a run may read (localInputs), the run itself
 * (ffRun, must) and how it says it failed (failureOf), the temporary folder it works in (inTemp), and the calls several
 * files make alike (streamKinds, grabFrame). Reading a video's facts is video.ts, cutting one cut.ts, measuring one
 * measure.ts: each runs ffmpeg through here, and each keeps its own time limits and what a failure means to it.
 */

/**
 * The ffmpeg and ffprobe in use: on PATH, or named by FFMPEG and FFPROBE. Another may be chosen at start-up (video.ts
 * chooseTools, from ffmpegCheck.ts): this object is changed in place, so every file reads the one chosen.
 */
export const tools = { ffmpeg: envSaid.ffmpeg()?.trim() || "ffmpeg", ffprobe: envSaid.ffprobe()?.trim() || "ffprobe" };

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
 * ffmpeg and ffprobe that reads a file goes through here (ffRun).
 */
export function localInputs(args: string[]): string[] {
  const only = ["-protocol_whitelist", "file,pipe"];
  const held = readAs("stored", args);
  return held.includes("-i") ? held.flatMap((a) => (a === "-i" ? [...only, a] : [a])) : [...only, ...held];
}

/** A run of ffmpeg that did not give its result, said in words the person can act on (a 400 to a request). */
export class CutError extends Error {
  statusCode = 400;
}
/** ffmpeg is not there at all: said as it is, never taken for a file it could not read. */
export class FfmpegMissing extends CutError {}

/** ffmpeg (or ffprobe) not found, in words the person can act on: one text wherever a run finds it missing. */
export const missing = () => new FfmpegMissing("This needs ffmpeg, which was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE.");

/** Why a run of ffmpeg ended without its result, as the user reads it. */
export function failureOf(err: ExecFileException, stderr: unknown, timeout: number): CutError {
  if (err.code === "ENOENT") return missing();
  if (err.name === "AbortError") return new CutError("stopped by you");
  // killed at its time limit: said as such (as video.ts does), never as a file it could not read
  if (err.killed || err.signal) return new CutError(`ffmpeg took more than ${Math.round(timeout / 1000)} s on this file and was stopped`);
  const last = String(stderr ?? "").trim().split(/\r?\n/).pop() ?? "";
  return new CutError(`ffmpeg could not read or write the file${last ? `: ${last.slice(0, 300)}` : ""}`);
}

/**
 * What a run of ffmpeg or ffprobe gave, however it ended: its output, its log (stderr), the error it ended on (null: it went
 * to the end), and whether that error is the tool not being there at all. Each caller reads what it needs of it: a missing
 * tool is never taken for a file the tool could not read.
 */
interface Ran<T extends string | Buffer> {
  stdout: T;
  stderr: string;
  err: ExecFileException | null;
  missing: boolean;
}
interface RunOptions {
  timeout: number;
  signal?: AbortSignal;
  /** Where it runs: a filter graph that writes files names them there (a Windows path in a filter's options needs escaping). */
  cwd?: string;
  /** Left out: Node's own limit. */
  maxBuffer?: number;
  /**
   * A run that opens no file at all (`-version`): its arguments are passed as they are. Held to local inputs, it was
   * handed input options it has no input for, which ffmpeg warns about.
   */
  readsNothing?: true;
}

/** One run of a tool, its window hidden and its local inputs read as files (localInputs); it never rejects (see Ran). */
export function ffRun(tool: string, args: string[], opts: RunOptions & { encoding: "buffer" }): Promise<Ran<Buffer>>;
export function ffRun(tool: string, args: string[], opts: RunOptions): Promise<Ran<string>>;
export function ffRun(tool: string, args: string[], opts: RunOptions & { encoding?: "buffer" }): Promise<Ran<string | Buffer>> {
  return new Promise((done) => {
    execFile(tool, opts.readsNothing ? args : localInputs(args), {
      encoding: opts.encoding ?? "utf8", timeout: opts.timeout, windowsHide: true,
      ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }, (err, stdout, stderr) => done({ stdout, stderr: String(stderr ?? ""), err, missing: err?.code === "ENOENT" }));
  });
}

/** A run that must succeed: its output, or why it failed as the user reads it (failureOf). */
export async function must(tool: string, args: string[], opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<string> {
  const timeout = opts.timeout ?? 120_000;
  const r = await ffRun(tool, args, { timeout, maxBuffer: 16 * 1024 * 1024, signal: opts.signal });
  if (r.err) throw failureOf(r.err, r.stderr, timeout);
  return r.stdout;
}

/** A temporary folder of its own (`afflatus-<what>-…`), for a caller that removes it itself (cut.ts markedVideoFile). */
export const tempDir = (what = "cut") => mkdtemp(join(tmpdir(), `afflatus-${what}-`));

/**
 * `work` given a temporary folder of its own, removed after however it ended. A folder that cannot be removed (a file still
 * held open on Windows) does not fail the work that is done: it is left to the system's own clearing of its temp folder.
 */
export async function inTemp<T>(work: (dir: string) => Promise<T>, what = "cut"): Promise<T> {
  const dir = await tempDir(what);
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One stream of a file as ffprobe lists it: its kind ("video", "audio", "subtitle"…) and its length in seconds (NaN when it says none). */
export interface StreamKind {
  kind: string;
  seconds: number;
}

/**
 * The streams of a file, in order, as ffprobe lists them. It throws as `must` does (FfmpegMissing when ffprobe is not
 * there, CutError when the file cannot be read): what that means is each caller's to say, and each says it where it calls.
 */
export async function streamKinds(file: string): Promise<StreamKind[]> {
  const said = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", file]);
  return said.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [kind, seconds] = l.split(",");
    return { kind: kind ?? "", seconds: Number(seconds) };
  });
}

/** Whether a file's streams (streamKinds) include one of `kind`. */
export const hasStream = (streams: StreamKind[], kind: "video" | "audio") => streams.some((s) => s.kind === kind);

/** How grabFrame takes its frame. */
export interface FrameWanted {
  /** The moment, in milliseconds, seeked to before the file is opened. Left out: the first frame, no seek at all. */
  atMs?: number;
  /** The last frame instead, read from half a second before the end. */
  last?: boolean;
  /** Scaled to this height, its width following. */
  height?: number;
  /** A JPEG's quality (ffmpeg's -q:v, 2 is best). */
  q?: number;
  /** The containers the file may be read as (readAs); left out, a kept file's (localInputs). */
  origin?: Origin;
  /** Left out: `must`'s two minutes. */
  timeout?: number;
  /** Ahead of the pool's other work (ffmpegPool's `first`): a screen waits on it. */
  first?: boolean;
}

/**
 * One frame of a video file, written to `out` (a PNG or a JPEG, by its name) and read back; null when ffmpeg wrote none
 * (a moment past the last frame). It throws as `must` does when ffmpeg fails. A run in the ffmpeg pool, as every frame a
 * request asks for: a caller already in the pool (filmStrip's, peekAt's) runs it in its own place.
 */
export async function grabFrame(input: string, out: string, want: FrameWanted = {}): Promise<Uint8Array | null> {
  const seek = want.last ? ["-sseof", "-0.5"] : want.atMs !== undefined ? ["-ss", (Math.max(0, want.atMs) / 1000).toFixed(3)] : [];
  const args = [
    "-y", "-loglevel", "error", ...seek, "-i", input,
    // the last frame: every frame of the last half second written over the one before (-update), the last one kept
    ...(want.last ? [] : ["-frames:v", "1"]),
    ...(want.height ? ["-vf", `scale=-2:${want.height}`] : []), ...(want.q !== undefined ? ["-q:v", String(want.q)] : []),
    ...(want.last ? ["-update", "1"] : []), out,
  ];
  await ffmpegPool(() => must(tools.ffmpeg, want.origin ? readAs(want.origin, args) : args, want.timeout ? { timeout: want.timeout } : {}), want.first ? { first: true } : {});
  const bytes = await readFile(out).catch(() => null);
  return bytes?.length ? new Uint8Array(bytes) : null;
}
