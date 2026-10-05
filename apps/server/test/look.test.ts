import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { lookOf, runUpBreak } from "../src/cut";

/** A test clip of a second (two with a hard cut at one second: the picture inverts there), crisp or blurred and darkened, with a 330 Hz tone or silent, made with ffmpeg. Skipped where ffmpeg is not installed. */
function makeClip(opts: { soft?: boolean; tone?: boolean; cut?: boolean }): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-look-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=320x192:rate=24:duration=${opts.cut ? 2 : 1}`,
    ...(opts.tone ? ["-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-c:a", "aac", "-shortest"] : []),
    ...(opts.soft ? ["-vf", "gblur=sigma=3,eq=brightness=-0.15"] : opts.cut ? ["-vf", "negate=enable='gte(t,1)'"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const crisp = makeClip({});
const soft = makeClip({ soft: true });
const tone = makeClip({ tone: true });
const cut = makeClip({ cut: true });

describe.skipIf(!crisp || !soft || !tone || !cut)("the look of a clip", () => {
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
  }, 30_000);

  it("puts a 330 Hz tone's centre of weight near 330 Hz, measures from a moment on, and gives null for a file that is not a video", async () => {
    const t = await lookOf(tone!, "mp4");
    expect(t!.voice).toBeGreaterThan(250);
    expect(t!.voice).toBeLessThan(500);
    const whole = await lookOf(crisp!, "mp4");
    const later = await lookOf(crisp!, "mp4", 500);
    expect(later).not.toBeNull();
    expect(Math.abs(later!.luma - whole!.luma)).toBeLessThan(30);
    expect(await lookOf(new Uint8Array([1, 2, 3]), "mp4")).toBeNull();
  }, 30_000);

  it("reads a hard cut inside a clip as a run-up end many times its own motion, a smooth moment as about one, and null for a moment past the end", async () => {
    expect(await runUpBreak(cut!, "mp4", 1000)).toBeGreaterThan(3);
    expect(await runUpBreak(crisp!, "mp4", 500)).toBeLessThan(2.5);
    expect(await runUpBreak(crisp!, "mp4", 5000)).toBeNull();
  }, 30_000);
});
