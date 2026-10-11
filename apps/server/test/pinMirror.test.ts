import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { migrate, openSqlite, OWNER } from "../src/db";
import { mirrorPicture } from "../src/thumbs";
import { mirroredPins } from "../src/timelineModel";
import { FFMPEG_TIMEOUT, ffmpegThere } from "./clipKit";
import { until, type TestApp } from "./helpers";
import { timelineSteps, timelineSuite } from "./timelineKit";

/** Mirror on a clip's pinned frame: flipped as it is uploaded, the library's picture as it was, and only on the user's own pins. */

const s = timelineSuite();
const { call, view, finish } = timelineSteps(s);
let fake: FakeComfy;
let t: TestApp;
let three: Uint8Array;
beforeAll(() => void ({ three } = s.clips ?? {}));
beforeEach(() => void ({ fake, t } = s));

/** An 8 × 4 picture that is not its own mirror: red on the left half, green on the right. */
const picture = async (): Promise<Buffer> => {
  const px = Buffer.alloc(8 * 4 * 3);
  for (let i = 0; i < 8 * 4; i++) px[i * 3 + ((i % 8) < 4 ? 0 : 1)] = 255;
  return sharp(px, { raw: { width: 8, height: 4, channels: 3 } }).png().toBuffer();
};

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe("migration 0054, the pinned frames' mirror", () => {
  it("adds the clip's flips and the job's, empty on what was there", async () => {
    const db = openSqlite(":memory:");
    await migrate(db, "0053_render_digests");
    const at = new Date().toISOString();
    await db.insertInto("timelines").values({ id: "tl", owner_id: OWNER, name: "Old", width: null, height: null, created_at: at, updated_at: at } as never).execute();
    await db.insertInto("clips").values({ id: "clip", timeline_id: "tl", position: 0, take_id: null, joined: "cut", recipe_id: null, inputs: "{}", created_at: at, updated_at: at } as never).execute();
    expect(await migrate(db)).toContain("0054_pin_mirror");
    expect(await db.selectFrom("clips").select("pin_mirror").executeTakeFirst()).toEqual({ pin_mirror: null });
    await db.destroy();
  });
});

describe("which pinned frames a render flips", () => {
  const recipe = {
    inputs: [
      { id: "start", type: "image", role: "start" },
      { id: "end", type: "image", role: "end" },
      { id: "mid", type: "image", role: "mid", at: "midAt" },
      { id: "previous", type: "clip", role: "previous" },
    ],
  } as never;
  it("only the user's own: not a first frame carried on from the clip before, nor a last frame landed on the clip after", () => {
    const inputs = { start: "a", end: "b", mid: "c" };
    expect(mirroredPins(recipe, inputs, ["start", "end", "mid"], { carries: false })).toEqual(["end", "mid", "start"]);
    expect(mirroredPins(recipe, inputs, ["start", "end"], { carries: true })).toEqual(["end"]);
    expect(mirroredPins(recipe, inputs, ["start", "end"], { carries: false, lands: true })).toEqual(["start"]);
    // nothing pinned there, or the opening picture still to come from the clip before: nothing to flip
    expect(mirroredPins(recipe, { start: "the-clip-before" }, ["start", "end"], { carries: false })).toEqual([]);
  });
});

