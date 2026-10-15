import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_PIECE, joinVideosInto, MATCH, piecesOf, runsOf, type ExportPart, type FrameMeans, type JoinOptions } from "../src/cut";
import { majorOf } from "../src/video";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { ffmpegThere } from "./framesKit";

/** A long timeline's export: its filter graph in a file, made in pieces, the pieces the same as the whole; the colour match from kept means. */

const run = promisify(execFile);

describe("ffmpeg's version", () => {
  it("is read off its first line, none for a nightly", () => {
    expect(majorOf("ffmpeg version 9.0.2-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers")).toBe(9);
    expect(majorOf("ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers")).toBe(6);
    expect(majorOf("ffmpeg version n7.1 Copyright (c) 2000-2024")).toBe(7);
    expect(majorOf("ffmpeg version N-112345-g0123456789 Copyright (c) 2000-2026")).toBeNull();
  });
});

const video = (startMs: number, endMs: number, extra: Partial<ExportPart> = {}): ExportPart => ({
  kind: "video", source: "", ext: "mp4", startMs, endMs, hasSound: true, sound: "own", volume: 1, fill: false, ...extra,
});

describe("a timeline's pieces", () => {
  it("are whole runs: never cut where a part fades or transitions into the one before", () => {
    const dissolve = { transitionIn: { kind: "dissolve", xfade: "fade", ms: 500, fadeSound: false } };
    const parts = [video(0, 1000), video(0, 1000, { blendMs: 250, blendMode: "hold" }), video(0, 1000), video(0, 1000, dissolve), video(0, 1000, dissolve), video(0, 1000), video(0, 1000)];
    expect(runsOf(parts)).toEqual([[0, 1], [2, 3, 4], [5], [6]]);
    const was = EXPORT_PIECE.parts;
    try {
      EXPORT_PIECE.parts = 2;
      expect(piecesOf(parts, runsOf(parts))).toEqual([[[0, 1]], [[2, 3, 4]], [[5], [6]]]);
      // a timeline as short as a piece is made whole
      EXPORT_PIECE.parts = 7;
      expect(piecesOf(parts, runsOf(parts))).toEqual([runsOf(parts)]);
    } finally {
      EXPORT_PIECE.parts = was;
    }
  });
});

