import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { FRAME_SLACK_MS, JOIN_FADE_MS, musicGainAt, type MusicPlan } from "@afflatus/core";
import { gainWav, type DuckCurve } from "./duck";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { factsOf, ffmpegMajor, graphFileOption, localInputs, tools, type ProbeInfo, type VideoFacts } from "./video";
import { ffmpegPool } from "./pool";
import { aiVideoArgs } from "./aiMark";

/**
 * Cutting videos: the few frames a new clip joins onto, one frame as a picture, a strip of frames for
 * the timeline, and a timeline as one file. Unlike reading a video's facts (video.ts), these cannot be
 * skipped when ffmpeg is missing: the error says so in words the person can act on.
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
async function onDisk(dir: string, name: string, source: Media): Promise<string> {
  if (typeof source === "string") return source;
  const file = join(dir, name);
  await writeFile(file, source);
  return file;
}

function must(tool: string, args: string[], opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((done, fail) => {
    execFile(tool, localInputs(args), { encoding: "utf8", timeout: opts.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: opts.signal }, (err, stdout, stderr) => {
      if (!err) return done(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return fail(new FfmpegMissing("This needs ffmpeg, which was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE."));
      }
      if (err.name === "AbortError") return fail(new CutError("stopped by you"));
      const last = String(stderr).trim().split(/\r?\n/).pop() ?? "";
      fail(new CutError(`ffmpeg could not read or write the file${last ? `: ${last.slice(0, 300)}` : ""}`));
    });
  });
}

async function inTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
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
      const report = await new Promise<string>((done) => {
        execFile(tools.ffmpeg, localInputs(["-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-"]), { encoding: "utf8", timeout: 60_000, windowsHide: true }, (_err, _stdout, stderr) => done(String(stderr)));
      });
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
  const count = counts.find((c) => c <= room);
  if (!count) throw new CutError(`That clip is too short to join onto there: it has ${room} frames, and at least ${Math.min(...counts)} are needed.`);
  let start = want.side === "before" ? edge - count : edge;

  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "cut.mp4");
    // the last frame a length promises is not always there: when the cut comes out short, it is taken one frame earlier
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
      if (attempt >= 2 || start === 0) throw new CutError("The frames to join onto could not be cut from that clip.");
      start--;
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
const STRIP = { frames: 12, height: 72 };

/** Frames of a video side by side in one picture (a JPEG), spread evenly over its length: what a clip shows on the timeline. */
export async function filmStrip(source: Media, ext: string, durationMs: number, opts: { frames?: number; height?: number; /** Only this part of the video, in milliseconds. */ fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> {
  const frames = Math.max(2, Math.min(120, Math.round(opts.frames ?? STRIP.frames)));
  const height = Math.max(24, Math.min(240, Math.round(opts.height ?? STRIP.height)));
  const from = Math.max(0, Math.min(opts.fromMs ?? 0, durationMs));
  const to = Math.max(from + FRAME_SLACK_MS, Math.min(opts.toMs ?? durationMs, durationMs));
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "strip.jpg");
    const every = Math.max(0.01, (to - from) / 1000 / frames);
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...(from > 0 ? ["-ss", (from / 1000).toFixed(3)] : []), "-to", (to / 1000).toFixed(3), "-i", input,
      "-vf", `fps=1/${every.toFixed(4)}:start_time=0:round=down,scale=-2:${height},tile=${frames}x1`,
      "-frames:v", "1", "-q:v", "5", out,
    ]);
    return new Uint8Array(await readFile(out));
  });
}

/** One small picture of a moment, as a JPEG: what a hover over the trim bar shows. */
export async function peekAt(source: Media, ext: string, atMs: number, height = 160): Promise<Uint8Array> {
  return inTemp(async (dir) => {
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
  });
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
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const sec = (ms: number) => (ms / 1000).toFixed(3);
    // a sound: its parts cut to the millisecond and joined as a WAV (nothing lost to an encoder), its loudness evened out when asked (EBU R128, -16 LUFS)
    if (facts.soundOnly) {
      const wav = join(dir, "kept.wav");
      const chains = parts.map(([a, b], i) => `[0:a]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS[a${i}]`);
      const joined = `${parts.map((_, i) => `[a${i}]`).join("")}concat=n=${parts.length}:v=0:a=1${opts.even ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : ""}[a]`;
      await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-filter_complex", [...chains, joined].join(";"), "-map", "[a]", "-ar", "48000", "-c:a", "pcm_s16le", wav], { signal: opts.signal });
      return new Uint8Array(await readFile(wav));
    }
    const out = join(dir, "kept.mp4");
    // one part on keyframes: a stream copy
    if (parts.length === 1) {
      const [a, b] = parts[0]!;
      const keys = await keyframesOf(input);
      const onKey = (ms: number) => keys.some((k) => Math.abs(k - ms) <= 2);
      if ((a === 0 || onKey(a)) && (b >= facts.durationMs - 2 || onKey(b)) && /^(mp4|mov|m4v)$/i.test(ext)) {
        await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", sec(a), "-to", sec(b), "-i", input, "-c", "copy", "-movflags", "+faststart", out], { signal: opts.signal });
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
    ], { signal: opts.signal });
    return new Uint8Array(await readFile(out));
  });
}

/** One thing that plays in an export: a part of a video, or a picture held for a while. */
export interface ExportPart {
  kind: "video" | "still";
  source: Media;
  ext: string;
  /** The part of a video that plays, in milliseconds. For a picture: 0 and how long it is held. */
  startMs: number;
  endMs: number;
  /** Whether the video has a sound of its own. */
  hasSound: boolean;
  /** What is heard: the video's own sound, nothing, or a sound file (cut or padded to the part's length). */
  sound: "own" | "muted" | "file";
  soundFile?: { source: Media; ext: string };
  /** 0 to 1. */
  volume: number;
  /** Of another shape than the frame: true = fills it (edges cut), false = shown whole, with bars. */
  fill: boolean;
  /** This part fades in over the part before over this many milliseconds (see blendMode). */
  blendMs?: number;
  /** Where in its video the colour match reads this part: the frames that show the same moments as the part before's end, when it has them (a continuation's shared frames). Left out: its first frames after the fade. */
  matchAtMs?: number;
  /** Not colour-matched to the part before (it went through another enlargement: its colour differs for that, not for the light). */
  noMatch?: boolean;
  /** Decoded as one piece with the part before: not matched, given the part before's own nudge (no step where there is none). */
  sameLook?: boolean;
  /** Its video's frame means as kept beside it (TimelineMedia.means): the colour match reads them rather than measure the file again. */
  means?: FrameMeans | null;
  /**
   * "hold": the part before holds its last frame for as long, this one fades in after it (nothing of either is lost).
   * "overlap": this part starts `blendMs` early, over the same moments as the part before's end, and the two are faded
   * with both moving. "freeze": the picture as "hold", the sound straight on, no crossfade (a continuation made in the
   * latent carries the sound of the clip before: a fade would only dip it).
   */
  blendMode?: "hold" | "overlap" | "freeze";
  /**
   * A cut's transition into this part, centred on the cut (core transitions.ts): the part before is held on its last frame
   * for half of it, this one on its first frame for the other half, and xfade runs over both halves, so nothing moves on
   * the clock. Its sound runs straight on, or fades out and in over the halves.
   */
  transitionIn?: { kind: string; xfade: string; ms: number; fadeSound: boolean };
}