describe.skipIf(!ffmpegThere)("a mirrored pinned frame", { timeout: FFMPEG_TIMEOUT }, () => {
  /** A timeline with one clip opening on a zz-test picture, its id and the picture's. */
  async function pinned() {
    const bytes = await picture();
    const res = await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test%20pin", headers: { "content-type": "image/png" }, payload: bytes });
    const asset = res.json().id as string;
    const tl = await call("POST", "/api/timelines", { name: "zz-test mirror" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await call("PATCH", `/api/clips/${clip}`, { inputs: { description: "A lighthouse.", start: asset } });
    return { id: tl.id as string, clip, asset, bytes: new Uint8Array(bytes) };
  }
  const renderClip = (id: string, clip: string, asset: string) => call("POST", `/api/timelines/${id}/render`, { clips: [{ id: clip, input: { description: "A lighthouse.", start: asset } }] });
  const libraryFile = async (asset: string) => new Uint8Array((await t.app.inject({ method: "GET", url: `/api/assets/${asset}/file` })).rawPayload);

  it("is uploaded flipped left to right, the library's picture left byte for byte as it was", async () => {
    const { id, clip, asset, bytes } = await pinned();
    await call("PATCH", `/api/clips/${clip}`, { pinMirror: { start: true } });
    expect((await view(id)).clips[0].pinMirror).toEqual(["start"]);
    await renderClip(id, clip, asset);
    await finish(three!, 1);
    const sent = Object.values(fake.uploaded);
    const flipped = (await mirrorPicture(bytes, "horizontal"))!;
    expect(sent.some((u) => same(u, flipped))).toBe(true);
    expect(sent.some((u) => same(u, bytes))).toBe(false);
    expect(same(await libraryFile(asset), bytes)).toBe(true);
    // the take remembers the flip: it is the clip as it stands
    const v = await view(id);
    expect(v.clips[0]).toMatchObject({ mirrorChanged: false, take: { asset: { kind: "video" } } });
    const made = (await t.app.inject({ method: "GET", url: `/api/assets/${v.clips[0].take.asset.id}` })).json();
    expect(made.generation.resolved.mirror).toEqual(["start"]);
  });

  it("marks the take as not the clip's once Mirror is switched after it was rendered, and back when switched back", async () => {
    const { id, clip, asset } = await pinned();
    await renderClip(id, clip, asset);
    await finish(three!, 1);
    expect((await view(id)).clips[0].mirrorChanged).toBe(false);
    await call("PATCH", `/api/clips/${clip}`, { pinMirror: { start: true } });
    expect((await view(id)).clips[0].mirrorChanged).toBe(true);
    await call("PATCH", `/api/clips/${clip}`, { pinMirror: { start: false } });
    expect((await view(id)).clips[0]).toMatchObject({ mirrorChanged: false, pinMirror: [] });
  });

  it("is passed over on a first frame when the clip carries on from the one before: the join must meet", async () => {
    const { id, clip, asset, bytes } = await pinned();
    await renderClip(id, clip, asset);
    await finish(three!, 1);
    const b = (await call("POST", `/api/timelines/${id}/clips`, {})).clip as string;
    // pinned and flipped while it was a cut, then made to carry on: the flip stays on the clip, and is not used
    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    await call("PATCH", `/api/clips/${b}`, { inputs: { description: "A lighthouse.", start: asset }, pinMirror: { start: true } });
    await call("PATCH", `/api/clips/${b}`, { joined: "continue" });
    const before = Object.keys(fake.uploaded).length;
    await renderClip(id, b, asset);
    await finish(three!, 2);
    const sent = Object.entries(fake.uploaded).slice(before).map(([, u]) => u);
    const flipped = (await mirrorPicture(bytes, "horizontal"))!;
    expect(sent.some((u) => same(u, flipped))).toBe(false);
    const v = await view(id);
    expect(v.clips[1]).toMatchObject({ joined: "continue", pinMirror: ["start"], mirrorChanged: false });
    const made = (await t.app.inject({ method: "GET", url: `/api/assets/${v.clips[1].take.asset.id}` })).json();
    expect(made.generation.resolved.mirror).toBeUndefined();
  });

  it("is refused where nothing is pinned, and goes when its picture is changed or removed", async () => {
    const { id, clip } = await pinned();
    const res = await t.app.inject({ method: "PATCH", url: `/api/clips/${clip}`, payload: { pinMirror: { end: true } } });
    expect(res.statusCode).toBe(400);
    await call("PATCH", `/api/clips/${clip}`, { pinMirror: { start: true } });
    await call("PATCH", `/api/clips/${clip}`, { inputs: { description: "A lighthouse." } });
    expect((await view(id)).clips[0].pinMirror).toEqual([]);
  });

  it("comes back with Undo and goes again with Redo, and is copied by Duplicate and by a split", async () => {
    const { id, clip, asset } = await pinned();
    await renderClip(id, clip, asset);
    await finish(three!, 1);
    await call("PATCH", `/api/clips/${clip}`, { pinMirror: { start: true } });
    expect((await view(id)).undo).toBe("the frame mirrored");
    await call("POST", `/api/timelines/${id}/undo`);
    expect((await view(id)).clips[0].pinMirror).toEqual([]);
    await call("POST", `/api/timelines/${id}/redo`);
    expect((await view(id)).clips[0].pinMirror).toEqual(["start"]);

    await call("POST", `/api/clips/${clip}/duplicate`);
    await until(async () => (await view(id)).clips.length === 2);
    expect((await view(id)).clips.map((c: { pinMirror: string[] }) => c.pinMirror)).toEqual([["start"], ["start"]]);
    // both parts of a split keep the whole form, its first frame with it, so both keep the flip
    await call("POST", `/api/clips/${clip}/split`, { atMs: 1500 });
    const v = await view(id);
    expect(v.clips).toHaveLength(3);
    expect(v.clips.map((c: { pinMirror: string[]; inputs: Record<string, unknown> }) => [c.pinMirror, c.inputs.start])).toEqual([[["start"], asset], [["start"], asset], [["start"], asset]]);
  });
});
