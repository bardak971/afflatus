import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { FRAME_SLACK_MS } from "@afflatus/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsOf, ffmpegMajor, localInputs, tools, type ProbeInfo, type VideoFacts } from "./video";
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

const countFrames = async (file: string) =>
  Number((await must(tools.ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file])).trim()) || 0;

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
      const from = start / fps;
      const to = (start + count) / fps;
      await must(tools.ffmpeg, [
        "-y", "-loglevel", "error", "-i", input,
        "-vf", `fps=${fps},trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        ...(facts.hasSound ? ["-af", `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS`, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", out,
      ], { signal: want.signal });
      if ((await countFrames(out)) === count) break;
      const fewer = want.side === "after" ? counts.find((c) => c < count) : undefined;
      if (attempt >= 2 || (want.side === "after" ? !fewer : start === 0)) throw new CutError("The frames to join onto could not be cut from that clip.");
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

/** The moments of a video's keyframes, in milliseconds: where a stream copy can start and end without re-encoding. */
async function keyframesOf(file: string): Promise<number[]> {
  const out = await must(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file]).catch(() => "");
  return out.split(/\r?\n/).map((l) => Number(l.split(",")[0])).filter((n) => Number.isFinite(n)).map((s) => Math.round(s * 1000));
}

/**
 * The parts of a video that are kept, one after the other, as one MP4: a range copied (one part), a range
 * removed (the part before and the part after), one piece of a split (one part). One part whose bounds
 * fall on keyframes (or the file's ends) is copied without re-encoding: instant and lossless. Anything
 * else is cut to the frame and encoded again at `crf`. The sound follows the picture.
 */
export async function rangeKeep(
  source: Media, ext: string, facts: { durationMs: number; hasSound: boolean; soundOnly?: boolean }, keep: Array<[number, number]>,
  opts: { crf?: number; even?: boolean; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const parts = keep.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(facts.durationMs, Math.max(a, b))] as [number, number]).filter(([a, b]) => b - a >= 20);
  if (!parts.length) throw new CutError("That range is too short to keep: nothing would be left.");
  const crf = Math.max(0, Math.min(40, Math.round(opts.crf ?? 10)));
  // every run reads the source from its start: its time limit grows with the source's length, and the job's Stop still ends it
  const run = { timeout: forLength(facts.durationMs), signal: opts.signal };
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const sec = (ms: number) => (ms / 1000).toFixed(3);
    // a sound: its parts cut to the millisecond and joined as a WAV (nothing lost to an encoder), its loudness evened out when asked (EBU R128, -16 LUFS)
    if (facts.soundOnly) {
      const wav = join(dir, "kept.wav");
      const chains = parts.map(([a, b], i) => `[0:a]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]`);
      const joined = `${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1${opts.even ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : ""}[a]`;
      await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-filter_complex", [...chains, joined].join(";"), "-map", "[a]", "-ar", "48000", "-c:a", "pcm_s16le", wav], run);
      return new Uint8Array(await readFile(wav));
    }
    const out = join(dir, "kept.mp4");
    // one part on keyframes: a stream copy
    if (parts.length === 1) {
      const [a, b] = parts[0]!;
      const keys = await keyframesOf(input);
      const onKey = (ms: number) => keys.some((k) => Math.abs(k - ms) <= 2);
      if ((a === 0 || onKey(a)) && (b >= facts.durationMs - 2 || onKey(b)) && /^(mp4|mov|m4v)$/i.test(ext)) {
        await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", sec(a), "-to", sec(b), "-i", input, "-c", "copy", "-movflags", "+faststart", out], run);
        return new Uint8Array(await readFile(out));
      }
    }
    // cut to the frame and joined, encoded again
    const chains = parts.map(([a, b], i) => `[0:v]trim=start=${sec(a)}:end=${sec(b)},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2[v${i}]` + (facts.hasSound ? `;[0:a]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]` : ""));
    const concat = parts.map((_, i) => `[v${i}]${facts.hasSound ? `[a${i}]` : ""}`).join("") + `concat=n=${parts.length}:v=1:a=${facts.hasSound ? 1 : 0}[v]${facts.hasSound ? "[a]" : ""}`;
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", "-i", input,
      "-filter_complex", [...chains, concat].join(";"),
      "-map", "[v]", ...(facts.hasSound ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
    ], run);
    return new Uint8Array(await readFile(out));
  });
}

export const sec = (ms: number) => (ms / 1000).toFixed(3);

/** The sound slowed by `factor` with its pitch kept: atempo takes 0.5 at a time. */
const slowTempo = (factor: number) => Array.from({ length: Math.round(Math.log2(factor)) }, () => "atempo=0.5").join(",");

/**
 * A range of a video slowed down by `factor`, the frames in between worked out by ffmpeg's motion
 * interpolation (the fallback when there is no RIFE on the GPU): the same frame rate, `factor` times as
 * many frames, the sound slowed with its pitch kept. Slow: minutes for a few seconds.
 */
export async function slowMotion(source: Media, ext: string, facts: { durationMs: number; fps: number | null; hasSound: boolean }, startMs: number, endMs: number, factor: number, opts: { crf?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
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
    return new Uint8Array(await readFile(out));
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

/** The sound of a video as a sound file of its own (AAC in an .m4a). `durationMs`: the video's length, for its time limit. */
export async function soundOf(source: Media, ext: string, durationMs?: number | null): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "sound.m4a");
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", out], { timeout: forLength(durationMs) });
    return new Uint8Array(await readFile(out));
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

/** The same video without its sound: the picture copied as it is, nothing encoded again. `durationMs`: its length, for the time limit. */
export async function silentOf(source: Media, ext: string, durationMs?: number | null): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, `silent.${ext}`);
    const format = ext === "webm" ? await webmCopyFormat(input, "v") : ["-movflags", "+faststart"];
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-map", "0:v", "-c", "copy", "-an", ...format, out], { timeout: forLength(durationMs) });
    return new Uint8Array(await readFile(out));
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
 * A part of a sound (or of a video's sound) as a sound of its own: from `start` seconds, `seconds` long.
 * The start is where it was asked, as long as two seconds are left after it; the part ends where the
 * sound ends when that comes first. `even` evens out its loudness (EBU R128, to -16 LUFS): a voice recorded
 * quietly (the owner's sample sat at -37 dB) guided H3 weakly. `after` hands over that many seconds more, for a
 * clip that outlasts the part: the sound's own pause after the part (its room tone), faded out in its last 0.15 s
 * before the sound speaks again (at once when the part was ended mid-word), then silence, `after` seconds in all.
 */
export async function soundPart(source: Media, ext: string, opts: { start: number; seconds: number; durationMs?: number | null; even?: boolean; after?: number }): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "part.wav");
    const { start, seconds } = partOf(opts.start, opts.seconds, opts.durationMs ? opts.durationMs / 1000 : null);
    const after = Math.max(0, opts.after ?? 0);
    const filters = opts.even ? ["loudnorm=I=-16:TP=-1.5:LRA=11"] : [];
    if (after > 0) {
      const quiet = await quietAfter(input, start, seconds, after);
      // faded out by the end of the pause, so that the next word's first sound is not handed over with it
      if (quiet < after - 0.01) filters.push(`afade=t=out:st=${(seconds + Math.max(0, quiet - 0.15)).toFixed(3)}:d=0.15`);
      filters.push(`apad=whole_dur=${(seconds + after).toFixed(3)}`);
    }
    const af = filters.length ? ["-af", filters.join(",")] : [];
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", start.toFixed(3), "-t", (seconds + after).toFixed(3), "-i", input, "-vn", ...af, "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out]);
    return new Uint8Array(await readFile(out));
  });
}

/**
 * The pauses of a whole sound (a voice recording to cut into Lip sync clips), in seconds: quiet for at least 0.2 s, quiet
 * being 30 dB under its loudest, as quietAfter reads it, so a recording made quietly has pauses too.
 */
export async function pausesOf(source: Media, ext: string): Promise<Array<{ start: number; end: number }>> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const loud = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(await reportOf(["-i", input, "-vn", "-af", "volumedetect"]))?.[1] ?? NaN);
    if (!Number.isFinite(loud)) return [];
    const said = await reportOf(["-i", input, "-vn", "-af", `silencedetect=noise=${(loud - 30).toFixed(1)}dB:d=0.2`]);
    const starts = [...said.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])));
    const ends = [...said.matchAll(/silence_end:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    // a pause still open at the end of the sound has no end said: it runs to the end, which is no place to cut
    return starts.flatMap((start, k) => (ends[k] !== undefined ? [{ start, end: ends[k]! }] : []));
  });
}

/** What ffmpeg writes about a sound as it reads it (its own report, on stderr): volumedetect's and silencedetect's figures. */
async function reportOf(args: string[]): Promise<string> {
  return (await ffRun(tools.ffmpeg, ["-hide_banner", "-nostats", ...args, "-f", "null", "-"], { timeout: 60_000 })).stderr;
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
