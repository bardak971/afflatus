import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * A finished take (an upscale, made by a cut) is not measured: it shows the figures of the video it was cut from. After a
 * Face refine (Face refine first, then SeedVR2: the rethink's Finish) that is the Face refine's, with its faces, not the draft's.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

/** A video of the library: rendered here with these figures, or cut from another (`source`). */
async function video(face: number | null, source: string | null = null): Promise<string> {
  const id = newId();
  let generation: string | null = null;
  if (face !== null) {
    generation = newId();
    await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: "{}", gen_ms: 1, draft_id: null, created_at: now(), measure: JSON.stringify({ luma: 100, sharp: 10, face }) } as never).execute();
  }
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: source ? "cut" : "generated", name: "zz-test v.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 576, height: 1024, duration_ms: 5000, fps: 24, has_sound: 1, folder_id: null, generation_id: generation, source_id: source, kept_at: now(),
  })).execute();
  return id;
}

async function take(clip: string, asset: string, finishedFrom: string | null): Promise<string> {
  const id = newId();
  await t.db.insertInto("takes").values({ id, clip_id: clip, asset_id: asset, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: finishedFrom, created_at: now() }).execute();
  return id;
}

describe("a finished take's figures", () => {
  it("are the Face refine's when it was cut from one, else the draft's", async () => {
    const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test finished figures" } })).json();
    const clip = (await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/clips`, payload: { recipe: "h3.video" } })).json();
    const clipId = (clip.id ?? (await get(t.app, `/api/timelines/${tl.id}`)).json().clips[0].id) as string;
    const draftVideo = await video(0.7);
    const draft = await take(clipId, draftVideo, null);
    const refined = await video(0.8);
    await take(clipId, refined, draft);
    const upscaled = await take(clipId, await video(null, refined), draft);
    const plain = await take(clipId, await video(null, draftVideo), draft);
    const v = (await get(t.app, `/api/timelines/${tl.id}`)).json();
    const of = (id: string) => v.clips[0].takes.find((x: { id: string }) => x.id === id);
    expect(of(upscaled).measure.face).toBe(0.8);
    expect(of(plain).measure.face).toBe(0.7);
  });
});
