import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Precompute } from "../src/precompute";
import { lengthOnGrid } from "../src/timelineModel";
import type { TimelineMedia } from "../src/timelineMedia";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { ffmpegThere, firstMiss, readFrames, runs, soundPast, synthMade } from "./framesKit";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
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

  /** The old length, as a pod's take was stored before: clip 1 trimmed to stop at 4500 (780 off 5280), clip 2 carried on from 5280. */
  async function storedLong() {
    const { id, clips, assets } = await chain(pod.slice(0, 2));
    await t.db.updateTable("assets").set({ duration_ms: 5280 }).where("id", "=", assets[0]!).execute();
    await t.db.updateTable("takes").set({ trim_end_ms: 780 }).where("id", "=", clips[0]!.take.id).execute();
    await t.db.updateTable("takes").set({ prev_at_ms: 5280 }).where("id", "=", clips[1]!.take.id).execute();
    return { id, clips, assets };
  }
  const trimmed = 780 - (5280 - GRID);
  const undo = (id: string) => t.app.inject({ method: "POST", url: `/api/timelines/${id}/undo`, payload: {} });

  it("makes the steps Undo keeps right with the takes: a step put back keeps the trim and the hand-over (D3)", async () => {
    const { id, clips, assets } = await storedLong();
    // a step kept before the length is read again, its takes at the old length
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { volume: 50 });
    expect(await t.services.timelines.media.pictureLength(assets[0]!)).toBe(true);
    expect((await undo(id)).statusCode).toBe(200);
    expect((await takeRow(clips[0]!.take.id)).trim_end_ms).toBe(trimmed);
    expect((await takeRow(clips[1]!.take.id)).prev_at_ms).toBe(GRID);
  });

  it("makes the clips a trim set aside right too, and marks them so that a pass run again does not trim them twice (D3)", async () => {
    const { id, clips, assets } = await storedLong();
    const a = await takeRow(clips[0]!.take.id);
    const b = await takeRow(clips[1]!.take.id);
    // set aside as a trim keeps them: the clip and its takes, inside the source's JSON
    const parked = { parked: [{ clip: { id: "zz-parked", kind: "video" }, takes: [{ ...a, clip_id: "zz-parked" }, { ...b, id: "zz-after", clip_id: "zz-parked" }] }] };
    await t.db.updateTable("timelines").set({ source: JSON.stringify(parked) }).where("id", "=", id).execute();
    const before = (await t.db.selectFrom("timelines").select("updated_at").where("id", "=", id).executeTakeFirstOrThrow()).updated_at;
    expect(await t.services.timelines.media.pictureLength(assets[0]!)).toBe(true);
    const row = await t.db.selectFrom("timelines").select(["source", "updated_at"]).where("id", "=", id).executeTakeFirstOrThrow();
    const takes = (JSON.parse(row.source!) as typeof parked).parked[0]!.takes;
    expect(takes[0]!.trim_end_ms).toBe(trimmed);
    expect(takes[1]!.prev_at_ms).toBe(GRID);
    // the user changed nothing: the lists keep their order
    expect(row.updated_at).toBe(before);
  });

  it("repairs the steps of a video the first pass set, the ones kept before it alone, once (D3 on data read before)", async () => {
    const { id, clips, assets } = await storedLong();
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { volume: 50 });
    // what the first pass did: the length and the takes on the clips, the step left at the old length
    await t.db.updateTable("assets").set({ duration_ms: 5146 }).where("id", "=", assets[0]!).execute();
    await t.db.updateTable("takes").set({ trim_end_ms: trimmed }).where("id", "=", clips[0]!.take.id).execute();
    await t.db.updateTable("takes").set({ prev_at_ms: GRID }).where("id", "=", clips[1]!.take.id).execute();
    await new Promise((r) => setTimeout(r, 5));
    const firstReadAt = now();
    await new Promise((r) => setTimeout(r, 5));
    // a step kept after: its takes are as they were made right, and stay so
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { volume: 60 });
    const media = t.services.timelines.media;
    expect(await media.pictureLength(assets[0]!, firstReadAt)).toBe(true);
    const steps = await t.db.selectFrom("timeline_history").select("snapshot").where("timeline_id", "=", id).orderBy("seq").execute();
    const trimIn = (text: string) => (JSON.parse(text) as { takes: Array<{ id: string; trim_end_ms: number }> }).takes.find((x) => x.id === clips[0]!.take.id)!.trim_end_ms;
    expect(steps.slice(-2).map((s) => trimIn(s.snapshot))).toEqual([trimmed, trimmed]);
    // run again (a stop half way, the next start): nothing more
    expect(await media.pictureLength(assets[0]!, firstReadAt)).toBe(false);
    // Undo twice: the trim and the hand-over as made right
    expect((await undo(id)).statusCode).toBe(200);
    expect((await undo(id)).statusCode).toBe(200);
    expect((await takeRow(clips[0]!.take.id)).trim_end_ms).toBe(trimmed);
    expect((await takeRow(clips[1]!.take.id)).prev_at_ms).toBe(GRID);
    // without the first pass behind it, a video stored at its picture's length is left as it is
    expect(await media.pictureLength(assets[1]!)).toBe(false);
  });

  it("brings a hand-over set aside past the picture to its end on a timeline changed since the first pass, its trims as they are", async () => {
    const { id, clips, assets } = await storedLong();
    const a = await takeRow(clips[0]!.take.id);
    const b = await takeRow(clips[1]!.take.id);
    const parked = { parked: [{ clip: { id: "zz-parked", kind: "video" }, takes: [{ ...a, clip_id: "zz-parked" }, { ...b, id: "zz-after", clip_id: "zz-parked" }] }] };
    await t.db.updateTable("timelines").set({ source: JSON.stringify(parked) }).where("id", "=", id).execute();
    // what the first pass did: the length and the takes on the clips
    await t.db.updateTable("assets").set({ duration_ms: 5146 }).where("id", "=", assets[0]!).execute();
    await t.db.updateTable("takes").set({ trim_end_ms: trimmed }).where("id", "=", clips[0]!.take.id).execute();
    await t.db.updateTable("takes").set({ prev_at_ms: GRID }).where("id", "=", clips[1]!.take.id).execute();
    await new Promise((r) => setTimeout(r, 5));
    const firstReadAt = now();
    await new Promise((r) => setTimeout(r, 5));
    // the timeline changed since: whether its clips set aside were made right is not known, a hand-over past the picture is
    await t.db.updateTable("timelines").set({ updated_at: now() }).where("id", "=", id).execute();
    expect(await t.services.timelines.media.pictureLength(assets[0]!, firstReadAt)).toBe(true);
    const takes = (JSON.parse((await t.db.selectFrom("timelines").select("source").where("id", "=", id).executeTakeFirstOrThrow()).source!) as typeof parked).parked[0]!.takes;
    expect(takes[0]!.trim_end_ms).toBe(a.trim_end_ms);
    expect(takes[1]!.prev_at_ms).toBe(GRID);
  });

  it("answers for a video whose file is gone, and throws for one it cannot read for now", async () => {
    const a = await upload(pod[0]!, "zz-test gone.mp4");
    await t.db.updateTable("assets").set({ duration_ms: 5280 }).where("id", "=", a.id).execute();
    const key = (await assetRow(a.id)).file_key;
    await t.services.storage.delete(key);
    expect(await t.services.timelines.media.pictureLength(a.id)).toBe(false);
  });

  it("is read again by the background, every video with sound in the library, and once more on data the first pass read", async () => {
    const { assets } = await chain(pod.slice(0, 2));
    const alone = await upload(pod[2]!, "zz-test not placed.mp4");
    // the first pass of 0.9.0 was through on this data: read again all the same (D4: the video not placed was never read)
    const firstReadAt = now();
    await t.db.insertInto("settings").values({ key: "videoLength.pictureRead", value: firstReadAt, updated_at: firstReadAt }).execute();
    const asked: Array<[string, string | null | undefined]> = [];
    const none = async () => {};
    const media = {
      motion: none, strip: none, means: none, joins: none, missing: async () => [], measureTogether: async () => true,
      pictureLength: async (id: string, at?: string | null) => (asked.push([id, at]), true),
    } as unknown as Pick<TimelineMedia, "motion" | "strip" | "means" | "joins" | "missing" | "measureTogether" | "pictureLength">;
    const pc1 = new Precompute(t.db, media, { backfillAfterMs: null, perMinute: 6000 });
    await pc1.backfill();
    await pc1.settled();
    expect(asked.map(([id]) => id).sort()).toEqual([...assets, alone.id].sort());
    expect(asked.every(([, at]) => at === firstReadAt)).toBe(true);
    await pc1.stop();
    // done once: a server started again does not read them again
    const pc2 = new Precompute(t.db, media, { backfillAfterMs: null, perMinute: 6000 });
    await pc2.backfill();
    await pc2.settled();
    expect(asked).toHaveLength(3);
    await pc2.stop();
  });
});

