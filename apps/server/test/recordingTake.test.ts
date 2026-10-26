import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { probeMediaFile } from "../src/cut";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";
import { makeApp, type TestApp } from "./helpers";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A take recorded from the microphone (the 🎙 of a sound slot) is sent as the browser's recorder makes it, webm/opus in
 * Chrome, and kept as a WAV. These tests are skipped where ffmpeg is not installed.
 */
let take: Uint8Array;
beforeAll(async () => {
  // what Chrome's MediaRecorder gives: Opus in a WebM, mono, 48 kHz
  if (ffmpegThere) take = await ffmpegMade(["-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ac", "1", "-c:a", "libopus"], "webm");
}, FFMPEG_TIMEOUT);

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const send = (query: string) =>
  t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent("Recording · Voice sample")}${query}`, headers: { "content-type": "audio/webm;codecs=opus" }, payload: Buffer.from(take) });

/** The stored file of an item, probed again as an upload would be. */
async function probed(id: string) {
  const row = await t.services.db.selectFrom("assets").select("file_key").where("id", "=", id).executeTakeFirstOrThrow();
  const dir = await mkdtemp(join(tmpdir(), "afflatus-take-"));
  try {
    const file = join(dir, "kept");
    await writeFile(file, await t.services.storage.get(row.file_key));
    return await probeMediaFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ffmpegThere)("a take from the microphone", () => {
  it("is kept as a WAV, whole", async () => {
    const res = await send("&take=wav");
    expect(res.statusCode).toBe(200);
    const a = res.json() as { id: string; kind: string; mime: string; durationMs: number; name: string };
    expect(a).toMatchObject({ kind: "audio", mime: "audio/wav", name: "Recording · Voice sample" });
    expect(Math.abs(a.durationMs - 3000)).toBeLessThan(80);
    // the file kept is the WAV itself, not the webm under a WAV's name
    expect(await probed(a.id)).toMatchObject({ kind: "audio", mime: "audio/wav" });
  }, FFMPEG_TIMEOUT);

  it("is cut to the trim kept, from and to in seconds", async () => {
    const a = (await send("&take=wav&from=0.5&to=2.25")).json() as { mime: string; durationMs: number };
    expect(a.mime).toBe("audio/wav");
    expect(Math.abs(a.durationMs - 1750)).toBeLessThan(60);
  }, FFMPEG_TIMEOUT);

  it("goes with the person in the Prompt kit, not into the library, as a kit's sound file does", async () => {
    const a = (await send("&take=wav&as=kit")).json() as { id: string; mime: string };
    expect(a.mime).toBe("audio/wav");
    const row = await t.services.db.selectFrom("assets").select("origin").where("id", "=", a.id).executeTakeFirstOrThrow();
    expect(row.origin).toBe("kit");
  }, FFMPEG_TIMEOUT);

  it("refuses half a trim, or one that ends before it starts", async () => {
    expect((await send("&take=wav&from=0.5")).statusCode).toBe(400);
    expect((await send("&take=wav&from=2&to=1")).statusCode).toBe(400);
  });

  it("is refused in words when what was sent is no sound", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/assets?name=x&take=wav", headers: { "content-type": "audio/webm" }, payload: Buffer.from("not a sound at all") });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/could not be made into a WAV/);
  });

  it("is refused when it is a DASH manifest naming a file on the disk, whose sound would come back as the take", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afflatus-take-dash-"));
    try {
      const secret = join(dir, "private.mp4").replaceAll("\\", "/");
      await writeFile(secret, await ffmpegMade(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac"], "mp4"));
      const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
 <Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="128000"><BaseURL>${secret}</BaseURL></Representation></AdaptationSet></Period>
</MPD>`;
      const res = await t.app.inject({ method: "POST", url: "/api/assets?name=x&take=wav", headers: { "content-type": "audio/webm" }, payload: Buffer.from(mpd) });
      expect(res.statusCode).toBe(400);
      expect(await t.services.db.selectFrom("assets").select("id").execute()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, FFMPEG_TIMEOUT);

  it("is read from the containers each browser's recorder makes: Firefox's ogg, Safari's mp4", async () => {
    for (const [args, ext] of [[["-c:a", "libopus"], "ogg"], [["-c:a", "aac"], "mp4"]] as const) {
      const made = await ffmpegMade(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-ac", "1", ...args], ext);
      const res = await t.app.inject({ method: "POST", url: "/api/assets?name=x&take=wav", headers: { "content-type": `audio/${ext}` }, payload: Buffer.from(made) });
      expect(res.json()).toMatchObject({ kind: "audio", mime: "audio/wav" });
    }
  }, FFMPEG_TIMEOUT);
});