/**
 * Flash, as xfade's custom expression: the cut at the middle, a white added over it that peaks there (P runs from 1 to 0).
 * Luma rises, the colour planes go towards grey with it (as a picture blown out to white loses its colour), the same as the
 * player's white veil added on top (plus-lighter).
 */
export const FLASH_EXPR = "st(0,1-abs(2*P-1));st(1,if(gt(P,0.5),A,B));if(eq(PLANE,0),min(235,ld(1)+220*ld(0)),ld(1)+(128-ld(1))*0.8*ld(0))";

/** How long a continuation fades in over the clip before, which holds its last frame meanwhile: four frames at 24 a second. */
export const BLEND_MS = JOIN_FADE_MS;
/**
 * How long a continuation made in the latent fades in over the clip before, which holds its last frame meanwhile. The clip
 * before plays to its very last frame and the continuation from its first own one: its guided frames are a loose copy of
 * the clip before's (the model redraws them, 3.9 against 0.8 of motion a frame in a calm shot) and its frames next to its
 * guide step (×2.5 the motion, exact latent or hybrid alike). Simulated on three joins, measured 2026-10-08: the old fade
 * over the shared frames before a take-over point peaked at ×2.9 the motion; this one from the clip before's end at ×1.6
 * over 170 ms, ×1.2 over 420 ms. 420 ms doubled a moving subject for a fifth of a second (a kite against the sky, the held
 * frame under the moving one, seen in a non-turbo export): 170 ms keeps that ghost to a couple of frames.
 */
export const DISSOLVE_MS = JOIN_FADE_MS;

/** How a video's own part looks, measured on its real frames when it was stored (see lookOf). */
export interface Measure {
  /** Mean luma, 0 to 255. */
  luma: number;
  /** Sharpness: the mean absolute Laplacian of a 256-pixel-wide grey copy. 0 is flat, several units is crisp. Grain counts in it. */
  sharp: number;
  /** Sharpness without the grain: the same Laplacian on the copy cleaned of its fine noise (a 3×3 median). Takes measured before 2026-10-14 have none. */
  edges?: number;
  /** Grain: how far the copy's pixels sit from its 3×3 median, in luma steps (0 to 255): the fine noise, not the detail. */
  grain?: number;
  /** How much the face along the clip is the person it is of (its Picture, its cast): ArcFace, the median over a few frames and the lowest. With the Face Match node only. */
  face?: number;
  faceLow?: number;
  /** Mean chroma against neutral: U is blue (+) to yellow (−), V red (+) to green (−); −128 to 127. */
  chroma?: { u: number; v: number };
  /** Where the darkest and the brightest tenth of the picture sit in luma (signalstats YLOW and YHIGH). */
  range?: { low: number; high: number };
  /** Exposure flicker: the mean change of the frame's mean luma from one sampled frame to the next, as a percentage of the mean (12 samples a second). */
  flicker?: number;
  /** Pace: the mean frame-to-frame difference on a small grey copy, ten samples a second (the ruler's motion figure). */
  pace?: number;
  /** The sound's spectral centroid in Hz, where its energy sits: a voice that dulls drifts down. null without sound. */
  voice?: number | null;
  /** A join made in the latent: how wide the regenerated run-up came out against the latent tail it was guided by, as a ratio over the channels (1 = the same). */
  drift?: { width: number };
  /** A continuation: how much the picture jumps where the run-up ends and the clip's own frames begin, against its own motion right after (×1 = it carries on; ×3 and past, the model stepped away from its guide and a cut shows there). */
  handover?: number;
}

/**
 * How a video's own part looks, in a few numbers measured on its real frames: mean luma, sharpness, chroma,
 * luma range, flicker, pace and the sound's centre of weight (see Look). From `fromMs` on (a continuation's
 * own part, after the frames it shares with the clip before). For telling whether a run of clips that flow
 * on slides darker, softer, duller or slower clip after clip. Four small ffmpeg passes, under a second each.
 */
export async function lookOf(source: Media, ext: string, fromMs = 0): Promise<Measure | null> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const run = (args: string[]) => must(tools.ffmpeg, ["-loglevel", "error", "-ss", (Math.max(0, fromMs) / 1000).toFixed(3), "-i", input, ...args, "-f", "null", "-"], { timeout: 5 * 60_000 }).catch(() => "");
    const pick = (said: string, key: string) => [...said.matchAll(new RegExp(`lavfi\\.${key}=(-?[\\d.]+)`, "g"))].map((m) => Number(m[1])).filter((v) => Number.isFinite(v));
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    // luma, its spread and the chroma, 12 frames a second on a small colour copy
    const stats = await run(["-an", "-vf", "fps=12,scale=256:-2,signalstats,metadata=print:file=-"]);
    const yavg = pick(stats, "signalstats\\.YAVG");
    if (!yavg.length) return null;
    // the Laplacian around 128, folded to its size: its mean over the frame is the sharpness
    const sharp = pick(await run(["-an", "-vf", "fps=4,scale=256:-2,format=gray,convolution=0m='0 -1 0 -1 4 -1 0 -1 0':0bias=128,lutyuv=y='if(gt(val\\,128)\\,val-128\\,128-val)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-"]), "signalstats\\.YAVG");
    if (!sharp.length) return null;
    // the same without the grain: the copy cleaned of its fine noise first. The grain itself: the copy against its cleaned self
    const edges = pick(await run(["-an", "-vf", "fps=4,scale=256:-2,format=gray,median=radius=1,convolution=0m='0 -1 0 -1 4 -1 0 -1 0':0bias=128,lutyuv=y='if(gt(val\\,128)\\,val-128\\,128-val)',signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-"]), "signalstats\\.YAVG");
    const grain = pick(await run(["-an", "-vf", "fps=4,scale=256:-2,format=gray,split[a][b];[b]median=radius=1[c];[a][c]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-"]), "signalstats\\.YAVG");
    // the motion, as the ruler measures it (the first sample is a frame against nothing)
    const pace = pick(await run(["-an", "-vf", `fps=${MOTION_RATE},scale=96:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`]), "signalstats\\.YAVG").slice(1);
    // the sound's spectral centroid; nothing when there is no sound (or no such filter)
    const centroid = pick(await run(["-vn", "-af", "aspectralstats=measure=centroid,ametadata=print:key=lavfi.aspectralstats.1.centroid:file=-"]), "aspectralstats\\.1\\.centroid");
    const luma = mean(yavg);
    const steps = yavg.slice(1).map((v, i) => Math.abs(v - yavg[i]!));
    const u = pick(stats, "signalstats\\.UAVG");
    const v = pick(stats, "signalstats\\.VAVG");
    const low = pick(stats, "signalstats\\.YLOW");
    const high = pick(stats, "signalstats\\.YHIGH");
    return {
      luma: r1(luma),
      sharp: r2(mean(sharp)),
      ...(edges.length ? { edges: r2(mean(edges)) } : {}),
      ...(grain.length ? { grain: r2(mean(grain)) } : {}),
      ...(u.length && v.length ? { chroma: { u: r1(mean(u) - 128), v: r1(mean(v) - 128) } } : {}),
      ...(low.length && high.length ? { range: { low: r1(mean(low)), high: r1(mean(high)) } } : {}),
      flicker: steps.length ? r2((mean(steps) / Math.max(1, luma)) * 100) : 0,
      pace: pace.length ? r2(mean(pace)) : 0,
      voice: centroid.length ? Math.round(mean(centroid)) : null,
    };
  });
}

