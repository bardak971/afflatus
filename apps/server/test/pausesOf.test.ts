import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PAUSE } from "@afflatus/core";
import { pausesOf } from "../src/cut";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";

/**
 * Where a recording is cut into clips: its pauses as core's PAUSE says what one is (card #260), the same rule the page's
 * marks keep to, so that a part snapped to a pause there ends where a cut here would.
 */
const dir = mkdtempSync(join(tmpdir(), "zz-test-pauses-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A tone at -26 dB with silent stretches (`gaps`, in seconds), written as a WAV file. */
function spoken(name: string, seconds: number, gaps: Array<[number, number]>): string {
  const quiet = gaps.map(([a, b]) => `between(t,${a},${b})`).join("+");
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `aevalsrc='if(${quiet},0,0.05*sin(2*PI*220*t))':s=48000:d=${seconds}`, "-f", "wav", "pipe:1"], { maxBuffer: 64 * 1024 * 1024 });
  const file = join(dir, name);
  writeFileSync(file, r.stdout);
  return file;
}

describe.skipIf(!ffmpegThere)("the pauses a recording is cut at", { timeout: FFMPEG_TIMEOUT }, () => {
  it("are the quiet stretches of PAUSE.leastS at least under its own loudest, however quietly it was recorded", async () => {
    // a 0.35 s pause, then a 0.1 s dip between words: too short to cut in
    const file = spoken("zz-test-voice.wav", 3, [[1, 1.35], [2, 2.1]]);
    const pauses = await pausesOf(file, "wav");
    expect(pauses).toHaveLength(1);
    expect(pauses[0]!.start).toBeCloseTo(1, 1);
    expect(pauses[0]!.end).toBeCloseTo(1.35, 1);
    expect(pauses[0]!.end - pauses[0]!.start).toBeGreaterThanOrEqual(PAUSE.leastS);
  });
});
