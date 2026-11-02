import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, now, OWNER } from "../src/db";
import { personPictures, sameFace } from "../src/faceCarried";
import { newAssetRow } from "../src/media";
import type { ClipRow } from "../src/timelineModel";
import { makeApp, type TestApp } from "./helpers";

/**
 * Card #223: an H3 continuation with the person pictures of the take before it carries the face on (faceCarried, Face refine
 * on); a first clip, or one whose person pictures changed, is sampled with them. Clips, takes and renders put in the database
 * by hand; nothing is rendered or measured (a quick plan).
 */

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const person = (...assets: string[]) => assets.map((asset) => ({ asset, role: "person" }));

async function clip(timeline: string, position: number, over: Partial<ClipRow> = {}): Promise<string> {
  const id = newId();
  const at = now();
  await t.db.insertInto("clips").values({
    id, timeline_id: timeline, position, take_id: null, joined: "continue", recipe_id: "h3.video", inputs: "{}", kind: "video", still_asset_id: null, still_ms: 3000,
    sound: "own", sound_asset_id: null, volume: 100, fill: 0, look: null, chat: null, created_at: at, updated_at: at, ...over,
  }).execute();
  return id;
}

/** A take of `clipId` rendered from `inputs` (the cast worked in), by `recipe`. */
async function take(clipId: string, inputs: Record<string, unknown>, recipe = "h3.video"): Promise<string> {
  const generation = newId();
  await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: recipe, recipe_version: 1, family: "h3", inputs: JSON.stringify(inputs), resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() }).execute();
  const id = newId();
  const row = newAssetRow({
    id, kind: "video", origin: "generated", name: "v.mp4", file_key: `assets/${id.slice(0, 2)}/${id}.mp4`, thumb_key: null, mime: "video/mp4", bytes: 1000,
    width: 576, height: 1024, duration_ms: 5000, fps: 24, has_sound: 1, folder_id: null, generation_id: generation, source_id: null, kept_at: now(),
  });
  await t.db.insertInto("assets").values(row).execute();
  const asset = await t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  return t.services.timelines.takes.add(clipId, asset, { headMs: 0, tailMs: 0 }, {});
}

const planned = async (clipId: string, input: Record<string, unknown>, finishedFrom: string | null = null) =>
  (await t.services.timelines.plan(clipId, t.services.registry.recipe("h3.video")!, { description: "zz-test", ...input }, false, finishedFrom, true)).input;

describe("an H3 continuation with the person pictures of the take before it", () => {
  it("carries the face on, with Face refine; a first clip, a changed picture and the clip after a change are sampled with theirs", async () => {
    const tl = (await t.services.timelines.create("zz-test face carried")).id;
    const ids = [await clip(tl, 0, { joined: "cut" }), await clip(tl, 1), await clip(tl, 2), await clip(tl, 3)];
    await take(ids[0]!, { references: person("p1") });
    await take(ids[1]!, { references: person("p1") });
    // clip 3's picture changed to p2 (another picture of the person), clip 4 keeps p2
    await take(ids[2]!, { references: person("p2") });
    const first = await planned(ids[0]!, { references: person("p1"), faceCarried: true });
    expect(first.faceCarried).toBe(false);
    expect(first.faceRefine).toBe(undefined);
    expect(await planned(ids[1]!, { references: person("p1") })).toMatchObject({ faceCarried: true, faceRefine: true });
    // its form says p2 where the take before was made with p1: a new look, sampled with it
    const changed = await planned(ids[2]!, { references: person("p2"), faceRefine: false });
    expect(changed).toMatchObject({ faceCarried: false, faceRefine: false });
    expect(await planned(ids[3]!, { references: person("p2") })).toMatchObject({ faceCarried: true, faceRefine: true });
  });

  it("is a plain continuation with Hold the face on continuations off: sampled without the pictures, Face refine as the form has it", async () => {
    // card #225: the pass costs time on every continuation; off, the timeline no longer turns Face refine on for it
    const tl = (await t.services.timelines.create("zz-test face not held")).id;
    const [a, b] = [await clip(tl, 0, { joined: "cut" }), await clip(tl, 1)];
    await take(a, { references: person("p1") });
    const off = await planned(b, { references: person("p1"), holdFace: false });
    expect(off).toMatchObject({ faceCarried: true, holdFace: false });
    expect(off.faceRefine).toBeUndefined();
    expect(await planned(b, { references: person("p1"), holdFace: false, faceRefine: true })).toMatchObject({ faceCarried: true, faceRefine: true });
    // a form saved before the toggle holds it
    expect(await planned(b, { references: person("p1") })).toMatchObject({ faceCarried: true, faceRefine: true });
  });

  it("is not carried after a hard cut, a take rendered nowhere here, or with no person picture", async () => {
    const tl = (await t.services.timelines.create("zz-test face carried cut")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1, { joined: "cut" });
    await take(a, { references: person("p1") });
    expect((await planned(b, { references: person("p1") })).faceCarried).toBe(false);
    const c = await clip(tl, 2);
    await take(b, { references: [{ asset: "pl", role: "place" }] });
    expect((await planned(c, { references: [{ asset: "pl", role: "place" }] })).faceCarried).toBe(false);
  });

  it("reads a clip before still to come off the job it was sent, and keeps a finish's draft's word", async () => {
    const tl = (await t.services.timelines.create("zz-test face carried coming")).id;
    const a = await clip(tl, 0, { joined: "cut" });
    const b = await clip(tl, 1);
    await t.db.insertInto("jobs").values({ id: newId(), owner_id: OWNER, recipe_id: "h3.video", label: "zz-test", inputs: JSON.stringify({ description: "a", references: person("p1") }), clip_id: a, status: "queued", priority: 0, created_at: now(), updated_at: now() } as never).execute();
    expect(await planned(b, { references: person("p1") })).toMatchObject({ faceCarried: true, faceRefine: true });
    // a finish re-samples its draft as it was made: the draft's word kept, whatever the clip before is now
    expect((await planned(b, { references: person("p9"), faceCarried: true }, "draft-take")).faceCarried).toBe(true);
  });

  it("compares the person pictures alone, in any order, across forms", () => {
    const video = t.services.registry.recipe("h3.video")!;
    const lip = t.services.registry.recipe("h3.lipsync")!;
    expect(personPictures(video, { references: [...person("b", "a", "a"), { asset: "c", role: "clothing" }] })).toEqual(["a", "b"]);
    expect(sameFace(lip, { references: person("a", "b") }, video, { references: [...person("b", "a"), { asset: "pl", role: "place" }] })).toBe(true);
    expect(sameFace(video, { references: person("a") }, video, { references: person("a", "b") })).toBe(false);
    expect(sameFace(video, { references: [] }, video, { references: [] })).toBe(false);
  });
});