/** How a clip is matched to the clip before at their join: over this long on each side, and by at most this many steps of 255. A nudge, never a grade. */
export const MATCH = { lookSec: 0.4, mostSteps: 14 };
export interface Means {
  y: number;
  u: number;
  v: number;
}
/**
 * The nudge a clip gets at its join: toward the clip before as it will look (its own nudge, `carry`, included),
 * on luma and both chroma planes, within MATCH.mostSteps. The export and the player apply the same one.
 */
export function colourNudge(before: Means, after: Means, carry: Means): Means {
  const nudge = (want: number, have: number) => Math.round(Math.max(-MATCH.mostSteps, Math.min(MATCH.mostSteps, want - have)) * 10) / 10;
  return { y: nudge(before.y + carry.y, after.y), u: nudge(before.u + carry.u, after.u), v: nudge(before.v + carry.v, after.v) };
}

/** Every frame's mean luma and chroma along a video, with its moment (ms from its first frame): see meansAlong. */
export interface FrameMeans {
  t: number[];
  y: number[];
  u: number[];
  v: number[];
}
/**
 * The mean luma and chroma of every frame of a video, measured as meansOf measures a stretch (the same small copy, every
 * frame), in one pass: the means of any stretch of it are then read off it (meansWithin) rather than run through ffmpeg each.
 */
