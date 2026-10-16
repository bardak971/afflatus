import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rangeKeep, scenesOf, silentOf, soundOf } from "../src/cut";
import { TimelineMedia } from "../src/timelineMedia";
import type { AssetRow, TimelineCore } from "../src/timelineModel";

/**
 * ffmpeg's runs as cut.ts starts them: each run's time limit is recorded, and a run can be made to end as one killed at
 * its limit does, without waiting for it.
 */
const runs = vi.hoisted(() => ({ timeouts: [] as Array<{ args: string[]; timeout: number | undefined }>, kill: false }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const execFile = (...all: unknown[]) => {
    const [, args, opts] = all as [string, string[], { timeout?: number } | undefined];
    runs.timeouts.push({ args, timeout: opts?.timeout });
    const done = all[all.length - 1];
    if (runs.kill && typeof done === "function") {
      setImmediate(() => (done as (err: Error, stdout: string, stderr: string) => void)(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }), "", ""));
      return { pid: 0 };
    }
    return (real.execFile as (...a: unknown[]) => unknown)(...all);
  };
  return { ...real, execFile };
});

afterEach(() => {
  runs.timeouts.length = 0;
  runs.kill = false;
});

/** A short video made with ffmpeg, in the container and codecs asked for. */
function made(ext: string, codecs: string[]): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-runs-"));
  const file = join(dir, `v.${ext}`);
  const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", ...codecs, file]);
  if (res.status !== 0) throw new Error(`ffmpeg: ${String(res.stderr)}`);
  const bytes = new Uint8Array(readFileSync(file));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"];

/** The codecs of a file's streams, by kind ("video", "audio"). */
function streamsOf(bytes: Uint8Array, ext: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-runs-"));
  const file = join(dir, `out.${ext}`);
  writeFileSync(file, bytes);
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return res.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.trim());
}

describe("a run of ffmpeg on a long video", () => {
  it("has a time limit that grows with the video's length: a range cut off a 10-minute import is not stopped at two minutes", async () => {
    const video = made("mp4", H264);
    // a range off the middle (not on keyframes): cut to the frame and encoded again, a run that reads the source from its start
    await rangeKeep(video, "mp4", { durationMs: 10 * 60_000, hasSound: true }, [[100, 700]]);
    const encode = runs.timeouts.find((r) => r.args.includes("-filter_complex"));
    expect(encode?.timeout).toBeGreaterThan(30 * 60_000);
    runs.timeouts.length = 0;
    await soundOf(video, "mp4", 10 * 60_000);
    expect(runs.timeouts.find((r) => r.args.includes("-vn"))?.timeout).toBeGreaterThan(30 * 60_000);
  });

  it("says it took too long and was stopped when it was killed at its limit, never that it could not read the file", async () => {
    const video = made("mp4", H264);
    runs.kill = true;
    await expect(soundOf(video, "mp4", 1000)).rejects.toThrow(/took more than \d+ s on this file and was stopped/);
  });
});

describe("the scene cuts of a video", () => {
  it("are an answer only from a run that went to the end: one killed or failed is an error, not 'no cuts' kept for good", async () => {
    const video = made("mp4", H264);
    expect(await scenesOf(video, "mp4")).toEqual([]);
    runs.kill = true;
    await expect(scenesOf(video, "mp4")).rejects.toThrow(/was stopped/);
    runs.kill = false;
    await expect(scenesOf(new Uint8Array(Buffer.from("not a video at all")), "mp4")).rejects.toThrow(/could not read/);
  });
});

describe("a video without its sound", () => {
  it("is made of an imported H.264 .mkv (filed as video/webm): written as matroska, its picture copied, its sound gone", async () => {
    const mkv = made("mkv", H264);
    const silent = await silentOf(mkv, "webm", 1000);
    expect(streamsOf(silent, "mkv")).toEqual(["h264,video"]);
    expect(Buffer.from(silent).subarray(0, 64).includes(Buffer.from("matroska", "latin1"))).toBe(true);
  });

  it("of a real WebM stays a WebM", async () => {
    const webm = made("webm", ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-c:a", "libopus"]);
    const silent = await silentOf(webm, "webm", 1000);
    expect(streamsOf(silent, "webm")).toEqual(["vp9,video"]);
    // the WebM muxer's own header (its DocType), not matroska's
    expect(Buffer.from(silent).subarray(0, 64).includes(Buffer.from("webm", "latin1"))).toBe(true);
  });
});

describe("the colour along a video, for the player's colour match", () => {
  it("is not kept when it could not be measured: the next ask measures it again", async () => {
    let reads = 0;
    const storage = {
      get: async (key: string) => {
        if (key === "assets/v.mp4") reads++;
        throw new Error("not there");
      },
      put: async () => {},
    };
    const media = new TimelineMedia({ storage } as unknown as TimelineCore);
    const asset = { id: "a".repeat(32), file_key: "assets/v.mp4", mime: "video/mp4" } as AssetRow;
    expect(await media.means(asset)).toBeNull();
    expect(await media.means(asset)).toBeNull();
    expect(reads).toBe(2);
  });
});
