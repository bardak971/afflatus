import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { soundPart } from "../src/cut";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";

/**
 * A recording cut into clips is evened out by one gain for all of it (soundPart's `evenWhole`): measured once for the
 * recording, not again for each clip (30 clips were 30 decodes of the whole of it, true peak included), and a measure that
 * fails is said rather than taken for a gain of 0, one clip then at another level than the rest.
 */
const runs = vi.hoisted(() => ({ loudness: 0, fail: false }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const execFile = (...all: unknown[]) => {
    const args = all[1] as string[];
    if (args.some((a) => a.startsWith("ebur128"))) {
      runs.loudness++;
      // the measure fails as a timed-out or crashed ffmpeg does: an error, and no summary said
      if (runs.fail) {
        const done = all.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
        setImmediate(() => done(Object.assign(new Error("ffmpeg was stopped"), { code: 1 }), "", ""));
        return {};
      }
    }
    return (real.execFile as (...a: unknown[]) => unknown)(...all);
  };
  return { ...real, execFile };
});

const dir = mkdtempSync(join(tmpdir(), "zz-test-even-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  runs.loudness = 0;
  runs.fail = false;
});

/** A tone of `seconds` written as a WAV file, `db` under its usual level. */
function toneFile(name: string, seconds: number, db = 0): string {
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`, "-af", `volume=${db}dB`, "-f", "wav", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  const file = join(dir, name);
  writeFileSync(file, r.stdout);
  return file;
}

describe.skipIf(!ffmpegThere)("a recording evened out by one gain for all of it", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is measured once for all its clips, whether read from its file or handed over as bytes of an asset", async () => {
    const file = toneFile("song.wav", 12, -20);
    const said: string[] = [];
    for (const start of [0, 4, 8]) await soundPart(file, "wav", { start, seconds: 4, durationMs: 12_000, even: true, evenWhole: true, unmeasured: () => said.push("unmeasured") });
    expect(runs.loudness).toBe(1);
    expect(said).toEqual([]);
    // as bytes (storage with no local path): kept by the asset named, not measured per clip either
    const bytes = new Uint8Array(spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-f", "wav", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 }).stdout);
    for (const start of [0, 4]) await soundPart(bytes, "wav", { start, seconds: 4, durationMs: 8_000, even: true, evenWhole: true, evenKey: "zz-test-asset:assets/zz/zz-test-asset" });
    expect(runs.loudness).toBe(2);
    // a voice sample is evened out on its own part, each time
    await soundPart(file, "wav", { start: 0, seconds: 4, durationMs: 12_000, even: true });
    expect(runs.loudness).toBe(3);
  });

  it("says when its loudness could not be measured, and measures it again for the next clip", async () => {
    const file = toneFile("failing.wav", 8, -20);
    const said: string[] = [];
    runs.fail = true;
    const part = await soundPart(file, "wav", { start: 0, seconds: 4, durationMs: 8_000, even: true, evenWhole: true, unmeasured: () => said.push("unmeasured") });
    expect(part.length).toBeGreaterThan(44);
    expect(said).toEqual(["unmeasured"]);
    // the failure is not kept as the recording's gain: the next clip measures it, and is evened out
    runs.fail = false;
    await soundPart(file, "wav", { start: 4, seconds: 4, durationMs: 8_000, even: true, evenWhole: true, unmeasured: () => said.push("unmeasured") });
    expect(runs.loudness).toBe(2);
    expect(said).toEqual(["unmeasured"]);
  });
});
