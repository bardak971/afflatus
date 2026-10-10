import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { clicks, ffmpegThere, firstMiss, H, readFrames, runs, synth, synthMade, W } from "./framesKit";
import { get, makeApp, until, type TestApp } from "./helpers";

/**
 * The timeline, frame by frame. Synthetic clips carry their own number and each frame's index as a barcode (and a click in
 * their sound every tenth frame), shaped like MiniMax H3's files: 48 a second, 2N − 1 frames of an interpolated render, a
 * 917 ms run-up shared with the clip before. The export is read back and must be exactly the frames that play, in order:
 * none dropped, none doubled, the sound in step. No GPU, no model: ffmpeg only.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};
const view = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json();
const upload = async (bytes: Uint8Array, name: string) => {
  const res = await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(bytes) });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json() as { id: string; durationMs: number };
};
/** The timeline exported, and the file's bytes. */
async function exportOf(id: string): Promise<Uint8Array> {
  await call("POST", `/api/timelines/${id}/export`, { match: false });
  await until(async () => (await view(id)).exporting === null, 60_000);
  const v = await view(id);
  if (v.exportFailed) throw new Error(v.exportFailed);
  const row = await t.db.selectFrom("assets").select("file_key").where("id", "=", v.exported.id).executeTakeFirstOrThrow();
  return t.services.storage.get(row.file_key);
}

/**
 * A timeline of the given videos, one clip each, and H3's chain made of them: every clip after the first carries on from the
 * one before in the latent and was decoded as one piece with it (a seamless join: its first 917 ms are the run-up, hidden).
 */
async function chain(videos: Uint8Array[], latentFrames: number) {
  const tl = await call("POST", "/api/timelines", { name: "frames" });
  for (const [i, v] of videos.entries()) {
    const asset = await upload(v, `c${i}.mp4`);
    await t.db.updateTable("assets").set({ latent_frames: latentFrames }).where("id", "=", asset.id).execute();
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: asset.id });
  }
  const clips = (await view(tl.id)).clips as Array<{ id: string; take: { id: string } }>;
  const grid = Math.round((latentFrames * 1000) / 24);
  for (let i = 1; i < clips.length; i++) {
    await call("PATCH", `/api/clips/${clips[i]!.id}`, { joined: "continue" });
    await t.db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[i - 1]!.take.id, prev_at_ms: grid }).where("id", "=", clips[i]!.take.id).execute();
  }
  return { id: tl.id as string, clips };
}

describe.skipIf(!ffmpegThere)("the timeline, frame by frame", { timeout: FFMPEG_TIMEOUT }, () => {
  // an H3 render interpolated to 48 a second: 124 frames of the model, 2 × 124 − 1 in the file
  const N = 124;
  const FILE = 2 * N - 1;
  /** Three such renders in a row, made once for the tests that chain them. */
  let three: Uint8Array[] = [];
  beforeAll(async () => void (three = await Promise.all([1, 2, 3].map((c) => synthMade(c, FILE, 48)))), FFMPEG_TIMEOUT);

  it("reads its own barcodes back", () => {
    const got = readFrames(synth(5, 30, 48));
    expect(got).toEqual(runs([5, 0, 29]));
  });

  it("exports a seamless chain as every frame that plays, once, in order, with the sound in step", async () => {
    const { id } = await chain(three, N);
    const v = await view(id);
    expect(v.clips.slice(1).map((c: { take: { seamless: boolean } }) => c.take.seamless)).toEqual([true, true]);
    const out = await exportOf(id);
    // the run-up (917 ms, 44 frames) is hidden but for its last frame, the one between the clip before's last and its own first
    const want = runs([1, 0, FILE - 1], [2, 43, FILE - 1], [3, 43, FILE - 1]);
    const got = readFrames(out);
    expect(firstMiss(got, want)).toBeNull();
    // the clicks fall on the frames whose own index is a tenth: the sound is cut with its picture
    const tenths = want.flatMap((f, i) => (f.index % 10 === 0 ? [i] : []));
    const heard = clicks(out, 48);
    for (const at of tenths) expect(heard.some((h) => Math.abs(h - at) <= 1), `a click near frame ${at}`).toBe(true);
    expect(heard.length).toBe(tenths.length);
  });

  it("plays a finished take as its draft: the same frames, larger, its join still seamless", async () => {
    const { id, clips } = await chain(three, N);
    // clip 2 finished (twice the size, the same frames): a take marked as the finished version of its draft
    const big = await upload(synth(2, FILE, 48, { w: W * 2, h: H * 2 }), "c2-finished.mp4");
    await t.db.updateTable("assets").set({ latent_frames: N }).where("id", "=", big.id).execute();
    const draft = await t.db.selectFrom("takes").selectAll().where("id", "=", clips[1]!.take.id).executeTakeFirstOrThrow();
    const finished = newId();
    await t.db.insertInto("takes").values({ ...draft, id: finished, asset_id: big.id, finished_from: draft.id, created_at: now() }).execute();
    await t.db.updateTable("clips").set({ take_id: finished }).where("id", "=", clips[1]!.id).execute();
    const v = await view(id);
    expect(v.clips[1].take.finishedFrom).toBe(draft.id);
    expect(v.clips.slice(1).map((c: { take: { seamless: boolean } }) => c.take.seamless)).toEqual([true, true]);
    expect(firstMiss(readFrames(await exportOf(id)), runs([1, 0, FILE - 1], [2, 43, FILE - 1], [3, 43, FILE - 1]))).toBeNull();
  });

  it("cuts and trims to the frame", async () => {
    const tl = await call("POST", "/api/timelines", { name: "cuts" });
    for (const [i, clip] of [7, 8].entries()) await call("POST", `/api/timelines/${tl.id}/clips`, { asset: (await upload(synth(clip, 72, 24), `p${i}.mp4`)).id });
    const clips = (await view(tl.id)).clips as Array<{ id: string }>;
    // the first clip seen from 0.5 s to 2.75 s of its 3 s: frames 12 to 65
    await call("PATCH", `/api/clips/${clips[0]!.id}`, { trimStartMs: 500, trimEndMs: 250 });
    expect(firstMiss(readFrames(await exportOf(tl.id)), runs([7, 12, 65], [8, 0, 71]))).toBeNull();
  });
});
