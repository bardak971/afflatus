import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import type { AssetRow } from "../src/timelineModel";
import { get, makeApp, type TestApp } from "./helpers";

/**
 * A timeline's source lane: a long video made into Motion transfer clips window by window (timelineSource.ts). Rows put in
 * by hand; nothing is rendered and no file is read (no scene cuts asked for).
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw Object.assign(new Error(`${method} ${url}: ${res.statusCode} ${res.body}`), { statusCode: res.statusCode });
  return res.json();
};
const view = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json();

async function asset(kind: "video" | "image", over: Partial<AssetRow> = {}): Promise<AssetRow> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind, origin: "uploaded", name: kind === "video" ? "meme.mp4" : "nicolas.png", file_key: `assets/${id.slice(0, 2)}/${id}`, thumb_key: null, mime: kind === "video" ? "video/mp4" : "image/png", bytes: 1000,
    width: 480, height: 854, duration_ms: kind === "video" ? 28000 : null, fps: kind === "video" ? 24 : null, has_sound: kind === "video" ? 1 : 0, folder_id: null, generation_id: null, kept_at: now(), ...over,
  })).execute();
  return t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

describe("a timeline's source lane", () => {
  it("is set by a video, its stretch and form kept, and taken away", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    let v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    expect(v.source).toMatchObject({ asset: meme.id, atMs: 0, fromMs: 0, toMs: 28000, windowMs: 5000 });
    expect(v.source.video.id).toBe(meme.id);
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "scail.motion", inputs: { prompt: "A man raps." } } });
    expect(v.source).toMatchObject({ fromMs: 3000, toMs: 28000, recipe: "scail.motion", inputs: { prompt: "A man raps." } });
    // a stretch past the video's end is held within it
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: { toMs: 99000 } });
    expect(v.source.toMs).toBe(28000);
    v = await call("PATCH", `/api/timelines/${tl.id}`, { source: null });
    expect(v.source).toBeNull();
    await expect(call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: (await asset("image")).id } })).rejects.toThrow(/video/);
  });

  it("is made into clips: one a window, each carrying on from the one before, the same picture, prompt and seed", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    const picture = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "scail.motion", inputs: { picture: picture.id, prompt: "A man raps.", seed: 42, steps: 8 } } });
    const made = await call("POST", `/api/timelines/${tl.id}/source/make`);
    expect(made.clips).toHaveLength(5);
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual(made.clips);
    expect(v.clips.map((c: { joined: string }) => c.joined)).toEqual(["cut", "continue", "continue", "continue", "continue"]);
    for (const c of v.clips) {
      expect(c.recipe).toBe("scail.motion");
      // the source's whole form in every window: its picture, prompt, seed and a setting changed in it
      expect(c.inputs).toMatchObject({ driving: { asset: meme.id }, picture: picture.id, prompt: "A man raps.", seed: 42, steps: 8 });
    }
    expect(v.clips[0].inputs.drivingStart).toBe(3);
    // the next part starts the carried frames (5 at 16 fps) before where the first one's clip stops
    expect(v.clips[1].inputs.drivingStart).toBeCloseTo(3 + 77 / 16 - 5 / 16, 3);
    // the source's start sits so that its stretch plays from where the clips start
    expect(v.source.atMs).toBe(-3000);
    // one step for Undo
    expect(v.undo).toMatch(/5 clips made from the source/);
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips).toHaveLength(0);
  });

  it("takes the place of the clip its stretch was taken from", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    const picture = await asset("image");
    const first = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: meme.id })).clip;
    const second = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: meme.id })).clip;
    // the second plays the meme from 3 s (trimmed), as a split there leaves it
    await call("PATCH", `/api/clips/${second}`, { trimStartMs: 3000 });
    const before = await view(tl.id);
    const c2 = before.clips[1];
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id, atMs: c2.atMs - c2.take.startMs, fromMs: c2.take.startMs, toMs: c2.take.endMs, clip: second, recipe: "wananimate.motion", inputs: { picture: picture.id } } });
    const made = await call("POST", `/api/timelines/${tl.id}/source/make`);
    const v = await view(tl.id);
    expect(v.clips[0].id).toBe(first);
    expect(v.clips.slice(1).map((c: { id: string }) => c.id)).toEqual(made.clips);
    expect(v.clips.some((c: { id: string }) => c.id === second)).toBe(false);
    expect(v.clips[1].inputs.drivingStart).toBe(3);
    // the source stays where it was laid, and no longer names the clip it replaced
    expect(v.source.atMs).toBe(c2.atMs - 3000);
    expect(v.source.clip).toBeNull();
  });

  it("is split at a moment: the part before plays as it is, a clip of its own, and Motion transfer starts there", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    const { clip } = await call("POST", `/api/timelines/${tl.id}/source/split`, { atMs: 3000 });
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([clip]);
    expect(v.clips[0].take).toMatchObject({ startMs: 0, endMs: 3000 });
    expect(v.source.fromMs).toBe(3000);
    expect(v.undo).toMatch(/source split/);
    await expect(call("POST", `/api/timelines/${tl.id}/source/split`, { atMs: 27900 })).rejects.toThrow(/stretch/);
  });

  it("is refused without a model that makes a source window by window, or without a source", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    await expect(call("POST", `/api/timelines/${tl.id}/source/make`)).rejects.toThrow(/Source lane/);
    const meme = await asset("video");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id, recipe: "h3.video" } });
    await expect(call("POST", `/api/timelines/${tl.id}/source/make`)).rejects.toThrow(/window by window/);
  });
});

describe("the windows of a source", () => {
  /** A source of the meme made into SCAIL windows from 3 s, with this form; the windows' ids. */
  async function made(tl: { id: string }, inputs: Record<string, unknown>): Promise<string[]> {
    const meme = await asset("video");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { fromMs: 3000, recipe: "scail.motion", inputs } });
    return (await call("POST", `/api/timelines/${tl.id}/source/make`)).clips as string[];
  }

  it("are given no seed of their own when none was typed: each render draws one, and the source's form stays random", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    await made(tl, { prompt: "A man raps.", seed: -1 });
    const v = await view(tl.id);
    // one seed drawn for every window was a typed seed to the seed mode: every New take was sent with it again
    for (const c of v.clips) expect(c.inputs.seed ?? -1).toBe(-1);
    expect(v.source.inputs.seed).toBe(-1);
  });

  it("share their prompt as their Picture: written on one, every window and the source take it; the seed and the part stay each one's", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const ids = await made(tl, { prompt: "A man raps.", seed: 42 });
    const one = (await view(tl.id)).clips[1];
    await call("PATCH", `/api/clips/${ids[1]}`, { inputs: { ...one.inputs, prompt: "A woman sings.", seed: 7 } });
    let v = await view(tl.id);
    expect(v.clips.map((c: { inputs: { prompt: string } }) => c.inputs.prompt)).toEqual(ids.map(() => "A woman sings."));
    expect(v.source.inputs.prompt).toBe("A woman sings.");
    expect(v.clips.map((c: { inputs: { seed: number } }) => c.inputs.seed)).toEqual([42, 7, 42, 42, 42]);
    expect(new Set(v.clips.map((c: { inputs: { drivingStart: number } }) => c.inputs.drivingStart)).size).toBe(ids.length);
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { inputs: { ...v.source.inputs, prompt: "A man dances." } } });
    v = await view(tl.id);
    expect(v.clips.every((c: { inputs: { prompt: string } }) => c.inputs.prompt === "A man dances.")).toBe(true);
  });

  it("made a cut, no longer start their carried frames early; made to carry on again, they do; a duplicate is a cut too", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const ids = await made(tl, {});
    const before = (await view(tl.id)).clips[2].inputs;
    // SCAIL carries 5 frames at 16 fps
    await call("PATCH", `/api/clips/${ids[2]}`, { joined: "cut" });
    const cut = (await view(tl.id)).clips[2].inputs;
    expect(cut.drivingStart).toBeCloseTo(before.drivingStart + 5 / 16, 3);
    expect(cut.drivingSeconds).toBeCloseTo(before.drivingSeconds - 5 / 16, 3);
    await call("PATCH", `/api/clips/${ids[2]}`, { joined: "continue" });
    const again = (await view(tl.id)).clips[2].inputs;
    expect(again.drivingStart).toBeCloseTo(before.drivingStart, 3);
    expect(again.drivingSeconds).toBeCloseTo(before.drivingSeconds, 3);
    await call("POST", `/api/clips/${ids[3]}/duplicate`);
    const v = await view(tl.id);
    expect(v.clips[4].joined).toBe("cut");
    expect(v.clips[4].inputs.drivingStart).toBeCloseTo(v.clips[3].inputs.drivingStart + 5 / 16, 3);
  });

  it("are not what a clip added after them is made with: it takes the timeline's other model, else none", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const ids = await made(tl, {});
    const alone = (await call("POST", `/api/timelines/${tl.id}/clips`, { after: ids[4] })).clip;
    expect((await view(tl.id)).clips.find((c: { id: string }) => c.id === alone).recipe).toBeNull();
    await call("POST", `/api/timelines/${tl.id}/clips`, { after: null, recipe: "h3.video" });
    const next = (await call("POST", `/api/timelines/${tl.id}/clips`, { after: ids[2] })).clip;
    expect((await view(tl.id)).clips.find((c: { id: string }) => c.id === next).recipe).toBe("h3.video");
  });
});

describe("the Picture of a source's windows", () => {
  it("is one: changed on a window or on the source, every window and the source take it", async () => {
    const tl = await call("POST", "/api/timelines", { name: "zz-test source" });
    const meme = await asset("video");
    const first = await asset("image");
    const second = await asset("image");
    const third = await asset("image");
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { asset: meme.id } });
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { recipe: "scail.motion", inputs: { picture: first.id } } });
    const made = (await call("POST", `/api/timelines/${tl.id}/source/make`)).clips as string[];
    const one = (await view(tl.id)).clips[2];
    await call("PATCH", `/api/clips/${made[2]}`, { inputs: { ...one.inputs, picture: second.id } });
    let v = await view(tl.id);
    expect(v.clips.map((c: { inputs: { picture: string } }) => c.inputs.picture)).toEqual(made.map(() => second.id));
    expect(v.source.inputs.picture).toBe(second.id);
    await call("PATCH", `/api/timelines/${tl.id}`, { source: { inputs: { ...v.source.inputs, picture: third.id } } });
    v = await view(tl.id);
    expect(v.clips.every((c: { inputs: { picture: string } }) => c.inputs.picture === third.id)).toBe(true);
  });
});