export async function meansAlong(source: Media, ext: string): Promise<FrameMeans> {
  return inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, source);
    const said = await must(tools.ffmpeg, ["-loglevel", "error", "-i", file, "-an", "-vf", "scale=96:-2,signalstats,metadata=print:file=-", "-f", "null", "-"], { timeout: 10 * 60_000 });
    const out: FrameMeans = { t: [], y: [], u: [], v: [] };
    for (const block of said.split(/^frame:/m).slice(1)) {
      const at = Number(/pts_time:\s*(-?[\d.]+)/.exec(block)?.[1]);
      const pick = (key: string) => Number(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`).exec(block)?.[1]);
      const [y, u, v] = [pick("YAVG"), pick("UAVG"), pick("VAVG")];
      if (![at, y, u, v].every(Number.isFinite)) continue;
      out.t.push(at * 1000);
      out.y.push(y);
      out.u.push(u);
      out.v.push(v);
    }
    // from its first frame, as a stretch is asked for, whatever the file's first timestamp
    const first = out.t[0] ?? 0;
    out.t = out.t.map((t) => Math.round((t - first) * 10) / 10);
    return out;
  });
}
/** The means of the frames from `fromMs` for `seconds`, read off a video's frame means as meansOf would measure them; null when no frame falls there. */
export function meansWithin(along: FrameMeans, fromMs: number, seconds: number): Means | null {
  const from = Math.max(0, fromMs);
  const to = from + seconds * 1000;
  const k = along.t.flatMap((t, i) => (t >= from - 0.5 && t < to - 0.5 ? [i] : []));
  if (!k.length) return null;
  const mean = (xs: number[]) => k.reduce((sum, i) => sum + xs[i]!, 0) / k.length;
  return { y: mean(along.y), u: mean(along.u), v: mean(along.v) };
}

/** The mean luma and chroma of a stretch of a video file, for matching one clip's colour to the next. */
export async function meansOf(file: string, fromSec: number, seconds: number): Promise<Means | null> {
  const said = await ffmpegPool(() => must(tools.ffmpeg, ["-loglevel", "error", "-ss", Math.max(0, fromSec).toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-an", "-vf", "scale=96:-2,signalstats,metadata=print:file=-", "-f", "null", "-"])).catch(() => "");
  const pick = (key: string) => [...said.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const y = pick("YAVG");
  const u = pick("UAVG");
  const v = pick("VAVG");
  if (!y.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return { y: mean(y), u: mean(u), v: mean(v) };
}
export interface ExportMusic {
  source: Media;
  ext: string;
  /** Where it starts and stops on the video's clock, the part of the song, its level under each clip (@afflatus/core's musicPlan). */
  plan: MusicPlan;
  /** Quieter where people speak in the clips: the music multiplied by this curve (duck.ts), the same the player follows. */
  duck: DuckCurve | null;
}

/** What joinVideosInto is asked besides its parts. */
export interface JoinOptions {
  scale?: number;
  music?: ExportMusic;
  /** Make it this many pictures a second by working out the pictures in between (slow, done on the processor). */
  smoothTo?: number;
  /** Nudge each video part's brightness and tint to the part before it at the join (means over the last and first moments). */
  match?: boolean;
  /** A copy to share on the web: at most this many megabytes, its long edge at most 1280 and 30 pictures a second (webCut). */
  webMb?: number;
  /** It holds a render: marked as made by a model (aiMark.ts). */
  fromRender?: boolean;
  signal?: AbortSignal;
}

/** The long edge and the speed of a copy for the web: what a README, a post or a chat plays inline without waiting. */
const WEB_EDGE = 1280;
const WEB_FPS = 30;

/**
 * A copy for the web: the frame brought down to WEB_EDGE on its long side (never up), and the bitrate that keeps the
 * whole file under `mb` megabytes for its length, the sound taken out of the budget first. A little is kept in hand:
 * one pass of x264 at a mean bitrate lands within a few percent of it.
 */
export function webCut(frame: { width: number; height: number }, totalMs: number, mb: number): { W: number; H: number; videoKbps: number; audioKbps: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const k = Math.min(1, WEB_EDGE / Math.max(frame.width, frame.height));
  const audioKbps = 128;
  const seconds = Math.max(1, totalMs / 1000);
  const videoKbps = Math.max(300, Math.floor((mb * 8 * 1000 * 0.92) / seconds - audioKbps));
  return { W: even(frame.width * k), H: even(frame.height * k), videoKbps, audioKbps };
}

/**
 * Clips and pictures played one after the other, as one MP4: each cut to the part that plays, fitted
 * into the frame, brought to one speed; what has no sound is silent for its length; music, when there is
 * some, lies under all of it. `scale` enlarges every frame at the end (nothing is rendered again). The joined file is
 * handed to `use` where it lies, before it is cleared away: stored from there, it is never held whole in memory.
 */
export async function joinVideosInto<T>(parts: ExportPart[], frame: { width: number; height: number }, fps: number, opts: JoinOptions, use: (file: string) => Promise<T>): Promise<T> {
  if (!parts.length) throw new CutError("There is nothing to export yet.");
  // a copy for the web is never enlarged, and is made at the web's size from the start (the parts are fitted to it)
  const scale = opts.webMb ? 1 : opts.scale ?? 1;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const lengthMs = parts.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
  const web = opts.webMb ? webCut(frame, lengthMs, opts.webMb) : null;
  const size = web ? { W: web.W, H: web.H } : { W: even(frame.width * scale), H: even(frame.height * scale) };
  // enlarged frames are sharpened a little: scaling alone leaves them soft
  const smooth = !web && opts.smoothTo && opts.smoothTo > fps ? `minterpolate=fps=${opts.smoothTo}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : "";
  // the web's speed: pictures dropped evenly, never made up
  const slower = web && fps > WEB_FPS ? `fps=${WEB_FPS}` : "";
  const post = [smooth, slower, scale > 1 ? "unsharp=5:5:0.6:5:5:0" : ""].filter(Boolean);
  const finish = `[joined]${post.join(",") || "null"}[v]`;
  const videoCodec = web
    // a size to keep: a mean bitrate, capped so no stretch overshoots it, and the slower preset for more picture per byte
    ? ["-c:v", "libx264", "-preset", "slow", "-b:v", `${web.videoKbps}k`, "-maxrate", `${Math.round(web.videoKbps * 1.5)}k`, "-bufsize", `${web.videoKbps * 2}k`, "-pix_fmt", "yuv420p"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"];
  const audioCodec = ["-c:a", "aac", "-b:a", web ? `${web.audioKbps}k` : "192k"];
  const ends = [...(opts.fromRender ? aiVideoArgs : []), "-movflags", "+faststart"];
  const run = { timeout: 3 * 60 * 60_000, signal: opts.signal };
  const music = opts.music;
  return inTemp(async (dir) => {
    // every part's file on disk first: a colour match reads the part before's, which may lie in the piece before
    const files = await Promise.all(parts.map((p, i) => onDisk(dir, `part${i}.${p.ext}`, p.source)));
    const looks = await colourLooks(parts, files, Boolean(opts.match));
    const pieces = piecesOf(parts, runsOf(parts));
    const out = join(dir, "export.mp4");
    if (pieces.length === 1) {
      const inputs = new Inputs(dir);
      const chains = await partChains(parts, files, pieces[0]!.flat(), inputs, size, fps, looks);
      const { outs, total } = fadeRuns(parts, pieces[0]!, fps, chains);
      chains.push(`${outs.join("")}concat=n=${outs.length}:v=1:a=1[joined][${music ? "voices" : "a"}]`, finish);
      if (music) {
        const track = await inputs.add(`music.${music.ext}`, music.source);
        chains.push(...musicChain(music.plan, track, await inputs.add("gain.wav", musicGainWav(music, total))));
      }
      await must(tools.ffmpeg, [
        "-y", "-loglevel", "error", ...inputs.args, ...(await graphFile(dir, "graph.txt", chains)), "-map", "[v]", "-map", "[a]", ...videoCodec, ...audioCodec, ...ends, out,
      ], run);
      return use(out);
    }
    // A long timeline is made in pieces, one ffmpeg run each, cut where no fade or transition crosses: ffmpeg opens every
    // input of a run at once and holds tens of megabytes for each, so its memory is a piece's, not the whole timeline's.
    // Each piece's picture is encoded as the whole would be and its sound kept exact (32-bit float, as the encoder is
    // handed it); the pieces are put end to end by the concat demuxer, the picture copied as it is and the sound encoded
    // once with the music under it. A piece ends where its concat filter ends it (its sound padded to its picture, as
    // between runs), and the next starts there, as on the whole timeline's clock. Made at another speed (smoothed, or the
    // web's), the pictures are worked out across the joins of the pieces too: the pieces are then kept lossless and the
    // speed changed and encoded once, over all of them.
    const regrid = Boolean(smooth || slower);
    let total = 0;
    let clock = 0;
    /** Where the whole timeline's concat filter would end the picture: see `ending` below. */
    let ending = 0;
    const list: string[] = [];
    for (const [k, piece] of pieces.entries()) {
      const inputs = new Inputs(dir);
      const chains = await partChains(parts, files, piece.flat(), inputs, size, fps, looks);
      const { outs, total: length } = fadeRuns(parts, piece, fps, chains);
      total += length;
      // the concat filter pads a run's sound with silence to its picture's end only when another run follows: a piece but
      // the last is followed by an empty one, so that its sound ends where the whole timeline's would
      if (k < pieces.length - 1) {
        chains.push(`nullsrc=s=${size.W}x${size.H}:r=${fps},format=yuv420p,setsar=1,trim=end_frame=0[vend]`, "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=0[aend]");
        outs.push("[vend][aend]");
      }
      chains.push(`${outs.join("")}concat=n=${outs.length}:v=1:a=1[joined][a]`, regrid ? "[joined]null[v]" : finish);
      const file = join(dir, `piece${k}.mov`);
      // kept lossless for the speed change, each picture at its moment to the microsecond, as the whole timeline's concat
      // filter hands them on (not moved onto the frame grid: the speed change picks its frames by those moments)
      const keep = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", (await ffmpegMajor() ?? 99) < 6 ? "-vsync" : "-fps_mode", "passthrough", "-enc_time_base:v", "1:1000000"];
      const codec = regrid ? keep : videoCodec;
      await must(tools.ffmpeg, [
        "-y", "-loglevel", "error", ...inputs.args, ...(await graphFile(dir, `graph${k}.txt`, chains)), "-map", "[v]", "-map", "[a]", ...codec, "-c:a", "pcm_f32le", file,
      ], run);
      // where the next piece starts: the end of its longest stream, exact (the file's own duration is in milliseconds)
      const said = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "csv=p=0", file]);
      const lengths = new Map(said.split(/\r?\n/).filter(Boolean).map((l) => [l.split(",")[0], Number(l.split(",")[1])] as const));
      const longest = Math.max(lengths.get("video") ?? 0, lengths.get("audio") ?? 0);
      ending = clock + Math.max((lengths.get("video") ?? 0) - 1 / fps, lengths.get("audio") ?? 0);
      clock += longest;
      list.push(`file '${file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`, `duration ${longest.toFixed(6)}`);
    }
    await writeFile(join(dir, "pieces.txt"), list.join("\n") + "\n");
    const inputs = new Inputs(dir);
    await inputs.add("pieces.txt", join(dir, "pieces.txt"), ["-f", "concat", "-safe", "0"]);
    // the web's speed: on the whole timeline the speed change gives a frame for every moment before where the concat
    // filter ends the picture, its last frame's moment or the sound's end when that runs a little past (measured: not the
    // last frame's end). Here the last frame is held a frame longer and the frames counted off there. Smoothing goes by
    // the frames alone
    const counted = slower ? ["tpad=stop=1:stop_mode=clone", ...post, `trim=end_frame=${Math.round(ending * WEB_FPS)}`] : post;
    const chains: string[] = regrid ? [`[0:v]${["settb=AVTB", ...counted].join(",")}[v]`] : [];
    if (music) {
      const track = await inputs.add(`music.${music.ext}`, music.source);
      chains.push("[0:a]anull[voices]", ...musicChain(music.plan, track, await inputs.add("gain.wav", musicGainWav(music, total))));
    }
    const picture = regrid
      ? ["-map", "[v]", ...videoCodec]
      // the picture put back on its frame grid where a piece starts between two frames (its sound ran on past its
      // picture): the encoder of the whole timeline rounds to the nearest frame there, the same
      : ["-map", "0:v", "-c:v", "copy", "-bsf:v", `setts=pts=round(PTS*TB*${fps})/(TB*${fps}):dts=round(DTS*TB*${fps})/(TB*${fps})`];
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...inputs.args, ...(chains.length ? ["-filter_complex", chains.join(";")] : []),
      ...picture, "-map", music ? "[a]" : "0:a", ...audioCodec, ...ends, out,
    ], run);
    return use(out);
  });
}

/**
 * The parts of a timeline longer than this are made in pieces of about as many (piecesOf), each piece its own ffmpeg run.
 * Settable for the tests, which make pieces of a few parts.
 */
export const EXPORT_PIECE = { parts: 8 };

/** The parts that fade into each other (a blend or a transition), as runs of their numbers, in order: a run is made as one. */
export function runsOf(parts: ExportPart[]): number[][] {
  const runs: number[][] = [];
  parts.forEach((p, i) => {
    if (i > 0 && ((p.blendMs && p.blendMs > 0) || p.transitionIn)) runs.at(-1)!.push(i);
    else runs.push([i]);
  });
  return runs;
}

