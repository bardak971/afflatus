import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { joinVideosInto, webCut } from "../src/cut";
import { readVideo } from "../src/video";

/** A copy for the web: brought down to 1280 on its long side, 30 frames a second, under the size asked for. */

describe("the size of a web copy", () => {
  it("brings the long edge down to 1280, never up, and keeps the bitrate under the size for the length", () => {
    expect(webCut({ width: 2048, height: 1152 }, 28_759, 10)).toMatchObject({ W: 1280, H: 720, audioKbps: 128 });
    expect(webCut({ width: 576, height: 1024 }, 10_000, 10)).toMatchObject({ W: 576, H: 1024 });
    const { videoKbps, audioKbps } = webCut({ width: 2048, height: 1152 }, 28_759, 10);
    expect(((videoKbps + audioKbps) * 28.759) / 8 / 1000).toBeLessThan(10);
    // a very long video still gets a picture, if not a size
    expect(webCut({ width: 1280, height: 720 }, 3_600_000, 10).videoKbps).toBe(300);
  });
});

/** A test clip made with ffmpeg: a moving pattern at 48 frames a second, with a tone. Skipped where ffmpeg is not installed. */
function makeClip(seconds: number): { bytes: Uint8Array; dir: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-web-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=2048x1152:rate=48:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file,
  ]);
  if (made.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return { bytes: new Uint8Array(readFileSync(file)), dir };
}
const sample = makeClip(3);

describe.skipIf(!sample)("a web copy made by ffmpeg", () => {
  afterAll(() => rmSync(sample!.dir, { recursive: true, force: true }));
  it("comes out at 1280 wide, 30 frames a second, under the size", async () => {
    const part = { kind: "video" as const, source: sample!.bytes, ext: "mp4", startMs: 0, endMs: 3000, hasSound: true, sound: "own" as const, volume: 1, fill: false };
    const out = await joinVideosInto([part], { width: 2048, height: 1152 }, 48, { webMb: 10 }, (file) => readFile(file));
    expect(out.length).toBeLessThan(10 * 1000 * 1000);
    const { facts } = await readVideo(out, "mp4");
    expect(facts).toMatchObject({ width: 1280, height: 720 });
    expect(Math.round(facts!.fps!)).toBe(30);
  });
});
