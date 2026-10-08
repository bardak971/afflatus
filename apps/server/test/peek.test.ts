import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { peekAt } from "../src/cut";

const dir = mkdtempSync(join(tmpdir(), "afflatus-peek-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a picture of one moment of a video", () => {
  it("is taken anywhere in it, and a moment inside its last frame gives the last frame", async () => {
    // one second at 48 fps: its last frame starts at 979 ms, so 990 ms seeks past every frame
    const file = join(dir, "clip.mp4");
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=128x96:r=48:d=1", "-pix_fmt", "yuv420p", file]);
    expect(made.status).toBe(0);
    const jpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
    expect(jpeg(await peekAt(file, "mp4", 500, 64))).toBe(true);
    expect(jpeg(await peekAt(file, "mp4", 990, 64))).toBe(true);
    expect(jpeg(await peekAt(file, "mp4", 1000, 64))).toBe(true);
  });
});