/** Whole runs gathered into pieces of at least EXPORT_PIECE.parts parts (the last one may be shorter; a longer run is a piece of its own). One piece when the timeline is that short. */
export function piecesOf(parts: ExportPart[], runs: number[][]): number[][][] {
  if (parts.length <= EXPORT_PIECE.parts) return [runs];
  const pieces: number[][][] = [[]];
  let count = 0;
  for (const run of runs) {
    if (count >= EXPORT_PIECE.parts) {
      pieces.push([]);
      count = 0;
    }
    pieces.at(-1)!.push(run);
    count += run.length;
  }
  return pieces;
}

/**
 * The filter graph handed to ffmpeg in a file: on the command line it outgrew Windows' 32 767 characters at ~48 clips
 * with transitions (spawn ENAMETOOLONG). The option that reads it depends on the version (graphFileOption).
 */
async function graphFile(dir: string, name: string, chains: string[]): Promise<string[]> {
  const file = join(dir, name);
  await writeFile(file, chains.join(";"));
  return [await graphFileOption(), file];
}

const sec = (ms: number) => (ms / 1000).toFixed(3);
const STEREO = "aresample=48000,aformat=channel_layouts=stereo";

/** The files an ffmpeg run reads, in order: each added is read where it lies, or written into `dir` first (its bytes). */
class Inputs {
  readonly args: string[] = [];
  private n = 0;
  constructor(private readonly dir: string) {}
  /** The input's number and the file it is read from. */
  async add(name: string, source: Media, before: string[] = []): Promise<{ index: number; file: string }> {
    const file = await onDisk(this.dir, name, source);
    this.args.push(...before, "-i", file);
    return { index: this.n++, file };
  }
}

/**
 * Each part's colour nudge, a `lutyuv` to add to its picture's chain (empty when none): colour matching carries along, a
 * part matched to the part before as it will look, nudge included. The means at every join are read at once and the carry
 * worked out in order after. A part's means are read off its video's kept frame means (`means`, worked out once per video
 * and kept beside it); only without them is the file measured there (meansOf, two ffmpeg runs a join, through the pool).
 */
async function colourLooks(parts: ExportPart[], files: string[], match: boolean): Promise<string[]> {
  type Tune = { kind: "same" } | { kind: "match"; means: Promise<[Means | null, Means | null]> } | { kind: "reset" };
  const look = MATCH.lookSec;
  const at = (i: number, fromMs: number): Promise<Means | null> => {
    const kept = parts[i]!.means ? meansWithin(parts[i]!.means!, fromMs, look) : null;
    return kept ? Promise.resolve(kept) : meansOf(files[i]!, fromMs / 1000, look);
  };
  const tunes: Tune[] = parts.map((p, i) => {
    const prev = parts[i - 1];
    if (match && p.sameLook && prev?.kind === "video") return { kind: "same" };
    if (match && p.kind === "video" && !p.noMatch && prev?.kind === "video") {
      const means = Promise.all([at(i - 1, prev.endMs - look * 1000), at(i, p.matchAtMs ?? p.startMs + (p.blendMs ?? 0))]);
      // read later, in order: a failure is caught there (meansOf says none rather than failing)
      means.catch(() => {});
      return { kind: "match", means };
    }
    return { kind: "reset" };
  });
  const lut = (c: Means) => (c.y || c.u || c.v ? `,lutyuv=y='clip(val+(${c.y}),0,255)':u='clip(val+(${c.u}),0,255)':v='clip(val+(${c.v}),0,255)'` : "");
  let carry: Means = { y: 0, u: 0, v: 0 };
  const said: string[] = [];
  for (const [i, t] of tunes.entries()) {
    if (t.kind === "match") {
      const [a, b] = await t.means;
      carry = a && b ? colourNudge(a, b, carry) : { y: 0, u: 0, v: 0 };
    } else if (t.kind === "reset") carry = { y: 0, u: 0, v: 0 };
    said[i] = t.kind === "reset" ? "" : lut(carry);
  }
  return said;
}

/**
 * Each part's picture and sound as a chain of its own (`v<i>`, `a<i>`), for the parts numbered `which` (a piece of the
 * timeline, or all of it): cut to what plays, fitted into the frame, brought to one speed, colour-matched to the part
 * before (`looks`, colourLooks), held at its end when the part after fades in with a hold; its own sound, its sound file,
 * or silence, as long as its picture.
 */
async function partChains(parts: ExportPart[], files: string[], which: number[], inputs: Inputs, size: { W: number; H: number }, fps: number, looks: string[]): Promise<string[]> {
  const { W, H } = size;
  const chains: string[] = [];
  for (const i of which) {
    const p = parts[i]!;
    const length = sec(p.endMs - p.startMs);
    const { index: main } = await inputs.add(`part${i}.${p.ext}`, files[i]!, p.kind === "still" ? ["-loop", "1", "-t", length] : []);
    const fit = p.fill
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
    const tune = looks[i] ?? "";
    // the part after fades in over this one's end with a hold: this one holds its last frame (and silence) for as long
    const next = parts[i + 1];
    const padMs = next?.blendMs && next.kind === "video" && next.blendMode !== "overlap" ? Math.min(next.blendMs, (next.endMs - next.startMs) - FRAME_SLACK_MS) : 0;
    // a transition on either side: this part held on its last frame for half of the one after, on its first for half of its own
    const out = next?.transitionIn ? next.transitionIn.ms / 2 : 0;
    const into = i > 0 && p.transitionIn ? p.transitionIn.ms / 2 : 0;
    const pad = (padMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${sec(padMs)}` : "")
      + (out > 0 || into > 0 ? `,tpad=${[into > 0 ? `start_mode=clone:start_duration=${sec(into)}` : "", out > 0 ? `stop_mode=clone:stop_duration=${sec(out)}` : ""].filter(Boolean).join(":")}` : "");
    const padded = sec(p.endMs - p.startMs + padMs);
    // the sound is not held with the picture when the part after carries it on (see "freeze"), nor over a transition (it
    // runs straight on, its clock the clips'); it fades out and in over the halves when the transition asks
    const heard = next?.blendMode === "freeze" || out > 0 ? sec(p.endMs - p.startMs) : padded;
    const fades = [into > 0 && p.transitionIn!.fadeSound ? `afade=t=in:d=${sec(into)}` : "", out > 0 && next!.transitionIn!.fadeSound ? `afade=t=out:st=${sec(p.endMs - p.startMs - out)}:d=${sec(out)}` : ""].filter(Boolean).map((f) => `,${f}`).join("");
    chains.push(
      p.kind === "still"
        ? `[${main}:v]fps=${fps},${fit},setsar=1,format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS${pad}[v${i}]`
        // half a frame early, both ends: the frame on screen at startMs is taken. Cut exactly there, a frame that began a
        // fraction of a millisecond before (a seamless take's in-between frame, 895.8 ms against a 896 ms start) was dropped
        : `[${main}:v]trim=start=${sec(Math.max(0, p.startMs - 500 / fps))}:end=${sec(Math.max(0, p.endMs - 500 / fps))},setpts=PTS-STARTPTS,fps=${fps},${fit},setsar=1,format=yuv420p${tune}${pad}[v${i}]`,
    );
    const loud = `volume=${Math.max(0, p.volume).toFixed(2)}`;
    if (p.sound === "own" && p.kind === "video" && p.hasSound) {
      chains.push(`[${main}:a]atrim=start=${sec(p.startMs)}:end=${sec(p.endMs)},asetpts=PTS-STARTPTS,${STEREO},${loud},apad,atrim=duration=${heard}${fades}[a${i}]`);
    } else if (p.sound === "file" && p.soundFile) {
      const sound = (await inputs.add(`sound${i}.${p.soundFile.ext}`, p.soundFile.source)).index;
      chains.push(`[${sound}:a]${STEREO},${loud},apad,atrim=duration=${heard},asetpts=PTS-STARTPTS${fades}[a${i}]`);
    } else {
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${heard}[a${i}]`);
    }
  }
  return chains;
}