describe("what each H3 clip does with its person's picture, as the editor says it", () => {
  it("reads the forms in order: carried on, a new look where the picture changed, and gives a changed one to the clips after it", async () => {
    const tl = (await t.services.timelines.create("zz-test face routes")).id;
    const form = (refs: Array<{ asset: string; role: string }>) => JSON.stringify({ description: "zz-test", references: refs });
    const look = JSON.stringify({ cast: [], style: null, snippets: [] });
    const ids = [
      await clip(tl, 0, { joined: "cut", inputs: form(person("p1")) }),
      await clip(tl, 1, { inputs: form(person("p1")) }),
      // the picture changed here (its own cast, as "Change for this clip" makes)
      await clip(tl, 2, { inputs: form([{ asset: "pl", role: "place" }, ...person("p2")]), look }),
      await clip(tl, 3, { inputs: form([{ asset: "pl", role: "place" }, ...person("p1")]) }),
      await clip(tl, 4, { inputs: form(person("p1")) }),
      await clip(tl, 5, { joined: "cut", inputs: form(person("p1")) }),
      await clip(tl, 6, { inputs: form([]) }),
    ];
    const routes = await t.services.timelines.face.routes(tl);
    expect(routes[ids[0]!]).toEqual({ route: "sampled", why: "first" });
    expect(routes[ids[1]!]).toEqual({ route: "carried", before: 1 });
    expect(routes[ids[2]!]).toEqual({ route: "sampled", why: "changed", before: 2, keepOld: { from: 4, to: 5 } });
    expect(routes[ids[3]!]).toEqual({ route: "sampled", why: "changed", before: 3 });
    expect(routes[ids[5]!]).toEqual({ route: "sampled", why: "first" });
    expect(routes[ids[6]!]).toBeUndefined();
    // a carried clip whose form has Hold the face on continuations off says so (card #225)
    await t.db.updateTable("clips").set({ inputs: JSON.stringify({ description: "zz-test", references: person("p1"), holdFace: false }) }).where("id", "=", ids[1]!).execute();
    expect((await t.services.timelines.face.routes(tl))[ids[1]!]).toEqual({ route: "carried", before: 1, held: false });
    await t.db.updateTable("clips").set({ inputs: form(person("p1")) }).where("id", "=", ids[1]!).execute();

    expect(await t.services.timelines.face.spread(ids[2]!)).toEqual({ from: 4, to: 5 });
    const after = await t.services.timelines.face.routes(tl);
    expect(after[ids[2]!]).toEqual({ route: "sampled", why: "changed", before: 2 });
    expect(after[ids[3]!]).toEqual({ route: "carried", before: 3 });
    expect(after[ids[4]!]).toEqual({ route: "carried", before: 4 });
    const rows = await t.db.selectFrom("clips").select(["id", "inputs", "look"]).where("id", "in", [ids[3]!, ids[4]!]).execute();
    const four = rows.find((r) => r.id === ids[3])!;
    // its own other pictures kept, the person's replaced, the cast of the clip it was given from
    expect(JSON.parse(four.inputs).references).toEqual([{ asset: "pl", role: "place" }, ...person("p2")]);
    expect(four.look).toBe(look);
    // one step for Undo puts them back
    await t.services.timelines.history.undo(tl);
    expect((await t.services.timelines.face.routes(tl))[ids[2]!]?.keepOld).toEqual({ from: 4, to: 5 });
    await expect(t.services.timelines.face.spread(ids[1]!)).rejects.toThrow(/No clip after this one/);
  });
});
