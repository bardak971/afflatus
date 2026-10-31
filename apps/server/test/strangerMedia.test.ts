import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { probeMediaFile } from "../src/cut";
import { firstFrame, tools } from "../src/video";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";
import { makeApp, type TestApp } from "./helpers";

/**
 * A file from a stranger (an upload, MCP's import_from_url) is read only as a real container (video.ts readAs): an
 * HLS or DASH manifest naming a file elsewhere on the disk is refused before ffmpeg opens what it names. With only the
 * `file` protocol allowed, the frame of that other file came back. Skipped where ffmpeg is not installed.
 */
let dir: string;
let clip: string;
let hls: string;
let dash: string;
beforeAll(async () => {
  if (!ffmpegThere) return;
  dir = await mkdtemp(join(tmpdir(), "afflatus-stranger-"));
  clip = join(dir, "elsewhere.ts");
  await writeFile(clip, await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"], "ts"));
  const there = clip.replace(/\\/g, "/");
  hls = join(dir, "list.m3u8");
  await writeFile(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\n${there}\n#EXT-X-ENDLIST\n`);
  dash = join(dir, "list.mpd");
  await writeFile(dash, `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet mimeType="video/mp2t"><Representation id="1" bandwidth="1000"><BaseURL>file:${there}</BaseURL></Representation></AdaptationSet></Period></MPD>`);
}, FFMPEG_TIMEOUT);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ffmpegThere)("a file from a stranger", () => {
  it("gives no frame of the file a playlist names, which a run limited to files alone gave", async () => {
    // the gap itself: limited to the file protocol alone, the playlist was read and the other file's frame came out
    const out = join(dir, "leak.png");
    await new Promise<void>((done) => execFile(tools.ffmpeg, ["-y", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", hls, "-frames:v", "1", out], { windowsHide: true }, () => done()));
    expect((await stat(out)).size).toBeGreaterThan(0);
    expect(await firstFrame(hls)).toBeNull();
    expect(await probeMediaFile(hls)).toBeNull();
    expect(await probeMediaFile(dash)).toBeNull();
    // a real container still reads
    expect(await firstFrame(clip)).not.toBeNull();
    expect(await probeMediaFile(clip)).toMatchObject({ kind: "video" });
  }, FFMPEG_TIMEOUT);

  describe("uploaded", () => {
    let t: TestApp;
    beforeEach(async () => {
      t = await makeApp();
    });
    afterEach(async () => {
      await t.close();
    });
    it("is refused when it is a manifest, HLS or DASH", async () => {
      // sent as a video: what it says it is is not what decides
      for (const file of [hls, dash]) {
        const res = await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test%20list", headers: { "content-type": "video/mp4" }, payload: await readFile(file) });
        expect(res.statusCode, file).toBe(400);
      }
      expect(await t.db.selectFrom("assets").select("id").execute()).toEqual([]);
    }, FFMPEG_TIMEOUT);
  });
});