/**
 * The parts that fade into the one before, crossfaded in runs (runsOf; added to `chains`); each run's picture and sound out
 * (`outs`, to be put one after the other), and how long all of it lasts.
 */
function fadeRuns(parts: ExportPart[], runs: number[][], fps: number, chains: string[]): { outs: string[]; total: number } {
  const lenOf = (p: ExportPart) => p.endMs - p.startMs;
  const outs: string[] = [];
  let total = 0;
  for (const run of runs) {
    let v = `v${run[0]}`;
    let a = `a${run[0]}`;
    let len = lenOf(parts[run[0]!]!);
    for (const j of run.slice(1)) {
      const t = parts[j]!.transitionIn;
      if (t) {
        // centred on the cut: the run so far was held half of it past its end, this part half of it before its start
        // (partChains), so the two meet over the whole transition and the clock runs on as without it
        const kind = t.xfade === "custom" ? `custom:expr='${FLASH_EXPR}'` : t.xfade;
        chains.push(`[${v}][v${j}]xfade=transition=${kind}:duration=${sec(t.ms)}:offset=${sec(len - t.ms / 2)}[vx${j}]`);
        chains.push(`[${a}][a${j}]concat=n=2:v=0:a=1[ax${j}]`);
        len += lenOf(parts[j]!);
        v = `vx${j}`;
        a = `ax${j}`;
        continue;
      }
      const x = Math.min(parts[j]!.blendMs!, lenOf(parts[j]!) - FRAME_SLACK_MS);
      if (parts[j]!.blendMode === "overlap") {
        // the part starts x early, over the part before's last x: the fade is between the same moments, both moving
        chains.push(`[${v}][v${j}]xfade=transition=fade:duration=${sec(x)}:offset=${sec(len - x)}[vx${j}]`);
        chains.push(`[${a}][a${j}]acrossfade=d=${sec(x)}:c1=tri:c2=tri[ax${j}]`);
        len = len - x + lenOf(parts[j]!);
      } else {
        // the part before was held for x: the fade runs over that hold, from where the part before really ends. A freeze
        // starts on that last frame itself (begun a frame later, the still showed for 3 frames; the part after starts a
        // frame early to make up for it, see timelineExport)
        const early = parts[j]!.blendMode === "freeze" ? 1000 / fps : 0;
        chains.push(`[${v}][v${j}]xfade=transition=fade:duration=${sec(x)}:offset=${sec(len - early)}[vx${j}]`);
        // the sound crossfades over the hold, or (freeze) runs straight on: it was not held
        chains.push(parts[j]!.blendMode === "freeze" ? `[${a}][a${j}]concat=n=2:v=0:a=1[ax${j}]` : `[${a}][a${j}]acrossfade=d=${sec(x)}:c1=tri:c2=tri[ax${j}]`);
        len = len - early + lenOf(parts[j]!);
      }
      v = `vx${j}`;
      a = `ax${j}`;
    }
    outs.push(`[${v}][${a}]`);
    total += len;
  }
  return { outs, total };
}

/** The music as heard under the video, `[under]`: its part of the song, from where it starts, multiplied by its gain curve (ducked where people speak). */
function musicUnder(plan: MusicPlan, input: { index: number }, gainInput: { index: number }): string[] {
  const heard = Math.max(0, plan.endMs - plan.startMs);
  return [
    `[${input.index}:a]${STEREO},atrim=${plan.fromMs > 0 ? `start=${sec(plan.fromMs)}:` : ""}duration=${sec(heard)},asetpts=PTS-STARTPTS` +
      (plan.startMs > 0 ? `,adelay=delays=${Math.round(plan.startMs)}:all=1` : "") +
      "[music]",
    `[${gainInput.index}:a]${STEREO}[gain]`,
    "[music][gain]amultiply[under]",
  ];
}

/**
 * The music under the joined sound (`voices`, made `a`): the part of the song the plan says, from where it starts on the
 * video's clock to where it stops, multiplied by its gain (`gainInput`, musicGainWav): its volume and fades, each clip's
 * level, mute and fades, the ducking. Exported for the tests.
 */
export function musicChain(plan: MusicPlan, input: { index: number }, gainInput: { index: number }): string[] {
  return [...musicUnder(plan, input, gainInput), "[voices][under]amix=inputs=2:duration=first:normalize=0[a]"];
}

/**
 * The music alone, as it is heard under the video (the same part of the song, the same ducking), as long as the video:
 * a WAV for an editor's music track, laid at its start.
 */
export async function musicTrack(music: ExportMusic, totalMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const inputs = new Inputs(dir);
    const track = await inputs.add(`music.${music.ext}`, music.source);
    const chains = [...musicUnder(music.plan, track, await inputs.add("gain.wav", musicGainWav(music, totalMs))), `[under]apad=whole_dur=${sec(totalMs)}[a]`];
    const out = join(dir, "music.wav");
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", ...inputs.args, "-filter_complex", chains.join(";"), "-map", "[a]", "-t", sec(totalMs), "-c:a", "pcm_s16le", out], { timeout: 10 * 60_000, signal });
    return new Uint8Array(await readFile(out));
  });
}

/** The music's gain along the video, as the player sets it (musicGainAt), as a WAV the music is multiplied by. */
export const musicGainWav = (music: Pick<ExportMusic, "plan" | "duck">, totalMs: number) => gainWav((ms) => musicGainAt(music.plan, music.duck, ms), totalMs, 4000);

/** How many motion samples a second are measured. */
export const MOTION_RATE = 10;

/**
 * How much moves along a video, and how loud it is: ten samples a second each. Motion is the mean
 * difference between a frame and the one before, on a small grey copy (0 = still, 255 = everything
 * changed); loudness is the RMS level in dB of each tenth of a second (about -60 is silence, 0 is as
 * loud as it gets), null when there is no sound. For the curves under the ruler and the quiet moments
 * In and Out snap to. A sound file gives loudness only.
 */
export async function measureOf(source: Media, ext: string): Promise<{ motion: number[]; sound: number[] | null; speech: number[] | null }> {
  return ffmpegPool(() => inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    // the picture and the sound both, as most takes have: one ffmpeg run
    const tried = await measureAtOnce(dir, input, { video: true, sound: true });
    if (tried.measured) return tried.measured;
    // a file with only one of them (a video with no sound, a sound file): ffmpeg's refusal says which it has, and it is run
    // again for that one; anything else odd is measured as before, one stream at a time
    const only = /matches no streams/i.test(tried.log) ? { video: /Stream #0:\d+.*: Video:/.test(tried.log), sound: /Stream #0:\d+.*: Audio:/.test(tried.log) } : null;
    if (only && (only.video || only.sound)) {
      const again = await measureAtOnce(dir, input, only);
      if (again.measured) return again.measured;
    }
    return measureApart(input);
  }), { first: true });
}

