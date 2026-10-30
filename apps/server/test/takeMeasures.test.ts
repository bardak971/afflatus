import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { filmStrip } from "../src/cut";
import { lookOf, measureOf, meansAlong, takeMeasures } from "../src/measure";
import { joinJump, lastFrameAt, LEAST_MOTION, runUpBreak, runUpCut } from "../src/joinScore";
import { measureLanded } from "../src/precompute";
import { keptKey, keptMotion } from "../src/timelineMedia";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";

/**
 * A take measured once as it lands (takeMeasures, measureLanded) gives the figures each measure gave in a pass of its own;
 * a join read in one run per side (joinJump, runUpBreak) the figures of a seek per frame. Skipped where ffmpeg is not installed.
 */

/** Three seconds that move, with a hard cut at 1.5 s and a tone: every figure has something to read. */
const moving = () =>
  ffmpegMade([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
    "-vf", "negate=enable='gte(t,1.5)',noise=alls=12:allf=t", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
  ]);

/** One frame of a video as 96 × 54 grey pixels, by a seek of its own: how the joins read each frame before. */
function grayBySeek(file: string, atMs: number): Uint8Array | null {
  try {
    const out = execFileSync("ffmpeg", ["-loglevel", "error", "-ss", (Math.max(0, atMs) / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=96:54,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 });
    return out.length >= 96 * 54 ? new Uint8Array(out.subarray(0, 96 * 54)) : null;
  } catch {
    return null;
  }
}
const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length;

describe.skipIf(!ffmpegThere)("a take measured once", { timeout: FFMPEG_TIMEOUT }, () => {
  let dir: string;
  let file: string;
  let silent: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "afflatus-take-"));
    file = join(dir, "take.mp4");
    silent = join(dir, "silent.mp4");
    writeFileSync(file, await moving());
    writeFileSync(silent, await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]));
  }, FFMPEG_TIMEOUT);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("gives the look, motion, loudness, frame means and film strip each pass gave on its own", async () => {
    for (const [f, hasSound, ms] of [[file, true, 3000], [silent, false, 2000]] as const) {
      const all = await takeMeasures(f, "mp4", { durationMs: ms, hasSound });
      expect(all).not.toBeNull();
      expect(all!.look).toEqual(await lookOf(f, "mp4"));
      expect(all!.motion).toEqual(await measureOf(f, "mp4"));
      expect(all!.means).toEqual(await meansAlong(f, "mp4"));
      expect(Buffer.from(all!.strip!).equals(Buffer.from(await filmStrip(f, "mp4", ms)))).toBe(true);
    }
  });

  it("without the look (a video that is no render), gives the motion, loudness, frame means and film strip each pass gave", async () => {
    for (const [f, hasSound, ms] of [[file, true, 3000], [silent, false, 2000]] as const) {
      const light = await takeMeasures(f, "mp4", { durationMs: ms, hasSound, look: false });
      expect(light!.look).toBeNull();
      expect(light!.motion).toEqual(await measureOf(f, "mp4"));
      expect(light!.means).toEqual(await meansAlong(f, "mp4"));
      expect(Buffer.from(light!.strip!).equals(Buffer.from(await filmStrip(f, "mp4", ms)))).toBe(true);
      // and without the strip (past a minute, made by its keyframes): the rest the same
      const bare = await takeMeasures(f, "mp4", { durationMs: ms, hasSound, look: false, strip: false });
      expect(bare).toEqual({ ...light, strip: null });
    }
  });

  it("fills a short take's strip to its last place, its sound running past its picture or not", async () => {
    // LTX 2.5's sound runs 15 ms past its picture: the strip spread over the longer length, as the asset's says it
    const longer = join(dir, "longer.mp4");
    writeFileSync(longer, await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=3.015", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]));
    for (const [f, ms] of [[file, 3000], [silent, 2000], [longer, 3015]] as const) {
      for (const strip of [await filmStrip(f, "mp4", ms), (await takeMeasures(f, "mp4", { durationMs: ms, hasSound: f !== silent }))!.strip!]) {
        const { data, info } = await sharp(Buffer.from(strip)).greyscale().raw().toBuffer({ resolveWithObject: true });
        const w = info.width / 12;
        let sum = 0;
        for (let y = 0; y < info.height; y++) for (let x = 11 * w; x < 12 * w; x++) sum += data[y * info.width + x]!;
        // a frame of the test picture, not the black tile leaves where no frame came
        expect(sum / (w * info.height)).toBeGreaterThan(20);
      }
    }
  });

  it("measures a continuation's look from its own part, as a seek there does", async () => {
    for (const from of [1000, 1042, 1500]) {
      const all = await takeMeasures(file, "mp4", { fromMs: from, durationMs: 3000, hasSound: true });
      expect(all!.look).toEqual(await lookOf(file, "mp4", from));
    }
  });

  it("puts the motion, strip and means where the editor finds them done, with the look and its run-up step", async () => {
    const put = new Map<string, Uint8Array>();
    const look = await measureLanded(async (k, b) => void put.set(k, b), "abcd1234", file, "mp4", { durationMs: 3000, hasSound: true }, 1500);
    expect(look).toEqual({ ...(await lookOf(file, "mp4", 1500)), handover: await runUpBreak(file, "mp4", 1500), runUpCut: await runUpCut(file, "mp4", 1500) });
    expect([...put.keys()].sort()).toEqual([keptKey.means("abcd1234"), keptKey.motion("abcd1234"), keptKey.strip("abcd1234")].sort());
    expect(JSON.parse(Buffer.from(put.get(keptKey.motion("abcd1234"))!).toString())).toEqual(keptMotion(await measureOf(file, "mp4")));
    // nothing to read: no look, nothing put
    const none = new Map<string, Uint8Array>();
    expect(await measureLanded(async (k, b) => void none.set(k, b), "ffff0000", new Uint8Array([1, 2, 3]), "mp4", { durationMs: 1000, hasSound: false })).toBeNull();
    expect(none.size).toBe(0);
  });

  it("reads a join's frames in one run per side as a seek per frame read them", async () => {
    // the run-up step against frames read one seek at a time, at moments on and between frames
    for (const head of [1000, 1500, 1042, 1500 + 1000 / 48]) {
      const step = 1000 / 24;
      const at = (k: number) => grayBySeek(file, head + k * step - 5);
      const own = [0, 1, 2].map((k) => diff(at(k)!, at(k + 1)!));
      const typical = Math.max(LEAST_MOTION, own.reduce((s, v) => s + v, 0) / own.length);
      expect(await runUpBreak(file, "mp4", head)).toBe(Math.round(Math.min(20, diff(at(-1)!, at(0)!) / typical) * 10) / 10);
    }
    // a cut join and a held one, the last frame past the end of the clip before read a little earlier
    const a = { source: file, ext: "mp4", atMs: 3000 };
    const b = { source: silent, ext: "mp4", atMs: 0, fps: 30 };
    const last = grayBySeek(file, 3000) ?? grayBySeek(file, 2900) ?? grayBySeek(file, 2750);
    const own = [0, 1, 2].map((k) => diff(grayBySeek(silent, (k * 1000) / 30)!, grayBySeek(silent, ((k + 1) * 1000) / 30)!));
    const typical = Math.max(LEAST_MOTION, own.reduce((s, v) => s + v, 0) / own.length);
    expect(await joinJump(a, b)).toBe(Math.round(Math.min(20, diff(last!, grayBySeek(silent, 0)!) / typical) * 10) / 10);
    expect(await joinJump(a, b, { ms: 170, mode: "hold" })).toBeGreaterThan(0);
    expect(await joinJump(a, { ...b, atMs: 9000 })).toBeNull();
  });
});

