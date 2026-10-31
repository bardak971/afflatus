import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Precompute } from "../src/precompute";
import { lengthOnGrid } from "../src/timelineModel";
import type { TimelineMedia } from "../src/timelineMedia";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { ffmpegThere, firstMiss, readFrames, runs, soundPast, synthMade } from "./framesKit";
import { get, sentView, withTakes, makeApp, until, type TestApp } from "./helpers";

/**
 * A video whose sound runs past its picture (card #207): a pod's ComfyUI muxed H3's smoothed renders with their sound padded
 * 35–113 ms past the last frame. Stored at the file's length (its longest stream's), the frame grid was dropped and the clip
 * after handed over that much past the picture, the last frame held with the sound gone at every join, in the editor and the
 * export. No GPU: synthetic H3-shaped files (247 frames at 48 a second, 124 of the model), ffmpeg only.
 */

const N = 124;
const FILE = 2 * N - 1;
/** The model's 124 frames at 24 a second: where a take of them ends on the timeline. */
const GRID = Math.round((N * 1000) / 24);

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
  return sentView(res.json());
};
const view = async (id: string) => withTakes((await get(t.app, `/api/timelines/${id}`)).json());
const upload = async (bytes: Uint8Array, name: string) => {
  const res = await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(bytes) });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json() as { id: string; durationMs: number };
};
const assetRow = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const takeRow = (id: string) => t.db.selectFrom("takes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

async function exportOf(id: string): Promise<Uint8Array> {
  await call("POST", `/api/timelines/${id}/export`, { match: false });
  await until(async () => (await view(id)).exporting === null, 60_000);
  const v = await view(id);
  if (v.exportFailed) throw new Error(v.exportFailed);
  const row = await t.db.selectFrom("assets").select("file_key").where("id", "=", v.exported.id).executeTakeFirstOrThrow();
  return t.services.storage.get(row.file_key);
}

/**
 * H3's seamless chain of these videos, each clip after carried on from where the one before ends as the timeline plays it
 * (its length on the grid, as the render's plan hands over: TimelinePlan, plays(before).end).
 */
async function chain(videos: Uint8Array[]) {
  const tl = await call("POST", "/api/timelines", { name: "zz-test pod length" });
  const assets: string[] = [];
  for (const [i, v] of videos.entries()) {
    const asset = await upload(v, `zz-test c${i}.mp4`);
    assets.push(asset.id);
    await t.db.updateTable("assets").set({ latent_frames: N }).where("id", "=", asset.id).execute();
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: asset.id });
  }
  const clips = (await view(tl.id)).clips as Array<{ id: string; take: { id: string } }>;
  for (let i = 1; i < clips.length; i++) {
    await call("PATCH", `/api/clips/${clips[i]!.id}`, { joined: "continue" });
    const end = lengthOnGrid(await assetRow(assets[i - 1]!));
    await t.db.updateTable("takes").set({ head_ms: 917, join_kind: "seamless", prev_take_id: clips[i - 1]!.take.id, prev_at_ms: end }).where("id", "=", clips[i]!.take.id).execute();
  }
  return { id: tl.id as string, clips, assets };
}

