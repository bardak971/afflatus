import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CutError, FfmpegMissing, grabFrame, hasStream, inTemp, streamKinds, tools } from "../src/ff";
import { frameAt } from "../src/cut";
import { firstFrame } from "../src/video";
import { ffmpegPool } from "../src/pool";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";

/**
 * The ffmpeg calls several files make alike, made in one place (ff.ts, card #261): the streams of a file, one frame of a
 * video, a temporary folder. Every frame a request asks for is taken in the ffmpeg pool: frameAt's was not.
 */
vi.mock("../src/pool", async (original) => {
  const real = await original<typeof import("../src/pool")>();
  return { ...real, ffmpegPool: vi.fn(real.ffmpegPool) };
});

const dir = mkdtempSync(join(tmpdir(), "zz-test-ff-"));
const real = { ...tools };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  Object.assign(tools, real);
  vi.mocked(ffmpegPool).mockClear();
});

/** A file made by ffmpeg from lavfi sources, in `dir`. */
function made(name: string, args: string[]): string {
  const file = join(dir, name);
  const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, file]);
  if (res.status !== 0) throw new Error(`ffmpeg: ${String(res.stderr)}`);
  return file;
}

describe.skipIf(!ffmpegThere)("the ffmpeg calls made in one place", { timeout: FFMPEG_TIMEOUT }, () => {
  const clip = () => made("clip.mp4", ["-f", "lavfi", "-i", "testsrc=s=64x48:r=24:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-pix_fmt", "yuv420p", "-c:a", "aac"]);

  it("list a file's streams with their lengths, and leave what a failure means to each caller", async () => {
    const streams = await streamKinds(clip());
    expect(streams.map((s) => s.kind)).toEqual(["video", "audio"]);
    expect(streams[0]!.seconds).toBeCloseTo(1, 1);
    expect(streams[1]!.seconds).toBeLessThan(0.7);
    expect(hasStream(streams, "audio")).toBe(true);
    const silent = await streamKinds(made("silent.mp4", ["-f", "lavfi", "-i", "testsrc=s=64x48:r=24:d=0.5", "-pix_fmt", "yuv420p"]));
    expect(hasStream(silent, "audio")).toBe(false);

    // a file that is no video, and no ffprobe at all, are two different errors
    const junk = join(dir, "junk.mp4");
    writeFileSync(junk, "not a video");
    await expect(streamKinds(junk)).rejects.toBeInstanceOf(CutError);
    await expect(streamKinds(junk)).rejects.not.toBeInstanceOf(FfmpegMissing);
    tools.ffprobe = "no-such-ffprobe";
    await expect(streamKinds(junk)).rejects.toBeInstanceOf(FfmpegMissing);
  });

  it("take one frame in the ffmpeg pool, or none past the last frame", async () => {
    const file = clip();
    const png = (b: Uint8Array | null) => Boolean(b && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);
    expect(png(await grabFrame(file, join(dir, "first.png")))).toBe(true);
    expect(png(await grabFrame(file, join(dir, "late.png"), { atMs: 5000 }))).toBe(false);
    expect(png(await grabFrame(file, join(dir, "last.png"), { last: true }))).toBe(true);
    expect(vi.mocked(ffmpegPool)).toHaveBeenCalledTimes(3);
  });

  it("take frameAt's frame in the pool too, as peekAt's and filmStrip's were (it ran beside a full pool)", async () => {
    const frame = await frameAt(clip(), "mp4", 400);
    expect(frame.length).toBeGreaterThan(0);
    expect(vi.mocked(ffmpegPool)).toHaveBeenCalled();
  });

  it("take a video's first frame as before: null without ffmpeg, never thrown", async () => {
    const file = clip();
    expect(await firstFrame(file)).not.toBeNull();
    expect(existsSync(`${file}.frame.png`)).toBe(false);
    tools.ffmpeg = "no-such-ffmpeg";
    expect(await firstFrame(file)).toBeNull();
  });
});

describe("a temporary folder", () => {
  it("is removed after the work, whether it ended or threw", async () => {
    let kept = "";
    await inTemp(async (d) => {
      kept = d;
      writeFileSync(join(d, "x"), "x");
    }, "zz-test");
    expect(kept).toMatch(/afflatus-zz-test-/);
    expect(existsSync(kept)).toBe(false);
    await expect(inTemp(async (d) => {
      kept = d;
      throw new Error("work failed");
    })).rejects.toThrow("work failed");
    expect(existsSync(kept)).toBe(false);
  });
});
