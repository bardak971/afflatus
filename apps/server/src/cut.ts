import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { FRAME_SLACK_MS } from "@afflatus/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsOf, ffmpegMajor, ffmpegSaid, localInputs, tools, type ProbeInfo, type VideoFacts } from "./video";
import { ffmpegPool } from "./pool";
import { aiVideoArgs } from "./aiMark";

/**
 * Cutting videos: the few frames a new clip joins onto, one frame as a picture, a strip of frames for
 * the timeline, a range kept, a sound taken out or slowed. Measuring them is measure.ts, a join's jump joinScore.ts and
 * a timeline as one file exportJoin.ts, all run through this file's ffmpeg runs (ffRun, must). Unlike reading a video's
 * facts (video.ts), these cannot be skipped when ffmpeg is missing: the error says so in words the person can act on.
 */
export class CutError extends Error {
  statusCode = 400;
}
/** ffmpeg is not there at all: said as it is, never taken for a file it could not read. */
export class FfmpegMissing extends CutError {}

/**
 * A video or a sound as ffmpeg is handed it: a file on this machine's disk (its path, read where it is), or its bytes
 * (written to a temporary file first). A stored file is passed by path when the storage has one (sourceOf, storage.ts):
 * an export or a join then holds no whole video in memory.
 */
export type Media = string | Uint8Array;

/** The file ffmpeg reads `source` from: its own path, or its bytes written into `dir` as `name`. */
export async function onDisk(dir: string, name: string, source: Media): Promise<string> {
  if (typeof source === "string") return source;
  const file = join(dir, name);
  await writeFile(file, source);
  return file;
}

/**
 * How long a run that reads a whole video may take, from the video's length: a re-encode at crf 10 of a 10-minute 1080p
 * import takes more than the usual two minutes on many CPUs, and was stopped half way. Two minutes, and ten times the
 * length on top, at most three hours (as a slow motion or an export). A length not known: the usual two minutes.
 */
export const forLength = (durationMs: number | null | undefined): number => Math.min(3 * 60 * 60_000, 120_000 + 10 * Math.max(0, Number(durationMs) || 0));

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
}

