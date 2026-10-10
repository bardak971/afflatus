import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Synthetic clips for checking the timeline frame by frame (timelineFrames.test.ts, scripts/check-player.ts): each frame
 * shows its clip number and its own index as a barcode, and the sound clicks every tenth frame. No GPU, ffmpeg only.
 */

export const W = 192;
export const H = 128;
export const BITS = 12;
export const ffmpegThere = spawnSync("ffmpeg", ["-version"]).status === 0;

/** ffmpeg's arguments for synth(), but the output file. */
function synthArgs(clip: number, frames: number, fps: number, size: { w: number; h: number }): string[] {
  const bit = (v: string) => `255*mod(floor(${v}/pow(2,floor(X*${W}/W/16))),2)`;
  const lum = `if(lt(Y*${H}/H,32),${bit("N")},if(lt(Y*${H}/H,64),${bit(String(clip))},128))`;
  const seconds = frames / fps;
  return [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=gray:s=${size.w}x${size.h}:r=${fps}:d=${seconds + 1}`,
    "-f", "lavfi", "-i", `aevalsrc='if(lt(mod(t*${fps},10),0.5),0.8*sin(2*PI*1000*t),0)':s=48000:d=${seconds}`,
    "-filter_complex", `[0:v]format=yuv420p,geq=lum='${lum}':cb=128:cr=128[v]`,
    "-map", "[v]", "-map", "1:a", "-frames:v", String(frames), "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
  ];
}

/** A clip whose every frame shows its number (second band) and its own index (first band), 16-pixel blocks, one per bit. */
export function synth(clip: number, frames: number, fps: number, size = { w: W, h: H }): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-frames-"));
  const file = join(dir, "c.mp4");
  const made = spawnSync("ffmpeg", [...synthArgs(clip, frames, fps, size), file]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  const bytes = new Uint8Array(readFileSync(file));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** synth() without blocking: several made side by side. */
export async function synthMade(clip: number, frames: number, fps: number, size = { w: W, h: H }): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "afflatus-frames-"));
  try {
    const file = join(dir, "c.mp4");
    await run("ffmpeg", [...synthArgs(clip, frames, fps, size), file]);
    return new Uint8Array(await readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Each frame of a video read back: its clip's number and its index (blocks read at their centres, brought back to W × H). */
export function readFrames(bytes: Uint8Array): Array<{ clip: number; index: number }> {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-read-"));
  const file = join(dir, "v.mp4");
  writeFileSync(file, bytes);
  const out = spawnSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=neighbor,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  rmSync(dir, { recursive: true, force: true });
  const raw = out.stdout as Buffer;
  const frames: Array<{ clip: number; index: number }> = [];
  for (let f = 0; f + W * H <= raw.length; f += W * H) {
    const word = (y: number) => [...Array(BITS)].reduce((n, _b, j) => n + (raw[f + y * W + j * 16 + 8]! > 128 ? 2 ** j : 0), 0);
    frames.push({ index: word(16), clip: word(48) });
  }
  return frames;
}

/** Where the clicks are in a video's sound, as frame numbers at `fps` (the frame each click begins in). */
export function clicks(bytes: Uint8Array, fps: number): number[] {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-clicks-"));
  const file = join(dir, "v.mp4");
  writeFileSync(file, bytes);
  const out = spawnSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  rmSync(dir, { recursive: true, force: true });
  const pcm = new Float32Array((out.stdout as Buffer).buffer.slice((out.stdout as Buffer).byteOffset, (out.stdout as Buffer).byteOffset + (out.stdout as Buffer).length));
  const per = 48000 / fps;
  const loud: boolean[] = [];
  for (let i = 0; i * per < pcm.length; i++) {
    let s = 0;
    for (let k = Math.floor(i * per); k < Math.min(pcm.length, Math.floor((i + 1) * per)); k++) s += pcm[k]! * pcm[k]!;
    loud.push(Math.sqrt(s / per) > 0.1);
  }
  return loud.flatMap((on, i) => (on && !loud[i - 1] ? [i] : []));
}

/** The frames a list of [clip, first, last] runs should export as, in order. */
export const runs = (...parts: Array<[number, number, number]>) => parts.flatMap(([clip, a, b]) => [...Array(b - a + 1)].map((_v, k) => ({ clip, index: a + k })));

/** Where a read sequence first leaves the expected one, for a failure that says where. */
export function firstMiss(got: Array<{ clip: number; index: number }>, want: Array<{ clip: number; index: number }>) {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i]?.clip !== want[i]?.clip || got[i]?.index !== want[i]?.index) return { at: i, got: got.slice(Math.max(0, i - 2), i + 3), want: want.slice(Math.max(0, i - 2), i + 3) };
  }
  return null;
}
