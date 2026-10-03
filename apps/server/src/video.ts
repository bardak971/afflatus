import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What Afflatus reads from a video when it files it: its size, length, speed, whether it has sound, and
 * one frame to show in grids. This needs ffmpeg and ffprobe (on PATH, or named by FFMPEG and FFPROBE).
 * Without them everything still works: videos are stored and played, their tiles just have no picture.
 */
export const tools = { ffmpeg: process.env.FFMPEG?.trim() || "ffmpeg", ffprobe: process.env.FFPROBE?.trim() || "ffprobe" };

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
    execFile(tool, args, { encoding, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true } as never, (err, stdout) => {
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
    const probed = await run(tools.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file], "utf8");
    let facts: VideoFacts | null = null;
    if (typeof probed === "string") {
      try {
        const info = JSON.parse(probed) as { streams?: Array<Record<string, unknown>>; format?: { duration?: string } };
        const picture = info.streams?.find((s) => s.codec_type === "video");
        if (picture) {
          facts = {
            width: Number(picture.width) || 0,
            height: Number(picture.height) || 0,
            durationMs: Math.round(Number(info.format?.duration ?? 0) * 1000),
            fps: rate(picture.avg_frame_rate),
            hasSound: Boolean(info.streams?.some((s) => s.codec_type === "audio")),
          };
        }
      } catch {
        /* an answer that is not JSON is no answer */
      }
    }
    const out = join(dir, "frame.png");
    const made = await run(tools.ffmpeg, ["-y", "-loglevel", "error", "-i", file, "-frames:v", "1", out], "utf8");
    const frame = made === null ? null : await readFile(out).then((b) => new Uint8Array(b), () => null);
    return { facts, frame };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