/** RMS levels as measureOf keeps them: in dB, -90 for silence, to a tenth. */
const levelsIn = (said: string) => [...said.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf|inf|nan)/g)].map((m) => Number(m[1])).map((v) => (Number.isFinite(v) ? Math.max(-90, Math.min(0, Math.round(v * 10) / 10)) : -90));
const motionIn = (said: string) => {
  const motion = [...said.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  // the first sample is a frame against nothing
  if (motion.length) motion[0] = motion[1] ?? 0;
  return motion;
};

/**
 * measureOf's three measures in one ffmpeg run, the sound split in two (as it is and in a voice's band), each written to a
 * file of its own in `dir` (ffmpeg runs there: a Windows path in a filter's options needs escaping). Null with ffmpeg's log
 * when it refused (a stream asked for that the file does not have).
 */
async function measureAtOnce(dir: string, input: string, has: { video: boolean; sound: boolean }): Promise<{ measured: Awaited<ReturnType<typeof measureOf>> | null; log: string }> {
  const graph: string[] = [];
  const outs: string[] = [];
  const band = `aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;
  if (has.video) {
    graph.push(`[0:v]fps=${MOTION_RATE},scale=96:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=motion.txt[vo]`);
    outs.push("[vo]");
  }
  if (has.sound) {
    graph.push(`[0:a]asplit[a1][a2]`, `[a1]${band}:file=sound.txt[ao1]`, `[a2]highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,${band}:file=speech.txt[ao2]`);
    outs.push("[ao1]", "[ao2]");
  }
  const log = await new Promise<string | null>((done, fail) => {
    execFile(tools.ffmpeg, localInputs(["-hide_banner", "-loglevel", "info", "-nostats", "-i", resolve(input), "-filter_complex", graph.join(";"), ...outs.flatMap((o) => ["-map", o, "-f", "null", "-"])]),
      { cwd: dir, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return fail(new FfmpegMissing("This needs ffmpeg, which was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE."));
        done(err ? String(stderr) : null);
      });
  });
  if (log !== null) return { measured: null, log };
  const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => "");
  const motion = has.video ? motionIn(await read("motion.txt")) : [];
  const levels = has.sound ? levelsIn(await read("sound.txt")) : [];
  const sound = levels.length ? levels : null;
  const voice = sound ? levelsIn(await read("speech.txt")) : [];
  return { measured: { motion, sound, speech: voice.length ? voice : null }, log: "" };
}

/** measureOf as it was first written, a stream at a time after ffprobe says which there are: for a file the one run refused (and what the tests hold the one run to). */
export async function measureApart(input: string): Promise<{ motion: number[]; sound: number[] | null; speech: number[] | null }> {
  // a file ffprobe cannot read has nothing to measure; ffprobe not there at all is said
  const streams = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input]).catch((err: Error) => {
    if (err instanceof FfmpegMissing) throw err;
    return "";
  });
  let motion: number[] = [];
  if (/video/.test(streams)) {
    const said = await must(tools.ffmpeg, [
      "-loglevel", "error", "-i", input, "-an",
      "-vf", `fps=${MOTION_RATE},scale=96:-2,format=gray,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`,
      "-f", "null", "-",
    ], { timeout: 10 * 60_000 });
    motion = [...said.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    // the first sample is a frame against nothing
    if (motion.length) motion[0] = motion[1] ?? 0;
  }
  let sound: number[] | null = null;
  if (/audio/.test(streams)) {
    const said = await must(tools.ffmpeg, [
      "-loglevel", "error", "-i", input, "-vn",
      "-af", `aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f", "null", "-",
    ], { timeout: 10 * 60_000 }).catch(() => "");
    const levels = [...said.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf|inf|nan)/g)].map((m) => Number(m[1]));
    sound = levels.map((v) => (Number.isFinite(v) ? Math.max(-90, Math.min(0, Math.round(v * 10) / 10)) : -90));
    if (!sound.length) sound = null;
  }
  // the same in the band of a voice (300–3400 Hz, twice filtered): where people speak, for the music's ducking (duck.ts)
  let speech: number[] | null = null;
  if (sound) {
    const said = await must(tools.ffmpeg, [
      "-loglevel", "error", "-i", input, "-vn",
      "-af", `highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,aresample=8000,asetnsamples=n=${8000 / MOTION_RATE}:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      "-f", "null", "-",
    ], { timeout: 10 * 60_000 }).catch(() => "");
    const levels = [...said.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf|inf|nan)/g)].map((m) => Number(m[1]));
    speech = levels.length ? levels.map((v) => (Number.isFinite(v) ? Math.max(-90, Math.min(0, Math.round(v * 10) / 10)) : -90)) : null;
  }
  return { motion, sound, speech };
}

/**
 * Where a clip's motion dies before its end: the moment the frozen tail begins, or null when the clip
 * moves to the last. Over the part that plays (startMs to endMs) of a motion curve at `rate` samples a
 * second: a tail is frozen when its samples stay under a fifth of the clip's median motion (and under a
 * floor, for a clip that is calm throughout), for a quarter second or more, and for no more than a third
 * of the part. H3 often reaches its last frame early and holds it; a continuation handed that still
 * moment inherits the stillness and then lurches, so it is handed the last lively one instead.
 */
export function frozenTailAt(values: number[], rate: number, startMs: number, endMs: number): number | null {
  const a = Math.max(0, Math.floor((startMs / 1000) * rate));
  const b = Math.min(values.length, Math.ceil((endMs / 1000) * rate));
  const part = values.slice(a, b);
  if (part.length < rate) return null;
  const sorted = [...part].sort((p, q) => p - q);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const still = Math.max(0.3, median * 0.2);
  let n = 0;
  while (n < part.length && part[part.length - 1 - n]! < still) n++;
  const stillMs = (n / rate) * 1000;
  if (stillMs < 250 || stillMs > (endMs - startMs) / 3) return null;
  return Math.round(endMs - stillMs);
}

/**
 * The seam of a clip continued in the latent: the model's first free audio token after the guided overlap
 * comes out near-silent, a hole of about 30 ms right at the hand-over (measured at −70 dB against −45 dB
 * around it, in the raw decode too). The hole is cut out of the sound track with a short crossfade and the
 * track padded at its end: the sound then runs 36 ms ahead of the picture from the hand-over on, under what
 * anyone notices. The picture is untouched (stream copy).
 */
const JOIN_AUDIO_HOLE = { beforeMs: 8, afterMs: 28, fadeMs: 6 };
export async function repairJoinAudio(source: Media, ext: string, headMs: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const output = join(dir, "out.mp4");
    const a = Math.max(0, headMs - JOIN_AUDIO_HOLE.beforeMs) / 1000;
    const b = (headMs + JOIN_AUDIO_HOLE.afterMs) / 1000;
    await must(tools.ffmpeg, [
      "-loglevel", "error", "-y", "-i", input,
      "-filter_complex", `[0:a]atrim=end=${a.toFixed(3)},asetpts=PTS-STARTPTS[a1];[0:a]atrim=start=${b.toFixed(3)},asetpts=PTS-STARTPTS[a2];[a1][a2]acrossfade=d=${(JOIN_AUDIO_HOLE.fadeMs / 1000).toFixed(3)}:c1=tri:c2=tri,apad[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", output,
    ], { timeout: 10 * 60_000 });
    return new Uint8Array(await readFile(output));
  });
}

/** The moments ffmpeg's scene filter prints, from its showinfo lines ("pts_time:12.345"). */
export function parseSceneTimes(log: string): number[] {
  const out: number[] = [];
  for (const m of log.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const ms = Math.round(Number(m[1]) * 1000);
    if (Number.isFinite(ms) && ms > 0 && (out.length === 0 || ms - out[out.length - 1]! >= 400)) out.push(ms);
  }
  return out;
}

/**
 * Where a video cuts from one shot to the next: ffmpeg's scene-change score over `threshold` (0.3 is
 * its usual value: hard cuts, not pans), each as a moment in milliseconds. A video of one shot gives [].
 */
