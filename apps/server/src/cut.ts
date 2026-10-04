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
        return fail(new CutError("This needs ffmpeg, which was not found on the machine Afflatus runs on. Install ffmpeg, or set FFMPEG and FFPROBE."));
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
export async function filmStrip(source: Uint8Array, ext: string, durationMs: number, opts: { frames?: number; height?: number; /** Only this part of the video, in milliseconds. */ fromMs?: number; toMs?: number } = {}): Promise<Uint8Array> {
  const frames = Math.max(2, Math.min(120, Math.round(opts.frames ?? STRIP.frames)));
  const height = Math.max(24, Math.min(240, Math.round(opts.height ?? STRIP.height)));
  const from = Math.max(0, Math.min(opts.fromMs ?? 0, durationMs));
  const to = Math.max(from + 40, Math.min(opts.toMs ?? durationMs, durationMs));
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "strip.jpg");
    await writeFile(input, source);
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
export async function peekAt(source: Uint8Array, ext: string, atMs: number, height = 160): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "peek.jpg");
    await writeFile(input, source);
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", (Math.max(0, atMs) / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale=-2:${Math.max(48, Math.min(480, height))}`, "-q:v", "4", out]);
    const bytes = await readFile(out).catch(() => null);
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
  source: Uint8Array, ext: string, facts: { durationMs: number; hasSound: boolean }, keep: Array<[number, number]>,
  opts: { crf?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const parts = keep.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(facts.durationMs, Math.max(a, b))] as [number, number]).filter(([a, b]) => b - a >= 20);
  if (!parts.length) throw new CutError("That range is too short to keep: nothing would be left.");
  const crf = Math.max(0, Math.min(40, Math.round(opts.crf ?? 10)));
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "kept.mp4");
    await writeFile(input, source);
    const sec = (ms: number) => (ms / 1000).toFixed(3);
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
  /**
   * Crossfaded in from the part before over this long: the part starts that much earlier than where it
   * plays, on frames that show the same moments as the end of the part before (a clip that extends the
   * one before it renders those frames again).
   */
  /** This part fades in over this many milliseconds. */
  blendMs?: number;
  /** "hold": the part before holds its last frame for as long, this one fades in after it (nothing of either is lost). "overlap": this part starts `blendMs` early, over the same moments as the part before's end, and the two are faded with both moving. */
  blendMode?: "hold" | "overlap";
}

/** How long a blended join crossfades, at most. */
/** How long a continuation fades in over the clip before, which holds its last frame meanwhile: four frames at 24 a second. */
export const BLEND_MS = 170;

