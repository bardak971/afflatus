import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "./video";

/**
 * Cutting videos: the few frames a new clip joins onto, one frame as a picture, a strip of frames for
 * the timeline, and a timeline as one file. Unlike reading a video's facts (video.ts), these cannot be
 * skipped when ffmpeg is missing: the error says so in words the person can act on.
 */
export class CutError extends Error {
  statusCode = 400;
}

function must(tool: string, args: string[], opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((done, fail) => {
    execFile(tool, args, { encoding: "utf8", timeout: opts.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: opts.signal }, (err, stdout, stderr) => {
      if (!err) return done(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return fail(new CutError("This needs ffmpeg, which was not found on the machine studai runs on. Install ffmpeg, or set FFMPEG and FFPROBE."));
      }
      if (err.name === "AbortError") return fail(new CutError("stopped by you"));
      const last = String(stderr).trim().split(/\r?\n/).pop() ?? "";
      fail(new CutError(`ffmpeg could not read or write the file${last ? `: ${last.slice(0, 300)}` : ""}`));
    });
  });
}

async function inTemp<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "studai-cut-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const countFrames = async (file: string) =>
  Number((await must(tools.ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file])).trim()) || 0;

/**
 * What a file brought in from the computer is, read from its bytes: a video or a sound, in which
 * container, and how long. null when ffprobe is not installed or the file is neither.
 */
export async function probeMedia(bytes: Uint8Array): Promise<{ kind: "video" | "audio"; mime: string; durationMs: number } | null> {
  return inTemp(async (dir) => {
    const file = join(dir, "in.bin");
    await writeFile(file, bytes);
    const out = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=format_name,duration", "-of", "json", file]).catch(() => null);
    if (!out) return null;
    try {
      const info = JSON.parse(out) as { streams?: Array<{ codec_type?: string; codec_name?: string }>; format?: { format_name?: string; duration?: string } };
      const names = (info.format?.format_name ?? "").split(",");
      // a picture is a "video" of one frame to ffprobe: only moving pictures count here
      const video = info.streams?.some((s) => s.codec_type === "video" && !["mjpeg", "png", "webp", "bmp", "gif"].includes(s.codec_name ?? ""));
      const audio = info.streams?.some((s) => s.codec_type === "audio");
      if (!video && !audio) return null;
      const has = (n: string) => names.includes(n);
      const mime = video
        ? has("webm") || has("matroska") ? "video/webm" : "video/mp4"
        : has("wav") ? "audio/wav" : has("mp3") ? "audio/mpeg" : has("flac") ? "audio/flac" : has("ogg") ? "audio/ogg" : has("mp4") || has("m4a") || has("mov") ? "audio/mp4" : null;
      if (!mime) return null;
      return { kind: video ? "video" : "audio", mime, durationMs: Math.round(Number(info.format?.duration ?? 0) * 1000) };
    } catch {
      return null;
    }
  });
}

/**
 * A video of a person as a reference for a video model: its first seconds at the model's speed, small
 * (a reference is read at every step: a small one costs less), and whether its sound is more than
 * silence, in which case it can stand for the person's voice.
 */
