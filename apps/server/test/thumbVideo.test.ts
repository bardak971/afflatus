import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tools } from "../src/video";
import * as video from "../src/video";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * A video's thumbnail made on request (a linked file's, or one stored before Afflatus read videos; P3): the tiles asking at
 * once share one making, a video no frame can be read of is not read again on every view, and one whose length is known is
 * not probed again.
 */

vi.mock("../src/video", async (actual) => {
  const real = await actual<typeof import("../src/video")>();
  return { ...real, probeVideo: vi.fn(real.probeVideo), firstFrame: vi.fn(real.firstFrame) };
});
const probed = vi.mocked(video.probeVideo);
const framed = vi.mocked(video.firstFrame);

let clip: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) clip = await patternClip(1, { size: "160x96", fps: 8, sound: false });
}, FFMPEG_TIMEOUT);

const real = { ...tools };
let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  probed.mockClear();
  framed.mockClear();
});
afterEach(async () => {
  Object.assign(tools, real);
  await t.close();
});

const ID = "0123456789abcdef0123456789abcdef";

/** A video in the library with no thumbnail yet; `durationMs` known or not (not read yet). */
async function stored(bytes: Uint8Array, durationMs: number | null) {
  await t.services.storage.put(`assets/${ID}.mp4`, bytes);
  await t.db.insertInto("assets").values({
    id: ID, owner_id: "local", kind: "video", origin: "uploaded", name: "zz-test clip", file_key: `assets/${ID}.mp4`, thumb_key: null, mime: "video/mp4",
    bytes: bytes.length, width: durationMs ? 160 : null, height: durationMs ? 96 : null, duration_ms: durationMs, fps: durationMs ? 8 : null, has_sound: 0,
    folder_id: null, generation_id: null, kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
  }).execute();
}
const thumb = () => get(t.app, `/api/assets/${ID}/thumb`);

describe.skipIf(!ffmpegThere)("a video's thumbnail made on request", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is read once for tiles asking at once, and a video ffmpeg cannot read is not read again on the next view", async () => {
    await stored(new TextEncoder().encode("not a video at all"), null);
    const asked = await Promise.all([thumb(), thumb(), thumb()]);
    expect(asked.map((r) => r.statusCode)).toEqual([404, 404, 404]);
    expect([probed.mock.calls.length, framed.mock.calls.length]).toEqual([1, 1]);
    expect((await thumb()).statusCode).toBe(404);
    expect([probed.mock.calls.length, framed.mock.calls.length]).toEqual([1, 1]);
  });

  it("is tried again once another ffmpeg is chosen", async () => {
    tools.ffmpeg = "no-such-ffmpeg";
    tools.ffprobe = "no-such-ffprobe";
    await stored(clip!, null);
    expect((await thumb()).statusCode).toBe(404);
    Object.assign(tools, real);
    expect((await thumb()).headers["content-type"]).toBe("image/webp");
  });

  it("does not probe a video whose length is known: its first frame alone is read", async () => {
    await stored(clip!, 1000);
    expect((await thumb()).headers["content-type"]).toBe("image/webp");
    expect([probed.mock.calls.length, framed.mock.calls.length]).toEqual([0, 1]);
  });
});
