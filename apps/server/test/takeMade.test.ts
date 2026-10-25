import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, OWNER } from "../src/db";
import { newAssetRow } from "../src/media";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * Each take says what it was made with, read from its own render, never from its clip's form (card #89): its form as
 * typed (the cast's additions and what the timeline filled in left out), the seed it was rendered with, its flips. A
 * finish says its draft's. Use this take's settings is one Undo step, named after the take.
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

/** A video of the library, rendered here with this record when given one. */
async function video(g: { inputs: Record<string, unknown>; asked?: Record<string, unknown>; resolved?: Record<string, unknown>; recipe?: string } | null, source: string | null = null): Promise<string> {
  const id = newId();
  let generation: string | null = null;
  if (g) {
    generation = newId();
    await t.db.insertInto("generations").values({
      id: generation, owner_id: OWNER, recipe_id: g.recipe ?? "h3.video", recipe_version: 1, family: "h3", inputs: JSON.stringify(g.inputs), resolved: JSON.stringify(g.resolved ?? {}),
      gen_ms: 1, draft_id: null, created_at: now(), asked: g.asked ? JSON.stringify(g.asked) : null,
    } as never).execute();
  }
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "video", origin: source ? "cut" : "generated", name: "zz-test made.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 576, height: 1024, duration_ms: 5000, fps: 24, has_sound: 1, folder_id: null, generation_id: generation, source_id: source, kept_at: now(),
  })).execute();
  return id;
}

async function take(clip: string, asset: string, o: { finishedFrom?: string; prev?: string } = {}): Promise<string> {
  const id = newId();
  await t.db.insertInto("takes").values({ id, clip_id: clip, asset_id: asset, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: o.prev ?? null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: o.finishedFrom ?? null, created_at: now() }).execute();
  return id;
}

async function oneClip(): Promise<{ timeline: string; clip: string }> {
  const tl = (await t.app.inject({ method: "POST", url: "/api/timelines", payload: { name: "zz-test take made" } })).json();
  await t.app.inject({ method: "POST", url: `/api/timelines/${tl.id}/clips`, payload: { recipe: "h3.video" } });
  return { timeline: tl.id, clip: (await get(t.app, `/api/timelines/${tl.id}`)).json().clips[0].id };
}

const takesOf = async (timeline: string) => (await get(t.app, `/api/timelines/${timeline}`)).json().clips[0].takes as Array<{ id: string; made: { recipe: string; form: Record<string, unknown>; carried?: boolean; mirror: string[] } | null }>;

describe("what a take was made with", () => {
  it("is its own render's form, with the seed it was rendered with and its flips, the timeline's part left out", async () => {
    const { timeline, clip } = await oneClip();
    const a = await take(clip, await video({
      inputs: { description: "a red kite over a beach", start: "pic-a", seed: -1, previous: { asset: "x", at: 1000 }, recording: "song", references: [{ asset: "ref-a", role: "person" }] },
      resolved: { seed: 4242, mirror: ["start"] },
    }));
    const [x] = await takesOf(timeline);
    expect(x!.id).toBe(a);
    expect(x!.made).toEqual({ recipe: "h3.video", form: { description: "a red kite over a beach", start: "pic-a", seed: 4242, references: [{ asset: "ref-a", role: "person" }] }, mirror: ["start"] });
  });

  it("is the form as typed when the cast changed it: what the cast added is not the form's", async () => {
    const { timeline, clip } = await oneClip();
    // the record as the queue keeps it: the form sent with the cast worked in, and as typed (the cast's references dropped)
    await take(clip, await video({ inputs: { description: "Ava, red hair: walks in", references: [{ asset: "ava", role: "person" }], seed: 7 }, asked: { description: "walks in", seed: 7 } }));
    const [x] = await takesOf(timeline);
    expect(x!.made!.form).toEqual({ description: "walks in", seed: 7 });
  });

  it("has no first frame of its own when it opened on the still before it", async () => {
    const { timeline, clip } = await oneClip();
    await take(clip, await video({ inputs: { description: "on", start: "the-still" } }), { prev: "still:the-still" });
    const [x] = await takesOf(timeline);
    expect(x!.made).toMatchObject({ carried: true, form: { description: "on" } });
    expect(x!.made!.form.start).toBeUndefined();
  });

  it("of a finish, is its draft's: what the finish added is not the clip's form", async () => {
    const { timeline, clip } = await oneClip();
    const draftVideo = await video({ inputs: { description: "the draft", seed: 3 } });
    const draft = await take(clip, draftVideo);
    const refined = await take(clip, await video({ inputs: { description: "the draft", seed: 3, faceRefineOnly: true } }), { finishedFrom: draft });
    const cut = await take(clip, await video(null, draftVideo), { finishedFrom: draft });
    const all = await takesOf(timeline);
    for (const id of [refined, cut]) expect(all.find((y) => y.id === id)!.made!.form).toEqual({ description: "the draft", seed: 3 });
  });

  it("is null for a take rendered nowhere here", async () => {
    const { timeline, clip } = await oneClip();
    await take(clip, await video(null));
    expect((await takesOf(timeline))[0]!.made).toBeNull();
  });
});

describe("Use this take's settings", () => {
  it("is one Undo step named after the take, and takes the form back", async () => {
    const { timeline, clip } = await oneClip();
    await t.app.inject({ method: "PATCH", url: `/api/clips/${clip}`, payload: { inputs: { description: "typed since" } } });
    await take(clip, await video({ inputs: { description: "the first" } }));
    const second = await take(clip, await video({ inputs: { description: "the second", seed: 9 } }));
    const r = await t.app.inject({ method: "PATCH", url: `/api/clips/${clip}`, payload: { recipe: "h3.video", inputs: { description: "the second", seed: 9 }, pinMirror: { start: false }, settingsOf: second } });
    expect(r.statusCode).toBe(200);
    const v = (await get(t.app, `/api/timelines/${timeline}`)).json();
    expect(v.clips[0].inputs).toEqual({ description: "the second", seed: 9 });
    expect(v.undo).toBe("the settings of take 2");
    await t.app.inject({ method: "POST", url: `/api/timelines/${timeline}/undo` });
    expect((await get(t.app, `/api/timelines/${timeline}`)).json().clips[0].inputs).toEqual({ description: "typed since" });
  });

  it("is refused for a take of another clip", async () => {
    const { clip } = await oneClip();
    const other = await oneClip();
    const theirs = await take(other.clip, await video({ inputs: { description: "theirs" } }));
    const r = await t.app.inject({ method: "PATCH", url: `/api/clips/${clip}`, payload: { inputs: { description: "theirs" }, settingsOf: theirs } });
    expect(r.statusCode).toBe(404);
  });
});
