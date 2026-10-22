import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rangeKeep, silentOf, soundOf } from "../src/cut";
import { scenesOf } from "../src/measure";
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

describe("a range of a video kept", () => {
  /** 8 s that change every frame, a keyframe every second, a tone: a bound between keyframes has frames to get wrong. */
  const source = () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-runs-"));
    const file = join(dir, "v.mp4");
    const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
      "-vf", "noise=alls=30:allf=t", "-c:v", "libx264", "-g", "24", "-keyint_min", "24", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
    if (res.status !== 0) throw new Error(`ffmpeg: ${String(res.stderr)}`);
    return { dir, file };
  };
  /** What a file decodes to: every frame's checksum and the sound's. */
  const decoded = (file: string) => ({
    frames: spawnSync("ffmpeg", ["-loglevel", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter((l) => l && !l.startsWith("#")),
    sound: spawnSync("ffmpeg", ["-loglevel", "error", "-i", file, "-map", "0:a", "-f", "md5", "-"], { encoding: "utf8" }).stdout.trim(),
  });

  it("is the same frames and sound read from just before it as read from the file's start", async () => {
    const { dir, file } = source();
    try {
      // lossless, so that what is compared is what was cut, not what an encoder made of it
      for (const keep of [[[3530, 5262.5]], [[4000, 6500]], [[2041.6667, 7900]], [[0, 2500], [3999, 8000]]] as Array<Array<[number, number]>>) {
        const ours = await rangeKeep(file, "mp4", { durationMs: 8000, hasSound: true }, keep, { crf: 0 }, async (out) => decoded(out));
        // as it was cut before: the whole file read from its start, each part trimmed out of it
        const out = join(dir, "before.mp4");
        const s = (ms: number) => (ms / 1000).toFixed(3);
        const chains = keep.map(([a, b], i) => `[0:v]trim=start=${s(a)}:end=${s(b)},setpts=PTS-STARTPTS,scale=trunc(iw/2)*2:trunc(ih/2)*2[v${i}];[0:a]atrim=start=${s(a)}:end=${s(b)},asetpts=PTS-STARTPTS[a${i}]`);
        const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-filter_complex", [...chains, `${keep.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${keep.length}:v=1:a=1[v][a]`].join(";"),
          "-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-c:v", "libx264", "-preset", "veryfast", "-crf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
        expect(res.status).toBe(0);
        const before = decoded(out);
        expect(ours.frames.length, JSON.stringify(keep)).toBe(before.frames.length);
        expect(ours.frames, JSON.stringify(keep)).toEqual(before.frames);
        expect(ours.sound, JSON.stringify(keep)).toBe(before.sound);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("is read from a second before it and a second past it, and its keyframes looked for only there", async () => {
    const { dir, file } = source();
    try {
      await rangeKeep(file, "mp4", { durationMs: 8000, hasSound: true }, [[5500, 6500]]);
      // the stream copy is asked about its two bounds only, not the whole file's keyframes
      const probe = runs.timeouts.find((r) => r.args.includes("-skip_frame"));
      expect(probe?.args[probe.args.indexOf("-read_intervals") + 1]).toBe("5.450%5.550,6.450%6.550");
      // the re-encode: from 4 s for 4 s (to 8 s), the part trimmed at 1.5 s to 2.5 s of that
      const encode = runs.timeouts.find((r) => r.args.includes("-filter_complex"))!;
      expect(encode.args.slice(0, encode.args.indexOf("-i")).join(" ")).toContain("-ss 4 -t 4");
      expect(encode.args[encode.args.indexOf("-filter_complex") + 1]).toContain("[0:v]trim=start=1.500:end=2.500");
      runs.timeouts.length = 0;
      // a removal: the part before read from the start up to a second past it, the part after from a second before it
      await rangeKeep(file, "mp4", { durationMs: 8000, hasSound: true }, [[0, 2500], [3999, 8000]]);
      const removal = runs.timeouts.find((r) => r.args.includes("-filter_complex"))!.args;
      expect(removal.filter((a) => a === "-i")).toHaveLength(3);
      // each opening of the file, by what is said before it: the sound's from the start, its picture's packets passed over
      const opened = removal.join(" ").split(/ -i \S+/).slice(0, -1).map((s) => s.replace(/^.*-loglevel error ?/, "").replace(/ ?-protocol_whitelist \S+/, "").trim());
      expect(opened).toEqual(["-t 4", "-ss 2 -t 7", "-discard:v all -t 9"]);
      runs.timeouts.length = 0;
      // on keyframes at both ends: copied as it is, as before
      await rangeKeep(file, "mp4", { durationMs: 8000, hasSound: true }, [[4000, 6000]]);
      expect(runs.timeouts.some((r) => r.args.includes("copy"))).toBe(true);
      expect(runs.timeouts.some((r) => r.args.includes("-filter_complex"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
