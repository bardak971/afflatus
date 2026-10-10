import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export { ffmpegThere } from "./framesKit";

/**
 * Test clips made with ffmpeg, for the files that need real videos. Each file makes its clips once, in a `beforeAll`, and
 * all of them at once: made one after the other at import time (spawnSync) they held up the collection of every file in
 * the same worker, and were made again by each file that wanted the same clip.
 */

const run = promisify(execFile);

/** What ffmpeg writes with these arguments (the output file is added at the end), as bytes. */
export async function ffmpegMade(args: string[], ext = "mp4"): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "afflatus-clip-"));
  try {
    const file = join(dir, `clip.${ext}`);
    await run("ffmpeg", ["-y", "-loglevel", "error", ...args, file]);
    return new Uint8Array(await readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A moving pattern and a 330 Hz tone (none when `sound` is false), H.264 and AAC. */
export const patternClip = (seconds: number, opts: { fps?: number; sound?: boolean; size?: string } = {}) =>
  ffmpegMade([
    "-f", "lavfi", "-i", `testsrc2=size=${opts.size ?? "192x320"}:rate=${opts.fps ?? 24}:duration=${seconds}`,
    ...(opts.sound === false ? [] : ["-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-c:a", "aac", "-shortest"]),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]);

/** A 440 Hz tone as a sound file. */
export const toneFile = (seconds: number) => ffmpegMade(["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`], "wav");

/**
 * How long a test that runs ffmpeg itself may take. They take a few seconds alone; with every file running at once
 * (and on CI's smaller runners) three to five times that.
 */
export const FFMPEG_TIMEOUT = 120_000;