describe("the background's re-read of the lengths, without ffmpeg (card #207)", () => {
  /** A video with sound, as the library keeps one; no file behind it (the media is a stand-in). */
  async function videoRow(): Promise<string> {
    const id = newId();
    await t.db.insertInto("assets").values(newAssetRow({
      id, kind: "video", origin: "generated", name: "zz-test pod.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
      width: 192, height: 320, duration_ms: 5280, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: now(),
    })).execute();
    return id;
  }

  it("leaves the setting unsaid when one video could not be read: all are read again at the next start (D5)", async () => {
    const ids = [await videoRow(), await videoRow()];
    let ffprobe = false;
    const asked: string[] = [];
    const none = async () => {};
    const media = {
      motion: none, strip: none, means: none, joins: none, missing: async () => [], measureTogether: async () => true,
      pictureLength: async (id: string) => {
        asked.push(id);
        if (!ffprobe && id === ids[0]) throw new Error('"ffprobe" was not found on the machine Afflatus runs on.');
        return false;
      },
    } as unknown as Pick<TimelineMedia, "motion" | "strip" | "means" | "joins" | "missing" | "measureTogether" | "pictureLength">;
    const pc1 = new Precompute(t.db, media, { backfillAfterMs: null, perMinute: 6000 });
    await pc1.backfill();
    await pc1.settled();
    await pc1.stop();
    expect(asked.sort()).toEqual([...ids].sort());
    expect(await t.db.selectFrom("settings").select("key").where("key", "like", "videoLength.%").execute()).toEqual([]);
    // ffmpeg installed: the next start reads them all, and says so
    ffprobe = true;
    const pc2 = new Precompute(t.db, media, { backfillAfterMs: null, perMinute: 6000 });
    await pc2.backfill();
    await pc2.settled();
    await pc2.stop();
    expect(asked).toHaveLength(4);
    expect(await t.db.selectFrom("settings").select("key").where("key", "like", "videoLength.%").execute()).toHaveLength(1);
  });

  it("lands a take planned on the clip before's longer length at that clip's end, not past its picture (B4)", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test landing" });
    const before = await videoRow();
    // read again as its picture's: 124 frames of the model's at 24 a second
    await t.db.updateTable("assets").set({ duration_ms: 5146, latent_frames: N }).where("id", "=", before).execute();
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: before });
    const second = (await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/clips`, payload: { recipe: "h3.video" } })).json().clip as string;
    const prev = (await view(tl.id)).clips[0].take.id as string;
    const generation = newId();
    await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    const made = await videoRow();
    await t.db.updateTable("assets").set({ generation_id: generation }).where("id", "=", made).execute();
    // planned while it was still 5280 long: handed over at 5280
    await t.services.timelines.finished(second, generation, { headMs: 917, tailMs: 0 }, { prev: { take: prev, at: 5280 } });
    const landed = await t.db.selectFrom("takes").selectAll().where("clip_id", "=", second).executeTakeFirstOrThrow();
    expect(landed.prev_at_ms).toBe(GRID);
  });
});
