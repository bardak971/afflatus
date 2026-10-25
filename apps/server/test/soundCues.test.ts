import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { FFMPEG_TIMEOUT, ffmpegThere, toneFile } from "./clipKit";
import { H3_FILES } from "./timelineKit";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/** H3 sound cues: each cue's part is cut from its file on the server, as a recording's part is, and goes up on its own. */

let fake: FakeComfy;
let t: TestApp;
let tone: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) tone = await toneFile(4);
}, FFMPEG_TIMEOUT);
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: H3_FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

async function sound(): Promise<string> {
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}`;
  await t.services.storage.put(key, tone!);
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "audio", origin: "uploaded", name: "zz-test cue", file_key: key, thumb_key: null, mime: "audio/wav", bytes: tone!.length,
    width: null, height: null, duration_ms: 4000, fps: null, has_sound: 1, folder_id: null, generation_id: null, kept_at: now(),
  })).execute();
  return id;
}

/** Seconds of a 16-bit stereo 48 kHz WAV, as soundPart writes it. */
const wavSeconds = (bytes: Uint8Array) => (bytes.length - 44) / (48_000 * 2 * 2);

describe.skipIf(!ffmpegThere)("H3 sound cues on the server", { timeout: FFMPEG_TIMEOUT }, () => {
  it("cuts each cue's part from its file and sends it on its own, pinned where it lands", async () => {
    const s = await sound();
    const res = await post(t.app, "/api/jobs", {
      recipe: "h3.video",
      input: { description: "zz-test: she claps her hands once.", seconds: 5, cues: [{ asset: s, start: 1, seconds: 0.5, at: 2.4 }, { asset: s, start: 3, seconds: 2, at: 0 }], seed: 1 },
    });
    expect(res.statusCode).toBeLessThan(400);
    await until(() => fake.prompts.size === 1, 30_000);
    const graph = [...fake.prompts.values()][0]!;
    const guides = Object.values(graph).filter((n) => n.class_type === "MiniMaxH3AddGuide" && n.inputs.audio);
    expect(guides.map((n) => n.inputs.frame_idx)).toEqual([Math.round(2.4 * 24), 0]);
    const heard = guides.map((n) => {
      const trim = graph[(n.inputs.audio as [string, number])[0]]!;
      return String(graph[(trim.inputs.audio as [string, number])[0]]!.inputs.audio);
    });
    const sent = heard.map((name) => Object.entries(fake.uploaded).find(([up]) => name.includes(up))?.[1]);
    expect(sent.every(Boolean), `${heard.join(", ")} in ${Object.keys(fake.uploaded).join(", ")}`).toBe(true);
    // the part asked for; the second one ends with its 4-second file, a second in (its start never moved back, as a voice's is)
    expect(wavSeconds(sent[0]!)).toBeCloseTo(0.5, 2);
    expect(wavSeconds(sent[1]!)).toBeCloseTo(1, 2);
  });
});
