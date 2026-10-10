import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureApart, measureOf } from "../src/cut";
import { pool } from "../src/pool";

let dir: string;
const make = (name: string, args: string[]) => {
  const file = join(dir, name);
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, file]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  return file;
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "afflatus-measure-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("measuring a video in one ffmpeg run", () => {
  it("gives the motion, the loudness and the voice band the separate runs gave", async () => {
    // moving pictures, a tone that comes and goes, and a stretch of noise in a voice's band
    const both = make("both.mp4", [
      "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24:duration=3",
      "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,1),0.5),0.6*sin(2*PI*440*t),0.05*sin(2*PI*1200*t))':s=48000:d=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ]);
    const silent = make("silent.mp4", ["-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const sound = make("sound.m4a", ["-f", "lavfi", "-i", "sine=frequency=700:duration=2", "-c:a", "aac"]);
    for (const [file, ext] of [[both, "mp4"], [silent, "mp4"], [sound, "m4a"]] as const) {
      const once = await measureOf(file, ext);
      const apart = await measureApart(file);
      expect(once).toEqual(apart);
    }
    const m = await measureOf(both, "mp4");
    expect(m.motion.length).toBeGreaterThan(20);
    expect(m.sound?.length).toBeGreaterThan(20);
    expect(m.speech?.length).toBe(m.sound?.length);
    expect((await measureOf(silent, "mp4")).sound).toBeNull();
    expect((await measureOf(sound, "m4a")).motion).toEqual([]);
  }, 60_000);
});

describe("a pool", () => {
  it("runs so many at once, the rest in turn", async () => {
    const run = pool(2);
    let now = 0;
    let most = 0;
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map((n) => run(async () => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      now--;
    })));
    expect(most).toBe(2);
    expect(order.sort()).toEqual([1, 2, 3, 4, 5]);
    // a failure frees its place
    await expect(run(async () => { throw new Error("no"); })).rejects.toThrow("no");
    expect(await run(async () => 7)).toBe(7);
  });

  it("starts what a screen waits on before what was asked earlier but only decorates it", async () => {
    const run = pool(1);
    const started: string[] = [];
    const job = (name: string) => async () => {
      started.push(name);
      await new Promise((r) => setTimeout(r, 2));
    };
    // the strips are asked first; the measure asked after them still runs as soon as a place frees
    await Promise.all([run(job("strip 1")), run(job("strip 2")), run(job("strip 3")), run(job("measure"), { first: true })]);
    expect(started).toEqual(["strip 1", "measure", "strip 2", "strip 3"]);
  });
});