export async function scenesOf(source: Media, ext: string, threshold = 0.3): Promise<number[]> {
  return inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, source);
    const log = await new Promise<string>((done) => {
      execFile(
        tools.ffmpeg,
        localInputs(["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]),
        { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (_err, _stdout, stderr) => done(String(stderr ?? "")),
      );
    });
    return parseSceneTimes(log);
  });
}

/** ffmpeg's bytes, for a raw frame. */
function rawOut(tool: string, args: string[]): Promise<Buffer> {
  return new Promise((done, fail) => {
    execFile(tool, localInputs(args), { encoding: "buffer", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? fail(err) : done(stdout as Buffer)));
  });
}

/** One frame of a video (or a picture) as 96 × 54 grey pixels, to compare with another. */
async function grayAt(file: string, atMs: number): Promise<Uint8Array | null> {
  const out = await rawOut(tools.ffmpeg, ["-loglevel", "error", "-ss", (Math.max(0, atMs) / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=96:54,format=gray", "-f", "rawvideo", "-"]).catch(() => null);
  return out && out.length >= 96 * 54 ? new Uint8Array(out.subarray(0, 96 * 54)) : null;
}

const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
};

/**
 * How much the picture jumps across a join: the largest step from frame to frame as the join plays, against the
 * difference between neighbouring frames just after it (×1 = the join moves like the clip itself, ×3 = a visible
 * catch). A hard cut is one step, the last frame of one side to the first of the other. With a fade (the export's
 * and the player's) the steps are those of the fade, worked out from the frames 24 a second: "hold", the clip before
 * held on its last frame while this one fades in from its start; "overlap", both moving over the moments before
 * `b.atMs` (b starts `ms` early). Measured as a cut, every faded join read ×5 to ×9 (2026-10-08). null when a frame
 * cannot be read.
 */
export async function joinJump(
  a: { source: Media; ext: string; atMs: number },
  b: { source: Media; ext: string; atMs: number; fps: number },
  fade?: { ms: number; mode: "hold" | "overlap" } | null,
): Promise<number | null> {
  return inTemp(async (dir) => {
    const fa = await onDisk(dir, `a.${a.ext}`, a.source);
    const fb = await onDisk(dir, `b.${b.ext}`, b.source);
    // the last frame a length promises is not always there: a little earlier then
    const last = (await grayAt(fa, a.atMs)) ?? (await grayAt(fa, a.atMs - 100)) ?? (await grayAt(fa, a.atMs - 250));
    const first = (await grayAt(fb, b.atMs)) ?? (await grayAt(fb, b.atMs + FRAME_SLACK_MS));
    if (!last || !first) return null;
    const step = 1000 / Math.max(1, b.fps);
    const own: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = await grayAt(fb, b.atMs + k * step);
      const y = await grayAt(fb, b.atMs + (k + 1) * step);
      if (x && y) own.push(meanDiff(x, y));
    }
    const typical = Math.max(0.6, own.length ? own.reduce((s, v) => s + v, 0) / own.length : 0.6);
    if (!fade || fade.ms < 80) return Math.round(Math.min(20, meanDiff(last, first) / typical) * 10) / 10;
    // the fade, a model frame at a time: each frame a mix of the two sides, the second weighing more and more
    const model = 1000 / 24;
    const n = Math.max(2, Math.round(fade.ms / model));
    const mix = (x: Uint8Array, y: Uint8Array, w: number) => { const out = new Uint8Array(x.length); for (let i = 0; i < x.length; i++) out[i] = Math.round((1 - w) * x[i]! + w * y[i]!); return out; };
    const seq: Uint8Array[] = [];
    if (fade.mode === "hold") {
      seq.push(last);
      for (let k = 0; k < n; k++) {
        const y = await grayAt(fb, b.atMs + k * model);
        if (y) seq.push(mix(last, y, (k + 1) / (n + 1)));
      }
      const after = await grayAt(fb, b.atMs + n * model);
      if (after) seq.push(after);
    } else {
      for (let k = -1; k < n; k++) {
        const x = await grayAt(fa, a.atMs - fade.ms + k * model);
        const y = await grayAt(fb, b.atMs - fade.ms + k * model);
        if (x && y) seq.push(k < 0 ? x : mix(x, y, (k + 1) / (n + 1)));
      }
      seq.push(first);
    }
    let worst = 0;
    for (let k = 1; k < seq.length; k++) worst = Math.max(worst, meanDiff(seq[k - 1]!, seq[k]!));
    // read 24 a second: against the clip's own step at that rate
    return Math.round(Math.min(20, worst / Math.max(0.6, typical * (model / step))) * 10) / 10;
  });
}

/**
 * How much a continuation's picture jumps where its run-up (the frames regenerated from the clip before) ends
 * and its own frames begin: the difference across that one frame step, against the difference between the
 * frame steps right after (×1 = it carries on, ×3 = a visible catch, ×6 and past = a different shot). The
 * steps are the model's own, 24 a second: an interpolated file's in-between frames are stepped over, and each
 * seek lands a few milliseconds early so that a rounded `headMs` still picks the frame meant. null when a
 * frame cannot be read.
 */
export async function runUpBreak(bytes: Media, ext: string, headMs: number): Promise<number | null> {
  return inTemp(async (dir) => {
    const file = await onDisk(dir, `in.${ext}`, bytes);
    const step = 1000 / 24;
    const at = (k: number) => grayAt(file, headMs + k * step - 5);
    const before = await at(-1);
    const first = await at(0);
    if (!before || !first) return null;
    const own: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = await at(k);
      const y = await at(k + 1);
      if (x && y) own.push(meanDiff(x, y));
    }
    const typical = Math.max(0.6, own.length ? own.reduce((s, v) => s + v, 0) / own.length : 0.6);
    return Math.round(Math.min(20, meanDiff(before, first) / typical) * 10) / 10;
  });
}

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

/** The sound of a video as a sound file of its own (AAC in an .m4a). */
export async function soundOf(source: Media, ext: string): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, "sound.m4a");
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
    return new Uint8Array(await readFile(out));
  });
}

/** The same video without its sound: the picture copied as it is, nothing encoded again. */
export async function silentOf(source: Media, ext: string): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, `silent.${ext}`);
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-map", "0:v", "-c", "copy", "-an", "-movflags", "+faststart", out]);
    return new Uint8Array(await readFile(out));
  });
}

/**
 * The same video marked as made by a model (aiMark.ts): every stream copied as it is, frames and timestamps untouched,
 * only the container's comment added. An editor counts the same frames in it as in the library's file.
 */
export async function markedVideo(source: Media, ext: string): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = await onDisk(dir, `in.${ext}`, source);
    const out = join(dir, `marked.${ext}`);
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-map", "0", "-c", "copy", "-map_metadata", "0", ...aiVideoArgs, ...(ext === "webm" ? [] : ["-movflags", "+faststart"]), out], { timeout: 10 * 60_000 });
    return new Uint8Array(await readFile(out));
  });
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

/** What ffmpeg writes about a sound as it reads it (its own report, on stderr): volumedetect's and silencedetect's figures. */
function reportOf(args: string[]): Promise<string> {
  return new Promise<string>((done) => {
    execFile(tools.ffmpeg, localInputs(["-hide_banner", "-nostats", ...args, "-f", "null", "-"]), { encoding: "utf8", timeout: 60_000, windowsHide: true }, (_err, _stdout, stderr) => done(String(stderr)));
  });
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
