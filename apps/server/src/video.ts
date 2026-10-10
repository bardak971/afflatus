import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * What Afflatus reads from a video when it files it: its size, length, speed, whether it has sound, and
 * one frame to show in grids. This needs ffmpeg and ffprobe (on PATH, or named by FFMPEG and FFPROBE).
 * Without them everything still works: videos are stored and played, their tiles just have no picture.
 */
export const tools = { ffmpeg: process.env.FFMPEG?.trim() || "ffmpeg", ffprobe: process.env.FFPROBE?.trim() || "ffprobe" };

/**
 * A run's arguments with every input it reads limited to files and pipes. A file from a stranger can be a
 * playlist naming other addresses (a web address on the LAN, a service on this machine) that ffmpeg would
 * otherwise go and read; the option comes before each `-i` of ffmpeg, and first for ffprobe, whose input
 * is its last argument.
 */
export function localInputs(args: string[]): string[] {
  const only = ["-protocol_whitelist", "file,pipe"];
  return args.includes("-i") ? args.flatMap((a) => (a === "-i" ? [...only, a] : [a])) : [...only, ...args];
}

export interface VideoFacts {
  width: number;
  height: number;
  durationMs: number;
  fps: number;
  hasSound: boolean;
}

const warned = new Set<string>();
/** Run a tool; null when it is not installed or fails. A missing tool is said once, not per video. */
function run(tool: string, args: string[], encoding: "utf8" | "buffer"): Promise<string | Buffer | null> {
  return new Promise((done) => {
    execFile(tool, localInputs(args), { encoding, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true } as never, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT" && !warned.has(tool)) {
        warned.add(tool);
        console.warn(`[video] "${tool}" was not found: videos get no preview frame and no length. Install ffmpeg, or set FFMPEG and FFPROBE.`);
      }
      done(err ? null : (stdout as string | Buffer));
    });
  });
}

/** "16/1", "30000/1001" → frames per second. */
function rate(text: unknown): number {
  const [n, d] = String(text ?? "").split("/").map(Number);
  return n && d ? Math.round((n / d) * 1000) / 1000 : 0;
}

/** The facts and the first frame (a PNG) of a video. Either is null when it could not be read. */
export async function readVideo(bytes: Uint8Array, ext: string): Promise<{ facts: VideoFacts | null; frame: Uint8Array | null }> {
  // both tools need a file they can seek in: an MP4 keeps its index at the end
  const dir = await mkdtemp(join(tmpdir(), "afflatus-video-"));
  const file = join(dir, `in.${ext}`);
  try {
    await writeFile(file, bytes);
    return await readVideoFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The same for a video that is a file on this machine already (an upload written as it arrived). */
export async function readVideoFile(file: string): Promise<{ facts: VideoFacts | null; frame: Uint8Array | null }> {
  return { facts: await videoFacts(file), frame: await firstFrame(file) };
}

/** What ffprobe says of a video file: its size, length, speed and whether it has sound. Null when it could not be read. */
export async function videoFacts(file: string): Promise<VideoFacts | null> {
  const probed = await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file], "utf8");
  if (typeof probed !== "string") return null;
  try {
    return factsOf(JSON.parse(probed) as ProbeInfo);
  } catch {
    // an answer that is not JSON is no answer
    return null;
  }
}

/** The shape of ffprobe's JSON answer, as far as the facts need it. */
export interface ProbeInfo {
  streams?: Array<Record<string, unknown>>;
  format?: { duration?: string };
}

/** The facts read out of ffprobe's answer (probeMedia in cut.ts asks ffprobe once and reads them from the same answer). */
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
  const made = await run(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", out], "utf8");
  const frame = made === null ? null : await readFile(out).then((b) => new Uint8Array(b), () => null);
  await rm(out, { force: true }).catch(() => {});
  return frame;
}
