import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { FFMPEG_TIMEOUT } from "./clipKit";
import { clicks, ffmpegThere, firstMiss, H, readFrames, runs, silentMs, synth, synthMade, W, waveShift } from "./framesKit";
import { get, sentView, withTakes, makeApp, until, type TestApp } from "./helpers";

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
  return sentView(res.json());
};
const view = async (id: string) => withTakes((await get(t.app, `/api/timelines/${id}`)).json());
const upload = async (bytes: Uint8Array, name: string) => {
  const res = await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "video/mp4" }, payload: Buffer.from(bytes) });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json() as { id: string; durationMs: number };
};
/** The timeline exported, and the file's bytes. */
async function exportOf(id: string, range?: { inMs: number; outMs: number }): Promise<Uint8Array> {
  await call("POST", `/api/timelines/${id}/export`, { match: false, ...(range ? { range } : {}) });
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
    // the clicks fall on the frames whose own index is a tenth: the sound is cut with its picture. Each join's last 120 ms are
    // heard from the clip after's head (SOUND_HANDOVER_MS): its frame 40, three before its first seen one, clicks there too
    // (a real seamless take's head holds the clip before's own moments; these synthetic ones do not)
    const joins = want.flatMap((f, i) => (i > 0 && f.clip !== want[i - 1]!.clip ? [i] : []));
    const tenths = [...want.flatMap((f, i) => (f.index % 10 === 0 ? [i] : [])), ...joins.map((j) => j - 3)].sort((a, b) => a - b);
    const heard = clicks(out, 48);
    for (const at of tenths) expect(heard.some((h) => Math.abs(h - at) <= 1), `a click near frame ${at}`).toBe(true);
    expect(heard.length).toBe(tenths.length);
  });

  it("hands a seamless join's sound over before the clip before's last moments, which H3 leaves silent", async () => {
    // one tone along the whole chain: each take's own part of it, its last 60 ms silent as every H3 take that carries on ends
    // (20 to 116 ms measured), and its head (the 917 ms run-up) the clip before's last moments, the same tone at the same time
    const ends = (k: number) => k * (5146 - 896) / 1000;
    const tone = (k: number, last: boolean) => `if(${last ? "1" : "lt(t,5.086)"},0.5*sin(2*PI*440*(t+${ends(k)})),0)`;
    const sounding = await Promise.all([1, 2, 3].map((c, k) => synthMade(c, FILE, 48, undefined, tone(k, k === 2))));
    const { id } = await chain(sounding, N);
    const out = await exportOf(id);
    expect(firstMiss(readFrames(out), runs([1, 0, FILE - 1], [2, 43, FILE - 1], [3, 43, FILE - 1]))).toBeNull();
    // no silence at either join: at most a few ms quieter than the tone around them
    for (const join of [5146, 5146 + 4958]) expect(silentMs(out, join - 200, join + 100), `silence at the join at ${join} ms`).toBeLessThanOrEqual(3);
  });

  it("keeps a Lip sync join's sound with the clip before to its end: the clip after's head is the model's guess, never heard", async () => {
    // a song along two Lip sync clips: the first sings it to its last moment (the recording handed on after its part); the
    // second's head is filed with it from the frame of it that shows (896 ms, recordingLeadIn), silent before (never heard)
    const ends = (k: number) => k * (5146 - 896) / 1000;
    const song = (k: number) => `if(${k === 0 ? "1" : "gte(t,0.896)"},0.5*sin(2*PI*440*(t+${ends(k)})),0)`;
    const sung = await Promise.all([1, 2].map((c, k) => synthMade(c, FILE, 48, undefined, song(k))));
    const { id, clips } = await chain(sung, N);
    await t.db.updateTable("clips").set({ recipe_id: "h3.lipsync" }).where("id", "in", clips.map((c) => c.id)).execute();
    expect((await view(id)).clips[1].take.laidSound).toBe(true);
    const out = await exportOf(id);
    // handed over 120 ms early, the guess's silence was heard just before the join
    expect(silentMs(out, 5146 - 200, 5146 + 100), "silence before the join").toBeLessThanOrEqual(3);
  });

  it("runs a song on across a Lip sync join whose head was filed with it: no drop-out, nothing twice, to the sample", async () => {
    // two tones (no shift but none matches them both, so where the export is in them is read back to the sample), the song:
    // the first clip sings it to its end, the second, its head filed with it (recordingLeadIn), from its first frame
    const ends = (k: number) => k * (5146 - 896) / 1000;
    const song = (k: number) => `0.3*sin(2*PI*440*(t+${ends(k)}))+0.3*sin(2*PI*523*(t+${ends(k)}))`;
    const sung = await Promise.all([1, 2].map((c, k) => synthMade(c, FILE, 48, undefined, song(k))));
    const { id, clips } = await chain(sung, N);
    await t.db.updateTable("clips").set({ recipe_id: "h3.lipsync" }).where("id", "in", clips.map((c) => c.id)).execute();
    const second = await t.db.selectFrom("takes").innerJoin("assets", "assets.id", "takes.asset_id").select("assets.id").where("takes.id", "=", clips[1]!.take.id).executeTakeFirstOrThrow();
    await t.db.insertInto("generations").values({ id: "zz-sung", owner_id: "local", recipe_id: "h3.lipsync", recipe_version: 1, family: "h3", inputs: JSON.stringify({ recordingLeadIn: true }), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    await t.db.updateTable("assets").set({ generation_id: "zz-sung" }).where("id", "=", second.id).execute();
    expect((await view(id)).clips[1].take).toMatchObject({ laidSound: true, headSung: true });
    // a range from 4.3 s, between two frames (as Timeline 24's export): its picture starts on the frame before, 8.3 ms early
    const out = await exportOf(id, { inMs: 4300, outMs: 6600 });
    expect(silentMs(out, 846 - 200, 846 + 100), "silence at the join").toBeLessThanOrEqual(0);
    // where the export is in the song, 200 ms before the join and 100 ms after: the same, to a sample (it starts on the frame
    // its picture starts on, 4291.67 ms, so 8.33 ms before In all along). Its sound cut to the moments, a frame was lost there
    const heard = (s: number) => 0.3 * Math.sin(2 * Math.PI * 440 * (s + 4.3)) + 0.3 * Math.sin(2 * Math.PI * 523 * (s + 4.3));
    const before = waveShift(out, 846 - 200, heard);
    expect(before).toBeCloseTo(-8.33, 1);
    expect(Math.abs(waveShift(out, 846 + 100, heard) - before)).toBeLessThan(1000 / 48000 + 1e-9);
  });

  it("crossfades a SCAIL-2 window over its head (the clip before's own last moments made again), both moving, the clock unmoved", async () => {
    // two windows at 32 a second: the second's first 9 frames (281 ms) are its head, hidden; the join fades over its last 170 ms
    const a = await upload(synth(4, 153, 32), "w1.mp4");
    const b = await upload(synth(5, 161, 32), "w2.mp4");
    const tl = await call("POST", "/api/timelines", { name: "windows" });
    for (const v of [a, b]) await call("POST", `/api/timelines/${tl.id}/clips`, { asset: v.id });
    const clips = (await view(tl.id)).clips as Array<{ id: string; take: { id: string } }>;
    await call("PATCH", `/api/clips/${clips[1]!.id}`, { joined: "continue" });
    await t.db.updateTable("takes").set({ head_ms: 281, join_kind: "window", prev_take_id: clips[0]!.take.id, prev_at_ms: a.durationMs }).where("id", "=", clips[1]!.take.id).execute();
    const v = await view(tl.id);
    expect(v.clips[1].take.joinKind).toBe("window");
    const out = await exportOf(tl.id);
    const got = readFrames(out);
    // as long as the two play: the first whole, the second from its head's end; the fade inside, not added
    expect(Math.abs(got.length - Math.round(((a.durationMs + b.durationMs - 281) * 32) / 1000))).toBeLessThanOrEqual(1);
    // the first plays to within the fade of its end, the second from its head's end on; over the fade (its last ~5 frames) the
    // two are mixed: their barcodes read as neither clip
    expect(got.slice(0, 140).every((f) => f.clip === 4)).toBe(true);
    expect(got.slice(148, 153).filter((f) => f.clip !== 4).length).toBeGreaterThanOrEqual(2);
    expect(got.slice(-100).every((f) => f.clip === 5)).toBe(true);
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