describe.skipIf(!ffmpegThere)("a long export made by ffmpeg", () => {
  let dir: string;
  let clip: string;
  let other: string;
  let still: string;
  let tone: string;
  let red: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "afflatus-pieces-"));
    const made = (name: string, args: string[]) => run("ffmpeg", ["-y", "-loglevel", "error", ...args, join(dir, name)]).then(() => join(dir, name));
    [clip, other, still, tone, red] = await Promise.all([
      made("clip.mp4", ["-f", "lavfi", "-i", "testsrc2=s=64x36:r=24:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]),
      made("other.mp4", ["-f", "lavfi", "-i", "testsrc=s=48x36:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]),
      made("still.png", ["-f", "lavfi", "-i", "color=c=0x30a050:s=40x40", "-frames:v", "1"]),
      made("tone.wav", ["-f", "lavfi", "-i", "sine=frequency=220:duration=30"]),
      made("red.mp4", ["-f", "lavfi", "-i", "color=c=0x806060:s=64x36:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]),
    ]);
  }, FFMPEG_TIMEOUT);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** The export's fingerprint: every picture's moment and the decoded sound's checksum. */
  const exported = async (parts: ExportPart[], fps: number, opts: JoinOptions, pieceParts: number) => {
    const was = EXPORT_PIECE.parts;
    EXPORT_PIECE.parts = pieceParts;
    try {
      return await joinVideosInto(parts, { width: 64, height: 36 }, fps, opts, async (file) => {
        // ffprobe 5.1 writes an empty line after a frame that carries side data (x264's settings, on the first frame of
        // each piece): a line, not a frame
        const said = (await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file], { maxBuffer: 1 << 26 })).stdout;
        const pts = said.split(/\r?\n/).filter((l) => l.trim()).map((l) => Number.parseFloat(l));
        const sound = (await run("ffmpeg", ["-loglevel", "error", "-i", file, "-map", "0:a", "-f", "md5", "-"])).stdout.trim();
        return { pts, sound };
      });
    } finally {
      EXPORT_PIECE.parts = was;
    }
  };

  it("joins 60 clips with dissolves (the graph on the command line was past Windows' 32 767 characters)", async () => {
    const dissolve = { transitionIn: { kind: "dissolve", xfade: "fade", ms: 200, fadeSound: true } };
    const parts = Array.from({ length: 60 }, (_, i) => video(0, 500, { source: clip, ...(i > 0 ? dissolve : {}) }));
    const { pts } = await exported(parts, 24, {}, EXPORT_PIECE.parts);
    // the transitions keep the clock: 60 half seconds
    expect(pts.length).toBe(60 * 12);
  }, FFMPEG_TIMEOUT);

  /** Every kind of join, a picture held for a length that is no whole number of frames, a sound file, a clip with no sound. */
  const mixed = (): ExportPart[] => {
    const one = [
      video(0, 1000, { source: clip }),
      video(300, 1500, { source: clip, blendMs: 250, blendMode: "hold" }),
      video(500, 1700, { source: clip, transitionIn: { kind: "dissolve", xfade: "fade", ms: 400, fadeSound: true } }),
      { kind: "still", source: still, ext: "png", startMs: 0, endMs: 617, hasSound: false, sound: "muted", volume: 1, fill: true } satisfies ExportPart,
      video(0, 900, { source: other, hasSound: false, sound: "file", soundFile: { source: tone, ext: "wav" } }),
      video(0, 1000, { source: clip, blendMs: 170, blendMode: "freeze" }),
      video(1000, 2400, { source: clip, blendMs: 300, blendMode: "overlap" }),
      video(0, 800, { source: other, hasSound: false }),
    ];
    return [...one, ...one, ...one.slice(0, 3)];
  };
  const music = (lengthMs: number) => ({ source: tone, ext: "wav", plan: { startMs: 300, endMs: lengthMs, fromMs: 500, volume: 0.5, fadeInMs: 300, fadeOutMs: 300, spans: [] }, duck: null });

  it("in pieces is the whole timeline's clock and sound: every picture at the same moment, the same samples", async () => {
    const opts = { match: true, music: music(20_000) };
    const whole = await exported(mixed(), 24, opts, 100);
    const pieces = await exported(mixed(), 24, opts, 2);
    expect(pieces.pts.length).toBe(whole.pts.length);
    expect(pieces.pts).toEqual(whole.pts);
    expect(pieces.sound).toBe(whole.sound);
  }, FFMPEG_TIMEOUT);

  it("in pieces at the web's speed is the whole one's too: the speed changed across the pieces' joins", async () => {
    const opts = { webMb: 5 };
    const whole = await exported(mixed(), 48, opts, 100);
    const pieces = await exported(mixed(), 48, opts, 2);
    expect(pieces.pts).toEqual(whole.pts);
    expect(pieces.sound).toBe(whole.sound);
  }, FFMPEG_TIMEOUT);

  it("matches colour from the kept means of each video, measuring the file only without them", async () => {
    // one flat clip twice: measured, the two ends are the same and nothing is nudged; the kept means say the second is
    // darker by 8 steps, so it is brightened by 8
    const flat = (y: number): FrameMeans => ({ t: Array.from({ length: 48 }, (_, i) => (i * 1000) / 24), y: Array(48).fill(y), u: Array(48).fill(128), v: Array(48).fill(128) });
    const parts = (means?: [FrameMeans, FrameMeans]) => [video(0, 1000, { source: red, hasSound: false, means: means?.[0] }), video(0, 1000, { source: red, hasSound: false, means: means?.[1] })];
    const lumaAt = (file: string, sec: number) =>
      run("ffmpeg", ["-loglevel", "error", "-ss", sec.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=1:1:flags=area,format=gray", "-f", "rawvideo", "-"], { encoding: "buffer" }).then((r) => r.stdout[0]!);
    const step = (p: ExportPart[]) => joinVideosInto(p, { width: 64, height: 36 }, 24, { match: true }, async (file) => (await lumaAt(file, 1.5)) - (await lumaAt(file, 0.5)));
    expect(Math.abs(await step(parts()))).toBeLessThanOrEqual(1);
    expect(MATCH.mostSteps).toBeGreaterThan(8);
    expect(await step(parts([flat(100), flat(92)]))).toBeGreaterThanOrEqual(7);
  }, FFMPEG_TIMEOUT);
});