describe.skipIf(!ffmpegThere)("a join read on the clip before's last frame", { timeout: FFMPEG_TIMEOUT }, () => {
  it("reads it there at 24, 32 and 48 a second: a ramp carried on across the join steps as it does on either side", async () => {
    for (const fps of [24, 32, 48]) {
      // the picture brightens 3 levels a frame, the clip after carrying on from where the clip before stopped
      const ramp = (from: number) => ffmpegMade(["-f", "lavfi", "-i", `color=c=gray:size=192x108:rate=${fps}:duration=2`, "-vf", `format=yuv420p,geq=lum='${from}+3*N':cb=128:cr=128`, "-frames:v", "40", "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p"]);
      const [a, b] = [await ramp(20), await ramp(20 + 3 * 40)];
      const end = Math.round((40 * 1000) / fps);
      const at = (ms: number) => joinJump({ source: a, ext: "mp4", atMs: ms }, { source: b, ext: "mp4", atMs: 0, fps });
      expect(await at(lastFrameAt(end, fps)), `${fps} a second`).toBeLessThanOrEqual(1.2);
      // 20 ms before the end fell past the last frame at 32 and 48 a second: read 100 ms earlier, it jumped several frames' worth
      if (fps === 32) expect(await at(end - 20)).toBeGreaterThan(2);
    }
  });
});

describe.skipIf(!ffmpegThere)("the film strip of a long video", { timeout: FFMPEG_TIMEOUT }, () => {
  it("shows the keyframe at or before each moment past a minute, decoding nothing else", async () => {
    // 70 s, a keyframe every 10 s, a picture that changes every frame: two moments 5.8 s apart show the same keyframe
    const long = await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=64x36:rate=10:duration=70", "-c:v", "libx264", "-g", "100", "-keyint_min", "100", "-sc_threshold", "0", "-pix_fmt", "yuv420p"]);
    const strip = await filmStrip(long, "mp4", 70_000);
    const { data, info } = await sharp(Buffer.from(strip)).greyscale().raw().toBuffer({ resolveWithObject: true });
    const w = info.width / 12;
    const tile = (k: number) => Uint8Array.from({ length: w * info.height }, (_, i) => data[Math.floor(i / w) * info.width + k * w + (i % w)]!);
    // the first two moments (0 s, 5.8 s) both before the second keyframe: the same picture; the third (11.7 s) another
    expect(diff(tile(0), tile(1))).toBeLessThan(2);
    expect(diff(tile(1), tile(2))).toBeGreaterThan(2);
    // the strip runs to its end: its last place shows the last keyframe (60 s), not nothing
    expect(diff(tile(11), new Uint8Array(tile(11).length))).toBeGreaterThan(20);
    expect(diff(tile(10), tile(11))).toBeGreaterThan(2);
  });
});