export async function referenceClip(source: Uint8Array, ext: string, opts: { seconds: number; fps: number; short: number }): Promise<{ bytes: Uint8Array; hasSound: boolean; width: number; height: number; frames: number }> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "ref.mp4");
    await writeFile(input, source);
    const streams = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input]);
    const audio = /audio/.test(streams);
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", "-i", input, "-t", String(opts.seconds),
      "-vf", `fps=${opts.fps},scale='if(lt(iw,ih),min(${opts.short},iw),-2)':'if(lt(iw,ih),-2,min(${opts.short},ih))',setsar=1`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"] : ["-an"]),
      out,
    ]);
    // a sound track that is silence is no voice: how loud it gets is read from ffmpeg's own report
    let hasSound = false;
    if (audio) {
      const report = await new Promise<string>((done) => {
        execFile(tools.ffmpeg, ["-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", timeout: 60_000, windowsHide: true }, (_err, _stdout, stderr) => done(String(stderr)));
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
}

/**
 * A few frames of a video as a small video of their own, with their sound: what a new clip is given of
 * the clip it carries on from (its last frames) or arrives at (its first ones).
 */
export async function cutFrames(
  source: Uint8Array, ext: string, facts: { durationMs: number; hasSound: boolean }, want: FramesWanted,
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
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "cut.mp4");
    await writeFile(input, source);
    // the last frame a length promises is not always there: when the cut comes out short, it is taken one frame earlier
    for (let attempt = 0; ; attempt++) {
      const from = start / fps;
      const to = (start + count) / fps;
      await must(tools.ffmpeg, [
        "-y", "-loglevel", "error", "-i", input,
        "-vf", `fps=${fps},trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        ...(facts.hasSound ? ["-af", `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS`, "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-pix_fmt", "yuv420p", out,
      ]);
      if ((await countFrames(out)) === count) break;
      if (attempt >= 2 || start === 0) throw new CutError("The frames to join onto could not be cut from that clip.");
      start--;
    }
    return { bytes: new Uint8Array(await readFile(out)), frames: count };
  });
}

/** One frame of a video as a PNG. A moment at or past the end gives the last frame. */
export async function frameAt(source: Uint8Array, ext: string, atMs: number, durationMs?: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "frame.png");
    await writeFile(input, source);
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

/** Frames of a video side by side in one picture (a JPEG), spread evenly over its length: what a clip shows on the timeline. */
export async function filmStrip(source: Uint8Array, ext: string, durationMs: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "strip.jpg");
    await writeFile(input, source);
    const every = Math.max(0.02, durationMs / 1000 / STRIP.frames);
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", "-i", input,
      "-vf", `fps=1/${every.toFixed(4)}:start_time=0:round=down,scale=-2:${STRIP.height},tile=${STRIP.frames}x1`,
      "-frames:v", "1", "-q:v", "5", out,
    ]);
    return new Uint8Array(await readFile(out));
  });
}

/** One thing that plays in an export: a part of a video, or a picture held for a while. */
export interface ExportPart {
  kind: "video" | "still";
  bytes: Uint8Array;
  ext: string;
  /** The part of a video that plays, in milliseconds. For a picture: 0 and how long it is held. */
  startMs: number;
  endMs: number;
  /** Whether the video has a sound of its own. */
  hasSound: boolean;
  /** What is heard: the video's own sound, nothing, or a sound file (cut or padded to the part's length). */
  sound: "own" | "muted" | "file";
  soundFile?: { bytes: Uint8Array; ext: string };
  /** 0 to 1. */
  volume: number;
  /** Of another shape than the frame: true = fills it (edges cut), false = shown whole, with bars. */
  fill: boolean;
}
export interface ExportMusic {
  bytes: Uint8Array;
  ext: string;
  durationMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Quieter while the clips' own sound is heard. */
  duck: boolean;
}

/**
 * Clips and pictures played one after the other, as one MP4: each cut to the part that plays, fitted
 * into the frame, brought to one speed; what has no sound is silent for its length; music, when there is
 * some, lies under all of it. `scale` enlarges every frame at the end (nothing is rendered again).
 */
export async function joinVideos(
  parts: ExportPart[], frame: { width: number; height: number }, fps: number,
  opts: { scale?: number; music?: ExportMusic; /** Make it this many pictures a second by working out the pictures in between (slow, done on the processor). */ smoothTo?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  if (!parts.length) throw new CutError("There is nothing to export yet.");
  const scale = opts.scale ?? 1;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const W = even(frame.width * scale);
  const H = even(frame.height * scale);
  return inTemp(async (dir) => {
    const inputs: string[] = [];
    let n = 0;
    const addInput = async (name: string, bytes: Uint8Array, before: string[] = []) => {
      const f = join(dir, name);
      await writeFile(f, bytes);
      inputs.push(...before, "-i", f);
      return n++;
    };
    const sec = (ms: number) => (ms / 1000).toFixed(3);
    const stereo = "aresample=48000,aformat=channel_layouts=stereo";
    const chains: string[] = [];
    for (const [i, p] of parts.entries()) {
      const length = sec(p.endMs - p.startMs);
      const main = await addInput(`part${i}.${p.ext}`, p.bytes, p.kind === "still" ? ["-loop", "1", "-t", length] : []);
      const fit = p.fill
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
      chains.push(
        p.kind === "still"
          ? `[${main}:v]fps=${fps},${fit},setsar=1,format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS[v${i}]`
          : `[${main}:v]trim=start=${sec(p.startMs)}:end=${sec(p.endMs)},setpts=PTS-STARTPTS,fps=${fps},${fit},setsar=1,format=yuv420p[v${i}]`,
      );
      const loud = `volume=${Math.max(0, p.volume).toFixed(2)}`;
      if (p.sound === "own" && p.kind === "video" && p.hasSound) {
        chains.push(`[${main}:a]atrim=start=${sec(p.startMs)}:end=${sec(p.endMs)},asetpts=PTS-STARTPTS,${stereo},${loud},apad,atrim=duration=${length}[a${i}]`);
      } else if (p.sound === "file" && p.soundFile) {
        const file = await addInput(`sound${i}.${p.soundFile.ext}`, p.soundFile.bytes);
        chains.push(`[${file}:a]${stereo},${loud},apad,atrim=duration=${length},asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${length}[a${i}]`);
      }
    }
    const total = parts.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
    const music = opts.music;
    chains.push(`${parts.map((_p, i) => `[v${i}][a${i}]`).join("")}concat=n=${parts.length}:v=1:a=1[joined][${music ? "voices" : "a"}]`);
    // enlarged frames are sharpened a little: scaling alone leaves them soft
    const smooth = opts.smoothTo && opts.smoothTo > fps ? `minterpolate=fps=${opts.smoothTo}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : "";
    chains.push(`[joined]${[smooth, scale > 1 ? "unsharp=5:5:0.6:5:5:0" : ""].filter(Boolean).join(",") || "null"}[v]`);
    if (music) {
      const file = await addInput(`music.${music.ext}`, music.bytes);
      const heard = Math.min(total, music.durationMs || total);
      const fadeOut = Math.min(music.fadeOutMs, heard);
      chains.push(
        `[${file}:a]${stereo},atrim=duration=${sec(heard)},volume=${Math.max(0, music.volume).toFixed(2)}` +
          (music.fadeInMs ? `,afade=t=in:st=0:d=${sec(Math.min(music.fadeInMs, heard))}` : "") +
          (fadeOut ? `,afade=t=out:st=${sec(heard - fadeOut)}:d=${sec(fadeOut)}` : "") +
          "[music]",
      );
      if (music.duck) {
        chains.push("[voices]asplit=2[heard][key]");
        chains.push("[music][key]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=700[under]");
        chains.push("[heard][under]amix=inputs=2:duration=first:normalize=0[a]");
      } else {
        chains.push("[voices][music]amix=inputs=2:duration=first:normalize=0[a]");
      }
    }
    const out = join(dir, "export.mp4");
    await must(tools.ffmpeg, [
      "-y", "-loglevel", "error", ...inputs,
      "-filter_complex", chains.join(";"), "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
    ], { timeout: 3 * 60 * 60_000, signal: opts.signal });
    return new Uint8Array(await readFile(out));
  });
}

/** The sound of a video as a sound file of its own (AAC in an .m4a). */
export async function soundOf(source: Uint8Array, ext: string): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "sound.m4a");
    await writeFile(input, source);
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
    return new Uint8Array(await readFile(out));
  });
}
