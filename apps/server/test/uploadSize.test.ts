import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { makeApp, type TestApp } from "./helpers";

/**
 * A picture is read into memory whole, so one sent from the computer is refused over PICTURE_MOST (lowered here to a
 * kilobyte, the real one being 256 MB); a video sent to read what it carries is read by ffprobe where it is, never into memory.
 */
vi.mock("../src/media", async (original) => ({ ...(await original<typeof import("../src/media")>()), PICTURE_MOST: 1024 }));
const reads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const readFile = ((path: unknown, ...rest: unknown[]) => {
    reads.push(String(path));
    return (fs.readFile as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFile;
  return { ...fs, default: { ...fs, readFile }, readFile };
});

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  reads.length = 0;
});
afterEach(async () => {
  await t.close();
});

const big = () => makePng(512, 512, [10, 20, 30], [240, 200, 160]);
const small = () => makePng(8, 8, [10, 20, 30], [240, 200, 160]);
const send = (url: string, bytes: Uint8Array, type = "image/png") => t.app.inject({ method: "POST", url, headers: { "content-type": type }, payload: Buffer.from(bytes) });

describe("a picture larger than Afflatus reads of one", () => {
  it("is refused as an upload, with a 413 that says so, and nothing is added", async () => {
    expect(big().length).toBeGreaterThan(1024);
    expect(small().length).toBeLessThan(1024);
    const res = await send("/api/assets?name=big.png", big());
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/larger than/);
    expect(await t.services.db.selectFrom("assets").select("id").execute()).toEqual([]);
    expect((await send("/api/assets?name=small.png", small())).statusCode).toBe(200);
  });

  it("is refused when sent to read how it was made", async () => {
    expect((await send("/api/embedded", big())).statusCode).toBe(413);
    expect((await send("/api/embedded", small())).statusCode).toBe(200);
  });
});

describe.skipIf(!ffmpegThere)("a video sent to read how it was made", () => {
  it("is read by ffprobe where it was written, not into memory", async () => {
    const res = await send("/api/embedded", await patternClip(1), "video/mp4");
    expect(res.statusCode).toBe(200);
    expect(reads.filter((p) => p.includes("afflatus-upload-"))).toEqual([]);
  }, FFMPEG_TIMEOUT);
});