describe.skipIf(!ffmpegThere)("a video whose sound runs past its picture", { timeout: FFMPEG_TIMEOUT }, () => {
  /** Three H3 renders as a pod made them: the sound 134 ms past the picture (5.280 s against 5.146 s). */
  let pod: Uint8Array[] = [];
  /** One as the PC made it: the sound 20 ms short of the picture. */
  let pc: Uint8Array;
  beforeAll(async () => {
    const made = await Promise.all([1, 2, 3, 4].map((c) => synthMade(c, FILE, 48)));
    pod = await Promise.all(made.slice(0, 3).map((v) => soundPast(v, 134)));
    pc = await soundPast(made[3]!, -20);
  }, FFMPEG_TIMEOUT);

  it("is stored at its picture's length, kept on the model's grid: the clip after is handed over at its last frame", async () => {
    const a = await upload(pod[0]!, "zz-test pod.mp4");
    // its picture's 247 frames at 48 a second, not the sound's 5280 ms
    expect(Math.abs(a.durationMs - 5146)).toBeLessThanOrEqual(1);
    await t.db.updateTable("assets").set({ latent_frames: N }).where("id", "=", a.id).execute();
    expect(lengthOnGrid(await assetRow(a.id))).toBe(GRID);
    // the PC's (its sound shorter): as before
    const b = await upload(pc, "zz-test pc.mp4");
    expect(Math.abs(b.durationMs - 5146)).toBeLessThanOrEqual(1);
    await t.db.updateTable("assets").set({ latent_frames: N }).where("id", "=", b.id).execute();
    expect(lengthOnGrid(await assetRow(b.id))).toBe(GRID);
  });

  it("joins seamlessly in the export: every frame once, no last frame held", async () => {
    const { id, clips } = await chain(pod);
    expect((await takeRow(clips[1]!.take.id)).prev_at_ms).toBe(GRID);
    const v = await view(id);
    expect(v.clips.slice(1).map((c: { take: { seamless: boolean } }) => c.take.seamless)).toEqual([true, true]);
    const got = readFrames(await exportOf(id));
    expect(firstMiss(got, runs([1, 0, FILE - 1], [2, 43, FILE - 1], [3, 43, FILE - 1]))).toBeNull();
  });

  it("stored before at its sound's length: set to its picture's by the background, the joins after it with it, once", async () => {
    const { id, clips, assets } = await chain(pod);
    // as a pod's take was stored before: the file's length, the clips after handed over there
    for (const a of assets) await t.db.updateTable("assets").set({ duration_ms: 5280 }).where("id", "=", a).execute();
    for (const c of clips.slice(1)) await t.db.updateTable("takes").set({ prev_at_ms: 5280 }).where("id", "=", c.take.id).execute();
    const pcAsset = await upload(pc, "zz-test pc.mp4");
    const pcBefore = await assetRow(pcAsset.id);
    const media = t.services.timelines.media;
    for (const a of assets) expect(await media.pictureLength(a)).toBe(true);
    for (const a of assets) expect(Math.abs((await assetRow(a)).duration_ms! - 5146)).toBeLessThanOrEqual(1);
    for (const c of clips.slice(1)) expect((await takeRow(c.take.id)).prev_at_ms).toBe(GRID);
    // the joins flow again, and play every frame once
    const v = await view(id);
    expect(v.clips.slice(1).map((c: { take: { seamless: boolean } }) => c.take.seamless)).toEqual([true, true]);
    expect(firstMiss(readFrames(await exportOf(id)), runs([1, 0, FILE - 1], [2, 43, FILE - 1], [3, 43, FILE - 1]))).toBeNull();
    // a second pass changes nothing; the PC's video is left as it was
    for (const a of assets) expect(await media.pictureLength(a)).toBe(false);
    expect(await media.pictureLength(pcAsset.id)).toBe(false);
    expect(await assetRow(pcAsset.id)).toEqual(pcBefore);
  });

  it("keeps a take trimmed by hand on the frame it stopped on, and the hand-over before its frozen tail where it was", async () => {
    const { clips, assets } = await chain(pod.slice(0, 2));
    // the old length: clip 1 handed over at 4500 ms (its tail froze), so trimmed to stop there (5280 − 4500)
    await t.db.updateTable("assets").set({ duration_ms: 5280 }).where("id", "=", assets[0]!).execute();
    await t.db.updateTable("takes").set({ trim_end_ms: 780 }).where("id", "=", clips[0]!.take.id).execute();
    await t.db.updateTable("takes").set({ prev_at_ms: 4500 }).where("id", "=", clips[1]!.take.id).execute();
    expect(await t.services.timelines.media.pictureLength(assets[0]!)).toBe(true);
    // 5167 − 667: still 4500, still followed from there
    expect((await takeRow(clips[0]!.take.id)).trim_end_ms).toBe(780 - (5280 - GRID));
    expect((await takeRow(clips[1]!.take.id)).prev_at_ms).toBe(4500);
  });

  it("is read again by the background's first pass alone, one video at a time, the takes' videos with sound only", async () => {
    const { assets } = await chain(pod.slice(0, 2));
    await upload(pod[2]!, "zz-test not placed.mp4");
    const asked: string[] = [];
    const none = async () => {};
    const media = {
      motion: none, strip: none, means: none, joins: none, missing: async () => [], measureTogether: async () => true,
      pictureLength: async (id: string) => (asked.push(id), true),
    } as unknown as Pick<TimelineMedia, "motion" | "strip" | "means" | "joins" | "missing" | "measureTogether" | "pictureLength">;
    const pc1 = new Precompute(t.db, media, { backfillAfterMs: null, perMinute: 6000 });
    await pc1.backfill();
    await pc1.settled();
    expect(asked.sort()).toEqual([...assets].sort());
    await pc1.stop();
    // done once: a server started again does not read them again
    const pc2 = new Precompute(t.db, media, { backfillAfterMs: null, perMinute: 6000 });
    await pc2.backfill();
    await pc2.settled();
    expect(asked).toHaveLength(2);
    await pc2.stop();
  });
});