/** One run of a tool, its window hidden and its local inputs read as files (localInputs); it never rejects (see Ran). */
export function ffRun(tool: string, args: string[], opts: RunOptions & { encoding: "buffer" }): Promise<Ran<Buffer>>;
export function ffRun(tool: string, args: string[], opts: RunOptions): Promise<Ran<string>>;
export function ffRun(tool: string, args: string[], opts: RunOptions & { encoding?: "buffer" }): Promise<Ran<string | Buffer>> {
  return new Promise((done) => {
    execFile(tool, localInputs(args), {
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

/** How the encoder times the frames it is handed, by the option this ffmpeg reads (`-fps_mode` since 6, `-vsync` before). */
export async function fpsMode(mode: "passthrough" | "vfr"): Promise<string[]> {
  return [((await ffmpegMajor()) ?? 99) < 6 ? "-vsync" : "-fps_mode", mode];
}

export async function inTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "afflatus-cut-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * How many pictures a video holds, each one decoded and counted by ffprobe (`probe`: the one in use, unless one is being tried).
 * `opts` bounds the run: the start-up check counts a 22-frame clip and gives a hanging ffprobe seconds, not a job's two minutes.
 */
export const countFrames = async (file: string, probe = tools.ffprobe, opts: { timeout?: number; signal?: AbortSignal } = {}) =>
  Number((await must(probe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], opts)).trim()) || 0;

/**
 * The run that cuts the frames a join carries on from (cutFrames): `count` frames from `start`, at `fps`, with their sound when
 * there is some, encoded as a join's run-up is. The start-up check (ffmpegCheck.ts) runs this same one on a clip of its own.
 */
export function cutArgs(input: string, out: string, o: { fps: number; start: number; count: number; hasSound: boolean }): string[] {
  const { fps, start, count } = o;
  return [
    "-y", "-loglevel", "error", "-i", input,
    "-vf", `fps=${fps},trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    ...(o.hasSound ? ["-af", `atrim=start=${start / fps}:end=${(start + count) / fps},asetpts=PTS-STARTPTS`, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", out,
  ];
}

export interface ProbedMedia {
  kind: "video" | "audio";
  mime: string;
  durationMs: number;
  /** Of a video: its size, speed and sound, read from the same answer of ffprobe. */
  facts: VideoFacts | null;
}

/** ffmpeg's formats that are lists of other files: HLS, DASH, its own concat list. */
const LISTS = new Set(["hls", "applehttp", "dash", "concat"]);

/**
 * What a file brought in from the computer is, read from the disk (an upload written as it arrived): a video or a
 * sound, in which container, and how long; null when ffprobe is not installed or the file is neither. One run of
 * ffprobe says everything.
 */
export async function probeMediaFile(file: string): Promise<ProbedMedia | null> {
  const out = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate:format=format_name,duration", "-of", "json", file]).catch(() => null);
  if (!out) return null;
  try {
    const info = JSON.parse(out) as { streams?: Array<{ codec_type?: string; codec_name?: string }>; format?: { format_name?: string; duration?: string } };
    const names = (info.format?.format_name ?? "").split(",");
    // a playlist or a list of files is not a file of its own: what it names is read from elsewhere on the disk
    if (names.some((n) => LISTS.has(n))) return null;
    // a picture is a "video" of one frame to ffprobe: only moving pictures count here
    const video = info.streams?.some((s) => s.codec_type === "video" && !["mjpeg", "png", "webp", "bmp", "gif"].includes(s.codec_name ?? ""));
    const audio = info.streams?.some((s) => s.codec_type === "audio");
    if (!video && !audio) return null;
    const has = (n: string) => names.includes(n);
    const mime = video
      ? has("webm") || has("matroska") ? "video/webm" : "video/mp4"
      : has("wav") ? "audio/wav" : has("mp3") ? "audio/mpeg" : has("flac") ? "audio/flac" : has("ogg") ? "audio/ogg" : has("mp4") || has("m4a") || has("mov") ? "audio/mp4" : null;
    if (!mime) return null;
    return { kind: video ? "video" : "audio", mime, durationMs: Math.round(Number(info.format?.duration ?? 0) * 1000), facts: video ? factsOf(info as ProbeInfo) : null };
  } catch {
    return null;
  }
}

/**
 * A video of a person as a reference for a video model: its first seconds at the model's speed, small
 * (a reference is read at every step: a small one costs less), and whether its sound is more than
 * silence, in which case it can stand for the person's voice.
 */
export async function referenceClip(source: Media, ext: string, opts: { seconds: number; fps: number; short: number; start?: number }): Promise<{ bytes: Uint8Array; hasSound: boolean; width: number; height: number; frames: number }> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "ref.mp4");
    const streams = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input]);
    const audio = /audio/.test(streams);
    // `start`: from there rather than from the start (a source video's part, a swap)
    const from = opts.start ? ["-ss", opts.start.toFixed(3)] : [];
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...from, "-i", input, "-t", String(opts.seconds),
      "-vf", `fps=${opts.fps},scale='if(lt(iw,ih),min(${opts.short},iw),-2)':'if(lt(iw,ih),-2,min(${opts.short},ih))',setsar=1`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"] : ["-an"]),
      out,
    ]);
    // a sound track that is silence is no voice: how loud it gets is read from ffmpeg's own report
    let hasSound = false;
    if (audio) {
      const report = (await ffRun(tools.ffmpeg, ["-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-"], { timeout: 60_000 })).stderr;
      hasSound = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(report)?.[1] ?? -99) > -45;
    }
    const size = (await must(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out])).trim().split(",").map(Number);
    return { bytes: new Uint8Array(await readFile(out)), hasSound, width: size[0] || 0, height: size[1] || 0, frames: await countFrames(out) };
  });
}

export interface FramesWanted {
  /** How many frames, best first: the first count the video is long enough for is cut. */
  counts: number[];
  fps: number;
  /** "before": the frames that end at the moment; "after": the ones that start at it. */
  side: "before" | "after";
  /** The moment, in milliseconds. Left out: the end of the video for "before", its start for "after". */
  at?: number;
  /** A Stop on the job that wants them: ffmpeg is stopped with it. */
  signal?: AbortSignal;
}

/**
 * A few frames of a video as a small video of their own, with their sound: what a new clip is given of
 * the clip it carries on from (its last frames) or arrives at (its first ones).
 */
export async function cutFrames(
  source: Media, ext: string, facts: { durationMs: number; hasSound: boolean }, want: FramesWanted,
): Promise<{ bytes: Uint8Array; frames: number }> {
  const { fps, counts } = want;
  const total = Math.floor((facts.durationMs / 1000) * fps + 0.01);
  const moment = (ms: number) => Math.max(0, Math.min(total, Math.round((ms / 1000) * fps)));
  const edge = want.side === "before" ? (want.at === undefined ? total : moment(want.at)) : want.at === undefined ? 0 : moment(want.at);
  const room = want.side === "before" ? edge : total - edge;
  const fits = counts.find((c) => c <= room);
  if (!fits) throw new CutError(`That clip is too short to join onto there: it has ${room} frames, and at least ${Math.min(...counts)} are needed.`);
  let count = fits;
  let start = want.side === "before" ? edge - count : edge;

  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "cut.mp4");
    // the last frame a length promises is not always there (a file's length is its sound's when that runs longer): when the
    // cut comes out short, the frames before a moment are taken one frame earlier. The frames after one keep their start,
    // the moment the clip after is landed on (its latent is cut there too, finishLatent): the next count is cut instead
    for (let attempt = 0; ; attempt++) {
      await must(tools.ffmpeg, cutArgs(input, out, { fps, start, count, hasSound: facts.hasSound }), { signal: want.signal });
      const got = await countFrames(out);
      if (got === count) break;
      const fewer = want.side === "after" ? counts.find((c) => c < count) : undefined;
      // the ffmpeg that cut them is named, with what it gave: an old one miscounts (Nicolas's, 2026-10-24), a newer one does not
      if (attempt >= 2 || (want.side === "after" ? !fewer : start === 0)) {
        throw new CutError(`The frames to join onto could not be cut from that clip: ${ffmpegSaid()} cut ${got} where ${count} were asked. A newer ffmpeg may cut them: see Settings › About.`);
      }
      if (fewer) count = fewer;
      else start--;
    }
    return { bytes: new Uint8Array(await readFile(out)), frames: count };
  });
}

/** One frame of a video as a PNG. A moment at or past the end gives the last frame. */
export async function frameAt(source: Media, ext: string, atMs: number, durationMs?: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "frame.png");
    const tries = [atMs, ...(durationMs ? [durationMs - 60, durationMs - 150] : []), 0].map((ms) => Math.max(0, ms));
    for (const ms of tries) {
      await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", (ms / 1000).toFixed(3), "-i", input, "-frames:v", "1", out]);
      const bytes = await readFile(out).catch(() => null);
      if (bytes?.length) return new Uint8Array(bytes);
    }
    throw new CutError("No picture could be taken from that moment of the video.");
  });
}

/** How many frames a strip holds, and how tall they are. */
export const STRIP = { frames: 12, height: 72 };

/**
 * The last frame held a place longer, ahead of a strip's `fps`: its last place falls a step before the end, and `fps` gives
 * the frame for a place only once a later one comes, so at the end of the file it gave none and `tile` left it black (every
 * strip, seen as a black last cell on a wide clip, 2026-10-15).
 */
export const heldLast = (every: number) => `tpad=stop_mode=clone:stop_duration=${every.toFixed(4)},`;

/** Past this long, a strip shows the keyframe at or before each of its moments (see filmStrip). */
export const KEYFRAME_STRIP_MS = 60_000;

/**
 * Frames of a video side by side in one picture (a JPEG), spread evenly over its length: what a clip shows on the timeline.
 * Of a stretch longer than a minute (a long source on the source lane), each picture is the keyframe at or before its
 * moment, the others not decoded at all: a 5-minute 1080p source took 5–7 s decoded whole, 0.8 s by its keyframes, and
 * a strip that small does not show the difference of a second or two. A run in the ffmpeg pool.
 */
export async function filmStrip(source: Media, ext: string, durationMs: number, opts: { frames?: number; height?: number; /** Only this part of the video, in milliseconds. */ fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> {
  const frames = Math.max(2, Math.min(120, Math.round(opts.frames ?? STRIP.frames)));
  const height = Math.max(24, Math.min(240, Math.round(opts.height ?? STRIP.height)));
  const from = Math.max(0, Math.min(opts.fromMs ?? 0, durationMs));
  const to = Math.max(from + FRAME_SLACK_MS, Math.min(opts.toMs ?? durationMs, durationMs));
  const keys = to - from > KEYFRAME_STRIP_MS ? ["-skip_frame", "nokey"] : [];
  return ffmpegPool(() => inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "strip.jpg");
    const every = Math.max(0.01, (to - from) / 1000 / frames);
    // the keyframes alone reach the frame grid each in the place after its own (moved on by one place, a hair short), so
    // that each place shows the last keyframe at or before its moment
    const keyed = keys.length ? `setpts=PTS+${(every - 0.001).toFixed(4)}/TB,` : "";
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...keys, ...(from > 0 ? ["-ss", (from / 1000).toFixed(3)] : []), "-to", (to / 1000).toFixed(3), "-i", input,
      "-vf", `${keyed}${heldLast(every)}fps=1/${every.toFixed(4)}:start_time=0:round=down,scale=-2:${height},tile=${frames}x1`,
      "-frames:v", "1", "-q:v", "5", out,
    ]);
    return new Uint8Array(await readFile(out));
  }));
}

/** One small picture of a moment, as a JPEG: what a hover over the trim bar shows. A run in the ffmpeg pool, ahead of what only decorates a screen. */
export async function peekAt(source: Media, ext: string, atMs: number, height = 160): Promise<Uint8Array> {
  return ffmpegPool(() => inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "peek.jpg");
    const scale = `scale=-2:${Math.max(48, Math.min(480, height))}`;
    const seeked = await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", (Math.max(0, atMs) / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-vf", scale, "-q:v", "4", out]).then(() => true, () => false);
    let bytes = seeked ? await readFile(out).catch(() => null) : null;
    // a moment inside the last frame (a clip's end, asked for by its length) seeks past every frame: the last one is taken instead
    if (!bytes?.length) {
      await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-sseof", "-0.5", "-i", input, "-vf", scale, "-q:v", "4", "-update", "1", out]);
      bytes = await readFile(out).catch(() => null);
    }
    if (!bytes?.length) throw new CutError("No picture could be taken from that moment of the video.");
    return new Uint8Array(bytes);
  }), { first: true });
}

/**
 * The moments of a video's keyframes near `moments` (milliseconds): where a stream copy can start and end without
 * re-encoding. Only a short stretch around each moment is read (ffprobe's read intervals, from the keyframe before it):
 * read whole, a 2-minute 1080p source was read through (515 MB) before every cut of one part, to ask about two moments.
 */
async function keyframesNear(file: string, moments: number[]): Promise<number[]> {
  if (!moments.length) return [];
  const around = moments.map((ms) => `${Math.max(0, ms / 1000 - 0.05).toFixed(3)}%${(ms / 1000 + 0.05).toFixed(3)}`).join(",");
  const out = await must(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-read_intervals", around, "-show_entries", "frame=pts_time", "-of", "csv=p=0", file]).catch(() => "");
  return out.split(/\r?\n/).map((l) => Number(l.split(",")[0])).filter((n) => Number.isFinite(n)).map((s) => Math.round(s * 1000));
}

/** A file a cut made, read whole: for a caller that hands its bytes on (an upload to ComfyUI). */
const bytesOf = async (file: string) => new Uint8Array(await readFile(file));

/**
 * How the picture of a part of a video from `fromMs` to `toMs` is read for a re-encode: from a whole second at least a
 * second before it (an input seek: ffmpeg decodes from the keyframe before that, not from the file's start) and only a
 * second past its end. `at` gives a moment of the part on the clock of what is read, as `trim` takes it. A range at 100 s
 * of a 2-minute 1080p source decoded the 100 s before it: 78 CPU-s against 35 from the seek, and a copy of its first
 * minute decoded the minute after it too. The frames are the same: the seek is to a whole second, which every time base
 * of a file counts exactly, so that every frame's moment moves by exactly as much as `trim`'s bounds do. Not the sound:
 * AAC fills some bands with noise from a generator that runs on from the first frame decoded, so its samples come out
 * a little otherwise from another start (see rangeKeep).
 */
export function readFor(fromMs: number, toMs: number): { args: string[]; at: (ms: number) => string } {
  const from = fromMs >= 2000 ? Math.floor(fromMs / 1000) - 1 : 0;
  const length = Math.ceil(toMs / 1000) + 1 - from;
  // the bound said to the millisecond as before, then moved by whole seconds: the same moment, never rounded otherwise
  const at = (ms: number) => ((Math.round(Number(sec(ms)) * 1000) - from * 1000) / 1000).toFixed(3);
  return { args: [...(from > 0 ? ["-ss", String(from)] : []), "-t", String(length)], at };
}

/**
 * The parts of a video that are kept, one after the other, as one MP4: a range copied (one part), a range
 * removed (the part before and the part after), one piece of a split (one part). One part whose bounds
 * fall on keyframes (or the file's ends) is copied without re-encoding: instant and lossless. Anything
 * else is cut to the frame and encoded again at `crf`. The sound follows the picture. The file made is handed to `use`
 * where it lies (stored from there, it is never held whole in memory: a 10 s removal from a 2-minute 1080p source made
 * 1.7 GB at crf 10); left out, its bytes are answered.
 */
export async function rangeKeep<T = Uint8Array>(
  source: Media, ext: string, facts: { durationMs: number; hasSound: boolean; soundOnly?: boolean }, keep: Array<[number, number]>,
  opts: { crf?: number; even?: boolean; signal?: AbortSignal } = {}, use: (file: string) => Promise<T> = bytesOf as (file: string) => Promise<T>,
): Promise<T> {
  const parts = keep.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(facts.durationMs, Math.max(a, b))] as [number, number]).filter(([a, b]) => b - a >= 20);
  if (!parts.length) throw new CutError("That range is too short to keep: nothing would be left.");
  const crf = Math.max(0, Math.min(40, Math.round(opts.crf ?? 10)));
  // a run may read the source from its start (a sound, an early part): its time limit grows with the source's length, and the job's Stop still ends it
  const run = { timeout: forLength(facts.durationMs), signal: opts.signal };
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    // a sound: its parts cut to the millisecond and joined as a WAV (nothing lost to an encoder), its loudness evened out when asked (EBU R128, -16 LUFS)
    if (facts.soundOnly) {
      const wav = join(dir, "kept.wav");
      const chains = parts.map(([a, b], i) => `[0:a]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]`);
      const joined = `${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1${opts.even ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : ""}[a]`;
      await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-filter_complex", [...chains, joined].join(";"), "-map", "[a]", "-ar", "48000", "-c:a", "pcm_s16le", wav], run);
      return use(wav);
    }
    const out = join(dir, "kept.mp4");
    // one part on keyframes: a stream copy
    if (parts.length === 1 && /^(mp4|mov|m4v)$/i.test(ext)) {
      const [a, b] = parts[0]!;
      const ends = [...(a > 0 ? [a] : []), ...(b < facts.durationMs - 2 ? [b] : [])];
      const keys = await keyframesNear(input, ends);
      if (ends.every((ms) => keys.some((k) => Math.abs(k - ms) <= 2))) {
        await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", sec(a), "-to", sec(b), "-i", input, "-c", "copy", "-movflags", "+faststart", out], run);
        return use(out);
      }
    }
    // cut to the frame and joined, encoded again: each part's picture read from its own opening of the file, from just
    // before it; the sound from one more opening, from the start as before (its decoding is cheap, and the picture's packets
    // are passed over unread), up to a second past the last part
    const reads = parts.map(([a, b]) => readFor(a, b));
    const sound = parts.length;
    const soundArgs = facts.hasSound ? ["-discard:v", "all", "-t", String(Math.ceil(Math.max(...parts.map(([, b]) => b)) / 1000) + 1), "-i", input] : [];
    const chains = parts.map(([a, b], i) => {
      const { at } = reads[i]!;
      return `[${i}:v]trim=start=${at(a)}:end=${at(b)},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2[v${i}]` + (facts.hasSound ? `;[${sound}:a]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]` : "");
    });
    const concat = parts.map((_, i) => `[v${i}]${facts.hasSound ? `[a${i}]` : ""}`).join("") + `concat=n=${parts.length}:v=1:a=${facts.hasSound ? 1 : 0}[v]${facts.hasSound ? "[a]" : ""}`;
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...reads.flatMap((r) => [...r.args, "-i", input]), ...soundArgs,
      "-filter_complex", [...chains, concat].join(";"),
      "-map", "[v]", ...(facts.hasSound ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
    ], run);
    return use(out);
  });
}

export const sec = (ms: number) => (ms / 1000).toFixed(3);

/** The sound slowed by `factor` with its pitch kept: atempo takes 0.5 at a time. */
const slowTempo = (factor: number) => Array.from({ length: Math.round(Math.log2(factor)) }, () => "atempo=0.5").join(",");

/**
 * A range of a video slowed down by `factor`, the frames in between worked out by ffmpeg's motion
 * interpolation (the fallback when there is no RIFE on the GPU): the same frame rate, `factor` times as
 * many frames, the sound slowed with its pitch kept. Slow: minutes for a few seconds. The file is handed to `use` as
 * rangeKeep's is.
 */
export async function slowMotion<T = Uint8Array>(
  source: Media, ext: string, facts: { durationMs: number; fps: number | null; hasSound: boolean }, startMs: number, endMs: number, factor: number,
  opts: { crf?: number; signal?: AbortSignal } = {}, use: (file: string) => Promise<T> = bytesOf as (file: string) => Promise<T>,
): Promise<T> {
  const fps = Math.max(1, Math.round(facts.fps ?? 24));
  const a = Math.max(0, Math.min(startMs, endMs));
  const b = Math.min(facts.durationMs, Math.max(startMs, endMs));
  if (b - a < FRAME_SLACK_MS) throw new CutError("That range is too short: pick at least one frame.");
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "slow.mp4");
    const video = `[0:v]setpts=${factor}*PTS,minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,scale=trunc(iw/2)*2:trunc(ih/2)*2[v]`;
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", "-ss", (a / 1000).toFixed(3), "-t", ((b - a) / 1000).toFixed(3), "-i", input,
      "-filter_complex", facts.hasSound ? `${video};[0:a]${slowTempo(factor)}[a]` : video,
      "-map", "[v]", ...(facts.hasSound ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(opts.crf ?? 16), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
    ], { timeout: 3 * 60 * 60_000, signal: opts.signal });
    return use(out);
  });
}

/** A slowed video (silent, as RIFE hands it back) given the sound of the range it came from, slowed to match with its pitch kept. */
export async function slowSoundOnto(slowed: Uint8Array, range: Media, factor: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const v = join(dir, "slow.mp4");
    const out = join(dir, "with-sound.mp4");
    await writeFile(v, slowed);
    const r = await onDisk(dir, "range.mp4", range);
    const streams = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", r]).catch(() => "");
    if (!/audio/.test(streams)) return slowed;
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", "-i", v, "-i", r,
      "-filter_complex", `[1:a]${slowTempo(factor)}[a]`, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out,
    ], { timeout: 10 * 60_000 });
    return new Uint8Array(await readFile(out));
  });
}

/**
 * The sound of a video as a sound file of its own (AAC in an .m4a). `durationMs`: the video's length, for its time limit.
 * The file is handed to `use` as rangeKeep's is.
 */
export async function soundOf<T = Uint8Array>(source: Media, ext: string, durationMs?: number | null, use: (file: string) => Promise<T> = bytesOf as (file: string) => Promise<T>): Promise<T> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "sound.m4a");
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", out], { timeout: forLength(durationMs) });
    return use(out);
  });
}

/** The codecs the WebM muxer takes: anything else in a file filed as video/webm is a matroska of another kind (an imported .mkv). */
const WEBM_CODECS = new Set(["vp8", "vp9", "av1", "opus", "vorbis", "webvtt"]);

/**
 * The container a stream copy of a "webm" file is written in. The library files every matroska as video/webm, and the
 * WebM muxer refuses what WebM does not hold (an H.264 .mkv's picture, its AAC): such a copy is written as matroska,
 * the kind of file it came from, under the same name and type. `streams`: the streams the copy keeps ("v" or all).
 */
async function webmCopyFormat(input: string, streams?: "v"): Promise<string[]> {
  const said = await must(tools.ffprobe, ["-v", "error", ...(streams ? ["-select_streams", streams] : []), "-show_entries", "stream=codec_name", "-of", "csv=p=0", input]).catch(() => "");
  const codecs = said.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return codecs.every((c) => WEBM_CODECS.has(c)) ? ["-f", "webm"] : ["-f", "matroska"];
}

/**
 * The same video without its sound: the picture copied as it is, nothing encoded again. `durationMs`: its length, for the
 * time limit. The file is handed to `use` as rangeKeep's is.
 */
export async function silentOf<T = Uint8Array>(source: Media, ext: string, durationMs?: number | null, use: (file: string) => Promise<T> = bytesOf as (file: string) => Promise<T>): Promise<T> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, `silent.${ext}`);
    const format = ext === "webm" ? await webmCopyFormat(input, "v") : ["-movflags", "+faststart"];
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-map", "0:v", "-c", "copy", "-an", ...format, out], { timeout: forLength(durationMs) });
    return use(out);
  });
}

/**
 * The same video marked as made by a model (aiMark.ts): every stream copied as it is, frames and timestamps untouched,
 * only the container's comment added. An editor counts the same frames in it as in the library's file. Written to a
 * temporary file and handed over there (`file`, `size`), never read into memory: a 2 GB render downloaded whole that way
 * held ~3.8 GB. `done` removes it, once whoever reads it is through. A run in the ffmpeg pool, as the other cuts a
 * request asks for.
 */
export async function markedVideoFile(source: Media, ext: string): Promise<{ file: string; size: number; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "afflatus-cut-"));
  // retried a little: on Windows the stream that read it may still hold it for a moment after its last chunk
  const done = () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  try {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, `marked.${ext}`);
    const format = ext === "webm" ? await webmCopyFormat(input) : ["-movflags", "+faststart"];
    await ffmpegPool(() => must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-map", "0", "-c", "copy", "-map_metadata", "0", ...aiVideoArgs, ...format, out], { timeout: 10 * 60_000 }));
    // the bytes handed in (a file not on this machine's disk) are let go of: only the marked copy is read from here on
    if (input !== source) await rm(input, { force: true }).catch(() => {});
    return { file: out, size: (await stat(out)).size, done };
  } catch (err) {
    await done();
    throw err;
  }
}

/** The part of a sound that is used, given how long the sound is: see soundPart. */
export function partOf(start: number, seconds: number, total: number | null): { start: number; seconds: number } {
  if (total === null) return { start: Math.max(0, start), seconds };
  const from = Math.max(0, Math.min(start, total - 2));
  return { start: from, seconds: Math.max(0.1, Math.min(seconds, total - from)) };
}

/**
 * The part of a sound as it was asked (a sound cue: a clap of half a second, its part from 0.3 s), the start never moved back
 * for two seconds after it as partOf does for a voice; it ends where the sound ends when that comes first.
 */
export function exactPart(start: number, seconds: number, total: number | null): { start: number; seconds: number } {
  if (total === null) return { start: Math.max(0, start), seconds };
  const from = Math.max(0, Math.min(start, total - 0.05));
  return { start: from, seconds: Math.max(0.05, Math.min(seconds, total - from)) };
}

/**
 * A part of a sound (or of a video's sound) as a sound of its own: from `start` seconds, `seconds` long.
 * The start is where it was asked, as long as two seconds are left after it; the part ends where the
 * sound ends when that comes first. `even` evens out its loudness, toward -16 LUFS (EBU R128) by one gain (evenGain): a voice
 * recorded quietly (the owner's sample sat at -37 dB) guided H3 weakly. Measured on the part (a voice sample: one part for one
 * clip, brought to that level whatever the rest of its file holds), or on the whole sound (`evenWhole`, a recording cut into
 * clips: each part evened out on its own came out at its own level, a song's quiet opening raised 6 dB more than the part
 * after it, and the volume stepped at every join of its clips). `after` hands over that many seconds more, for a
 * clip that outlasts the part: the sound's own pause after the part (its room tone), faded out in its last 0.15 s
 * before the sound speaks again (at once when the part was ended mid-word), then silence, `after` seconds in all.
 * `goesOn`: the next clip carries the sound on from where this clip stops, so the `after` seconds are the sound itself, not
 * faded out (a song never pauses: faded, every join of its clips fell silent, then sang that tail again).
 * `evenKey` names the sound given as bytes (its asset), so that its whole gain is measured once (wholeGain); `unmeasured` is
 * told when its loudness could not be measured, the part then left at its own level. `exact`: the part as asked (exactPart).
 */
export async function soundPart(source: Media, ext: string, opts: { start: number; seconds: number; durationMs?: number | null; even?: boolean; evenWhole?: boolean; after?: number; goesOn?: boolean; evenKey?: string; unmeasured?: () => void; exact?: boolean }): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "part.wav");
    const { start, seconds } = (opts.exact ? exactPart : partOf)(opts.start, opts.seconds, opts.durationMs ? opts.durationMs / 1000 : null);
    const after = Math.max(0, opts.after ?? 0);
    const gain = !opts.even ? 0 : opts.evenWhole ? await wholeGain(input, source, opts.evenKey) : await evenGain(input, { start, seconds });
    // unmeasured, the part keeps its own level: said, for a clip of a recording then sounds louder or quieter than the others
    if (gain === null) opts.unmeasured?.();
    const filters = opts.even ? [`volume=${(gain ?? 0).toFixed(2)}dB`] : [];
    if (after > 0 && opts.goesOn) filters.push(`apad=whole_dur=${(seconds + after).toFixed(3)}`);
    else if (after > 0) {
      const quiet = await quietAfter(input, start, seconds, after);
      // faded out by the end of the pause, so that the next word's first sound is not handed over with it
      if (quiet < after - 0.01) filters.push(`afade=t=out:st=${(seconds + Math.max(0, quiet - 0.15)).toFixed(3)}:d=0.15`);
      filters.push(`apad=whole_dur=${(seconds + after).toFixed(3)}`);
    }
    const af = filters.length ? ["-af", filters.join(",")] : [];
    // to the microsecond: a part that carries on from the clip before starts where it stopped on its frame grid (5.16667 s)
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", start.toFixed(6), "-t", (seconds + after).toFixed(6), "-i", input, "-vn", ...af, "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out]);
    return new Uint8Array(await readFile(out));
  });
}

/**
 * A take recorded from the microphone (the browser's webm/opus, or whatever its recorder makes) as the WAV the models are
 * given: 48 kHz 16-bit, its channels as recorded, cut to `trim` (seconds) when the silence at its ends was trimmed off.
 * Written beside the upload, so that it is removed with it.
 */
export async function recordingWav(input: string, out: string, trim?: { from: number; to: number }): Promise<void> {
  const cut = trim ? ["-ss", trim.from.toFixed(3), "-to", trim.to.toFixed(3)] : [];
  await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, ...cut, "-vn", "-ar", "48000", "-c:a", "pcm_s16le", out]);
}

/**
 * The pauses of a whole sound (a voice recording to cut into Lip sync clips), in seconds: quiet for at least 0.2 s, quiet
 * being 30 dB under its loudest, as quietAfter reads it, so a recording made quietly has pauses too.
 */
export async function pausesOf(source: Media, ext: string): Promise<Array<{ start: number; end: number }>> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    // read whole or not at all: the pauses are kept beside the sound for good (TimelineMedia.pauses), so a failed or
    // timed-out read (its report cut short, or none) would cut every recording of it at the most a clip takes
    const loud = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(await reportOf(["-i", input, "-vn", "-af", "volumedetect"], true))?.[1] ?? NaN);
    if (!Number.isFinite(loud)) throw new CutError("ffmpeg found no sound to read in this file");
    const said = await reportOf(["-i", input, "-vn", "-af", `silencedetect=noise=${(loud - 30).toFixed(1)}dB:d=0.2`], true);
    const starts = [...said.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
    const ends = [...said.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    // a pause still open at the end of the sound has no end said: it runs to the end, which is no place to cut
    return starts.flatMap((start, k) => (ends[k] !== undefined ? [{ start, end: ends[k]! }] : []));
  });
}

/**
 * What ffmpeg writes about a sound as it reads it (its own report, on stderr): volumedetect's and silencedetect's figures.
 * `whole`: a run that failed or was stopped at its time limit throws (failureOf) rather than giving the report so far.
 */
async function reportOf(args: string[], whole = false): Promise<string> {
  const timeout = 60_000;
  const r = await ffRun(tools.ffmpeg, ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], { timeout });
  if (whole && r.err) throw failureOf(r.err, r.stderr, timeout);
  return r.stderr;
}

/** Where evenGain brings a sound: a usual speaking level, and its loudest peak kept under full scale. */
const EVEN = { lufs: -16, peak: -1.5, most: 30 };

/**
 * The gain (dB) that brings a sound toward EVEN's loudness without its loudest peak going past EVEN's (EBU R128: integrated
 * loudness and true peak), measured over `part` of it (seconds), or over all of it: then each part of it cut for a clip gets
 * the same. Null when it cannot be read (a failed or timed-out run, no figure said): the part as it is, rather than none. A
 * sound with nothing above silence: 0.
 */
async function evenGain(input: string, part?: { start: number; seconds: number }): Promise<number | null> {
  const span = part ? ["-ss", part.start.toFixed(6), "-t", part.seconds.toFixed(6)] : [];
  const said = await reportOf([...span, "-i", input, "-vn", "-af", "ebur128=peak=true:framelog=quiet"], true).catch(() => null);
  const lufs = Number((said !== null && /I:\s*(-?[\d.]+) LUFS/.exec(said)?.[1]) || NaN);
  const peak = Number((said !== null && /Peak:\s*(-?[\d.]+) dBFS/.exec(said)?.[1]) || NaN);
  if (!Number.isFinite(lufs)) return null;
  if (lufs <= -70) return 0;
  const gain = Math.min(EVEN.lufs - lufs, Number.isFinite(peak) ? EVEN.peak - peak : Infinity);
  return Math.max(-EVEN.most, Math.min(EVEN.most, gain));
}

/**
 * Whole sounds' gains (evenGain over all of a recording), by the file and its size and time, or the asset its bytes are of:
 * each clip of a recording cut into 30 decoded all of it again, true peak included, for the same figure. A failed measure is
 * not kept, so the next clip tries again. The last hundred.
 */
const wholeGains = new Map<string, Promise<number | null>>();

/** evenGain over all of `source` (written to `input`), measured once per sound (wholeGains); not kept when it is not named. */
async function wholeGain(input: string, source: Media, evenKey?: string): Promise<number | null> {
  const key = typeof source === "string"
    ? await stat(source).then((st) => `${source}:${st.size}:${st.mtimeMs}`, () => null)
    : evenKey ? `${evenKey}:${source.byteLength}` : null;
  if (key === null) return evenGain(input);
  const have = wholeGains.get(key);
  if (have) return have;
  const measuring = evenGain(input);
  wholeGains.set(key, measuring);
  if (wholeGains.size > 100) wholeGains.delete(wholeGains.keys().next().value!);
  if ((await measuring) === null) wholeGains.delete(key);
  return measuring;
}

/**
 * How long the sound stays quiet right after a part (0 to `most` seconds): quiet is 30 dB under the part's loudest, so a
 * take recorded quietly has pauses too, and a room's hum is still quiet.
 */
async function quietAfter(input: string, start: number, seconds: number, most: number): Promise<number> {
  const loud = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(await reportOf(["-ss", start.toFixed(3), "-t", seconds.toFixed(3), "-i", input, "-vn", "-af", "volumedetect"]))?.[1] ?? NaN);
  if (!Number.isFinite(loud)) return 0;
  const said = await reportOf(["-ss", (start + seconds).toFixed(3), "-t", most.toFixed(3), "-i", input, "-vn", "-af", `silencedetect=noise=${(loud - 30).toFixed(1)}dB:d=0.1`]);
  const began = Number(/silence_start:\s*(-?[\d.]+)/.exec(said)?.[1] ?? NaN);
  // quiet from the part's very end, or not at all: speech that goes on and then pauses is no pause to end on
  if (!Number.isFinite(began) || began > 0.05) return 0;
  const ended = Number(/silence_end:\s*(-?[\d.]+)/.exec(said)?.[1] ?? NaN);
  return Math.min(most, Number.isFinite(ended) ? ended : most);
}