/** The mean luma and chroma of a stretch of a video file, for matching one clip's colour to the next. */
async function meansOf(file: string, fromSec: number, seconds: number): Promise<{ y: number; u: number; v: number } | null> {
  const said = await must(tools.ffmpeg, ["-loglevel", "error", "-ss", Math.max(0, fromSec).toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-an", "-vf", "scale=96:-2,signalstats,metadata=print:file=-", "-f", "null", "-"]).catch(() => "");
  const pick = (key: string) => [...said.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const y = pick("YAVG");
  const u = pick("UAVG");
  const v = pick("VAVG");
  if (!y.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  return { y: mean(y), u: mean(u), v: mean(v) };
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
  opts: {
    scale?: number; music?: ExportMusic;
    /** Make it this many pictures a second by working out the pictures in between (slow, done on the processor). */
    smoothTo?: number;
    /** Nudge each video part's brightness and tint to the part before it at the join (means over the last and first moments). */
    match?: boolean;
    signal?: AbortSignal;
  } = {},
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
    // colour matching carries along: a part is matched to the part before as it will look, nudge included
    let carry = { y: 0, u: 0, v: 0 };
    let prevFile: string | null = null;
    let prevPart: ExportPart | null = null;
    for (const [i, p] of parts.entries()) {
      const length = sec(p.endMs - p.startMs);
      const file = join(dir, `part${i}.${p.ext}`);
      const main = await addInput(`part${i}.${p.ext}`, p.bytes, p.kind === "still" ? ["-loop", "1", "-t", length] : []);
      const fit = p.fill
        ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`
        : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
      let tune = "";
      if (opts.match && p.kind === "video" && prevPart?.kind === "video" && prevFile) {
        const look = 0.4;
        const a = await meansOf(prevFile, (prevPart.endMs - look * 1000) / 1000, look);
        const b = await meansOf(file, (p.startMs + (p.blendMs ?? 0)) / 1000, look);
        if (a && b) {
          // a nudge, never a grade: within a few steps of 255
          const nudge = (want: number, have: number) => Math.round(Math.max(-14, Math.min(14, want - have)) * 10) / 10;
          carry = { y: nudge(a.y + carry.y, b.y), u: nudge(a.u + carry.u, b.u), v: nudge(a.v + carry.v, b.v) };
          if (carry.y || carry.u || carry.v) tune = `,lutyuv=y='clip(val+(${carry.y}),0,255)':u='clip(val+(${carry.u}),0,255)':v='clip(val+(${carry.v}),0,255)'`;
        } else carry = { y: 0, u: 0, v: 0 };
      } else carry = { y: 0, u: 0, v: 0 };
      prevFile = file;
      prevPart = p;
      // the part after fades in over this one's end with a hold: this one holds its last frame (and silence) for as long
      const next = parts[i + 1];
      const padMs = next?.blendMs && next.kind === "video" && next.blendMode !== "overlap" ? Math.min(next.blendMs, (next.endMs - next.startMs) - 40) : 0;
      const pad = padMs > 0 ? `,tpad=stop_mode=clone:stop_duration=${sec(padMs)}` : "";
      const padded = sec(p.endMs - p.startMs + padMs);
      chains.push(
        p.kind === "still"
          ? `[${main}:v]fps=${fps},${fit},setsar=1,format=yuv420p,trim=duration=${length},setpts=PTS-STARTPTS${pad}[v${i}]`
          : `[${main}:v]trim=start=${sec(p.startMs)}:end=${sec(p.endMs)},setpts=PTS-STARTPTS,fps=${fps},${fit},setsar=1,format=yuv420p${tune}${pad}[v${i}]`,
      );
      const loud = `volume=${Math.max(0, p.volume).toFixed(2)}`;
      if (p.sound === "own" && p.kind === "video" && p.hasSound) {
        chains.push(`[${main}:a]atrim=start=${sec(p.startMs)}:end=${sec(p.endMs)},asetpts=PTS-STARTPTS,${stereo},${loud},apad,atrim=duration=${padded}[a${i}]`);
      } else if (p.sound === "file" && p.soundFile) {
        const file = await addInput(`sound${i}.${p.soundFile.ext}`, p.soundFile.bytes);
        chains.push(`[${file}:a]${stereo},${loud},apad,atrim=duration=${padded},asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${padded}[a${i}]`);
      }
    }
    const music = opts.music;
    // parts that blend into the one before are crossfaded in runs; the runs are then put one after the other
    const lenOf = (p: ExportPart) => p.endMs - p.startMs;
    const runs: number[][] = [];
    parts.forEach((p, i) => {
      if (i > 0 && p.blendMs && p.blendMs > 0) runs.at(-1)!.push(i);
      else runs.push([i]);
    });
    const outs: string[] = [];
    let total = 0;
    for (const run of runs) {
      let v = `v${run[0]}`;
      let a = `a${run[0]}`;
      let len = lenOf(parts[run[0]!]!);
      for (const j of run.slice(1)) {
        const x = Math.min(parts[j]!.blendMs!, lenOf(parts[j]!) - 40);
        if (parts[j]!.blendMode === "overlap") {
          // the part starts x early, over the part before's last x: the fade is between the same moments, both moving
          chains.push(`[${v}][v${j}]xfade=transition=fade:duration=${sec(x)}:offset=${sec(len - x)}[vx${j}]`);
          chains.push(`[${a}][a${j}]acrossfade=d=${sec(x)}:c1=tri:c2=tri[ax${j}]`);
          len = len - x + lenOf(parts[j]!);
        } else {
          // the part before was held for x: the fade runs over that hold, from where the part before really ends
          chains.push(`[${v}][v${j}]xfade=transition=fade:duration=${sec(x)}:offset=${sec(len)}[vx${j}]`);
          chains.push(`[${a}][a${j}]acrossfade=d=${sec(x)}:c1=tri:c2=tri[ax${j}]`);
          len = len + lenOf(parts[j]!);
        }
        v = `vx${j}`;
        a = `ax${j}`;
      }
      outs.push(`[${v}][${a}]`);
      total += len;
    }
    chains.push(`${outs.join("")}concat=n=${runs.length}:v=1:a=1[joined][${music ? "voices" : "a"}]`);
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

/** How many motion samples a second are measured. */
export const MOTION_RATE = 10;

/**
 * How much moves along a video, and how loud it is: ten samples a second each. Motion is the mean
 * difference between a frame and the one before, on a small grey copy (0 = still, 255 = everything
 * changed); loudness is the RMS level in dB of each tenth of a second (about -60 is silence, 0 is as
 * loud as it gets), null when there is no sound. For the curves under the ruler and the quiet moments
 * In and Out snap to. A sound file gives loudness only.
 */
export async function measureOf(source: Uint8Array, ext: string): Promise<{ motion: number[]; sound: number[] | null }> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    await writeFile(input, source);
    const streams = await must(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", input]).catch(() => "");
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
    return { motion, sound };
  });
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
export const JOIN_AUDIO_HOLE = { beforeMs: 8, afterMs: 28, fadeMs: 6 };
export async function repairJoinAudio(source: Uint8Array, ext: string, headMs: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const output = join(dir, "out.mp4");
    await writeFile(input, source);
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

/** Kept for the tests and callers that only want the motion. */
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
export async function scenesOf(source: Uint8Array, ext: string, threshold = 0.3): Promise<number[]> {
  return inTemp(async (dir) => {
    const file = join(dir, `in.${ext}`);
    await writeFile(file, source);
    const log = await new Promise<string>((done) => {
      execFile(
        tools.ffmpeg,
        ["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"],
        { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (_err, _stdout, stderr) => done(String(stderr ?? "")),
      );
    });
    return parseSceneTimes(log);
  });
}

export async function motionOf(source: Uint8Array, ext: string): Promise<number[]> {
  return (await measureOf(source, ext)).motion;
}

/** ffmpeg's bytes, for a raw frame. */
function rawOut(tool: string, args: string[]): Promise<Buffer> {
  return new Promise((done, fail) => {
    execFile(tool, args, { encoding: "buffer", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? fail(err) : done(stdout as Buffer)));
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
 * How much the picture jumps across a join: the difference between the last frame of one side and the
 * first frame of the other, against the difference between neighbouring frames just after the join
 * (×1 = the join moves like the clip itself, ×3 = a visible catch). null when a frame cannot be read.
 */
export async function joinJump(a: { bytes: Uint8Array; ext: string; atMs: number }, b: { bytes: Uint8Array; ext: string; atMs: number; fps: number }): Promise<number | null> {
  return inTemp(async (dir) => {
    const fa = join(dir, `a.${a.ext}`);
    const fb = join(dir, `b.${b.ext}`);
    await writeFile(fa, a.bytes);
    await writeFile(fb, b.bytes);
    // the last frame a length promises is not always there: a little earlier then
    const last = (await grayAt(fa, a.atMs)) ?? (await grayAt(fa, a.atMs - 100)) ?? (await grayAt(fa, a.atMs - 250));
    const first = (await grayAt(fb, b.atMs)) ?? (await grayAt(fb, b.atMs + 40));
    if (!last || !first) return null;
    const step = 1000 / Math.max(1, b.fps);
    const own: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = await grayAt(fb, b.atMs + k * step);
      const y = await grayAt(fb, b.atMs + (k + 1) * step);
      if (x && y) own.push(meanDiff(x, y));
    }
    const typical = Math.max(0.6, own.length ? own.reduce((s, v) => s + v, 0) / own.length : 0.6);
    return Math.round(Math.min(20, meanDiff(last, first) / typical) * 10) / 10;
  });
}

/** The sound slowed by `factor` with its pitch kept: atempo takes 0.5 at a time. */
const slowTempo = (factor: number) => Array.from({ length: Math.round(Math.log2(factor)) }, () => "atempo=0.5").join(",");

/**
 * A range of a video slowed down by `factor`, the frames in between worked out by ffmpeg's motion
 * interpolation (the fallback when there is no RIFE on the GPU): the same frame rate, `factor` times as
 * many frames, the sound slowed with its pitch kept. Slow: minutes for a few seconds.
 */
export async function slowMotion(source: Uint8Array, ext: string, facts: { durationMs: number; fps: number | null; hasSound: boolean }, startMs: number, endMs: number, factor: number, opts: { crf?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const fps = Math.max(1, Math.round(facts.fps ?? 24));
  const a = Math.max(0, Math.min(startMs, endMs));
  const b = Math.min(facts.durationMs, Math.max(startMs, endMs));
  if (b - a < 40) throw new CutError("That range is too short: pick at least one frame.");
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "slow.mp4");
    await writeFile(input, source);
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
export async function slowSoundOnto(slowed: Uint8Array, range: Uint8Array, factor: number): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const v = join(dir, "slow.mp4");
    const r = join(dir, "range.mp4");
    const out = join(dir, "with-sound.mp4");
    await writeFile(v, slowed);
    await writeFile(r, range);
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
export async function soundOf(source: Uint8Array, ext: string): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "sound.m4a");
    await writeFile(input, source);
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "192k", out]);
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
 * sound ends when that comes first.
 */
export async function soundPart(source: Uint8Array, ext: string, opts: { start: number; seconds: number; durationMs?: number | null }): Promise<Uint8Array> {
  return inTemp(async (dir) => {
    const input = join(dir, `in.${ext}`);
    const out = join(dir, "part.wav");
    await writeFile(input, source);
    const { start, seconds } = partOf(opts.start, opts.seconds, opts.durationMs ? opts.durationMs / 1000 : null);
    await must(tools.ffmpeg, ["-y", "-loglevel", "error", "-ss", start.toFixed(3), "-t", seconds.toFixed(3), "-i", input, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", out]);
    return new Uint8Array(await readFile(out));
  });
}
