import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPreflight } from "../src/preflight";

describe("the start-up checks", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reports each tool, the Node and the data folder, and says what a missing tool costs and how to put it right", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-preflight-"));
    made.push(dir);
    const p = await runPreflight(join(dir, "data"), { ffmpeg: "no-such-tool-afflatus", ffprobe: "no-such-tool-afflatus-probe" });
    expect(p.checks.map((c) => c.id)).toEqual(["node", "ffmpeg", "ffprobe", "data"]);
    expect(p.checks.find((c) => c.id === "node")).toMatchObject({ ok: true, detail: process.version });
    expect(p.checks.find((c) => c.id === "data")).toMatchObject({ ok: true });
    const mpeg = p.checks.find((c) => c.id === "ffmpeg")!;
    expect(mpeg.ok).toBe(false);
    expect(mpeg.detail).toMatch(/not found/);
    expect(mpeg.without).toMatch(/exports/i);
    expect(mpeg.fix).toMatch(/FFMPEG/);
    expect(p.ok).toBe(false);
  });

  it("finds the real tools when they are there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afflatus-preflight-"));
    made.push(dir);
    const p = await runPreflight(dir);
    // this machine has ffmpeg (the video tests need it); its version is read from the first line
    const mpeg = p.checks.find((c) => c.id === "ffmpeg")!;
    if (mpeg.ok) expect(mpeg.detail).toMatch(/^\S+/);
    expect(p.checks.find((c) => c.id === "data")).toMatchObject({ ok: true, detail: dir });
  });
});
