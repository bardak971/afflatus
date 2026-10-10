import { beforeAll, describe, expect, it } from "vitest";
import { lookOf, runUpBreak } from "../src/cut";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";

/** A test clip of a second (two with a hard cut at one second: the picture inverts there), crisp or blurred and darkened, with a 330 Hz tone or silent, made with ffmpeg. Skipped where ffmpeg is not installed. */
const makeClip = (opts: { soft?: boolean; tone?: boolean; cut?: boolean }) =>
  ffmpegMade([
    "-f", "lavfi", "-i", `testsrc2=size=320x192:rate=24:duration=${opts.cut ? 2 : 1}`,
    ...(opts.tone ? ["-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-c:a", "aac", "-shortest"] : []),
    ...(opts.soft ? ["-vf", "gblur=sigma=3,eq=brightness=-0.15"] : opts.cut ? ["-vf", "negate=enable='gte(t,1)'"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]);

describe.skipIf(!ffmpegThere)("the look of a clip", { timeout: FFMPEG_TIMEOUT }, () => {
  let crisp: Uint8Array;
  let soft: Uint8Array;
  let tone: Uint8Array;
  let cut: Uint8Array;
  beforeAll(async () => void ([crisp, soft, tone, cut] = await Promise.all([makeClip({}), makeClip({ soft: true }), makeClip({ tone: true }), makeClip({ cut: true })])), FFMPEG_TIMEOUT);

  it("measures a blurred, darkened copy as darker, much softer and with a narrower range than the original", async () => {
    const a = await lookOf(crisp!, "mp4");
    const b = await lookOf(soft!, "mp4");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.luma).toBeGreaterThan(100);
    expect(b!.luma).toBeLessThan(a!.luma * 0.8);
    expect(b!.sharp).toBeLessThan(a!.sharp * 0.5);
    expect(a!.range!.high).toBeGreaterThan(a!.range!.low);
    expect(b!.range!.high - b!.range!.low).toBeLessThan(a!.range!.high - a!.range!.low);
    // the test pattern moves: a pace, little flicker, chroma near neutral on average
    expect(a!.pace).toBeGreaterThan(0);
    expect(a!.flicker).toBeGreaterThanOrEqual(0);
    expect(Math.abs(a!.chroma!.u)).toBeLessThan(64);
    expect(a!.voice).toBeNull();
  });

  it("puts a 330 Hz tone's centre of weight near 330 Hz, measures from a moment on, and gives null for a file that is not a video", async () => {
    const t = await lookOf(tone!, "mp4");
    expect(t!.voice).toBeGreaterThan(250);
    expect(t!.voice).toBeLessThan(500);
    const whole = await lookOf(crisp!, "mp4");
    const later = await lookOf(crisp!, "mp4", 500);
    expect(later).not.toBeNull();
    expect(Math.abs(later!.luma - whole!.luma)).toBeLessThan(30);
    expect(await lookOf(new Uint8Array([1, 2, 3]), "mp4")).toBeNull();
  });

  it("reads a hard cut inside a clip as a run-up end many times its own motion, a smooth moment as about one, and null for a moment past the end", async () => {
    expect(await runUpBreak(cut!, "mp4", 1000)).toBeGreaterThan(3);
    expect(await runUpBreak(crisp!, "mp4", 500)).toBeLessThan(2.5);
    expect(await runUpBreak(crisp!, "mp4", 5000)).toBeNull();
  });
});
