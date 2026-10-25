import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recipeById } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { compose } from "../src/entities";
import { newAssetRow } from "../src/media";
import { makeApp, type TestApp } from "./helpers";

/**
 * The face of an LTX 2.3 or Wan take is scored against the cast person's picture (card #84): those models take no reference
 * pictures, so the cast fills an internal input the render reads only for the score.
 */
let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function picture(name: string): Promise<string> {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({ id, kind: "image", origin: "uploaded", name, file_key: `assets/zz/${id}`, thumb_key: null, mime: "image/png", bytes: 1, width: 512, height: 512, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now() })).execute();
  return id;
}

async function entity(kind: "person" | "place", name: string, pictures: string[]): Promise<string> {
  const id = newId();
  await t.db.insertInto("entities").values({ id, owner_id: OWNER, kind, name, def: JSON.stringify({ pictures, sentence: "zz-test" }), created_at: now(), updated_at: now() }).execute();
  return id;
}

describe("the cast's picture for the face score", () => {
  it("is the first cast person's first picture, on LTX 2.3 and Wan, a place's never", async () => {
    const place = await entity("place", "zz-test room", [await picture("room.png")]);
    const face = await picture("face.png");
    const person = await entity("person", "zz-test someone", [face, await picture("side.png")]);
    for (const id of ["ltx.video", "wan.video"]) {
      const { input } = await compose(t.db, recipeById(id)!, { prompt: "zz-test" }, { cast: [{ id: place }, { id: person }], snippets: [] });
      expect(input.facePhoto).toBe(face);
    }
    // LTX 2.5 takes the cast as reference pictures: no input of its own for it
    const { input } = await compose(t.db, recipeById("ltx25.video")!, { prompt: "zz-test" }, { cast: [{ id: person }], snippets: [] });
    expect(input.facePhoto).toBeUndefined();
  });

  it("is this render's cast alone: one carried over in a copied form is dropped", async () => {
    const stale = await picture("someone-else.png");
    const place = await entity("place", "zz-test room", [await picture("room.png")]);
    expect((await compose(t.db, recipeById("wan.video")!, { prompt: "zz-test", facePhoto: stale }, null)).input.facePhoto).toBeUndefined();
    expect((await compose(t.db, recipeById("wan.video")!, { prompt: "zz-test", facePhoto: stale }, { cast: [{ id: place }], snippets: [] })).input.facePhoto).toBeUndefined();
  });

  // card #81, from #85's series: LTX 2.3 said nothing of the cast's pictures it does not use
  it("is said in words: the cast's pictures are not used by LTX 2.3 or Wan, LTX 2.5 named as the one that takes them", async () => {
    const person = await entity("person", "zz-test Mara", [await picture("face.png")]);
    const place = await entity("place", "zz-test room", [await picture("room.png")]);
    const skipped = async (id: string, cast: string[]) => (await compose(t.db, recipeById(id)!, { prompt: "zz-test" }, { cast: cast.map((c) => ({ id: c })), snippets: [] })).added.skipped;
    expect(await skipped("ltx.video", [person])).toEqual(["zz-test Mara's pictures aren't used: LTX 2.3 takes no reference pictures (LTX 2.5 does)"]);
    expect(await skipped("wan.video", [person, place])).toEqual(["The pictures of zz-test Mara and zz-test room aren't used: Wan 2.2 takes no reference pictures"]);
    // LTX 2.5 takes them; a person with no picture has none to leave out
    expect(await skipped("ltx25.video", [person])).toEqual([]);
    expect(await skipped("ltx.video", [await entity("person", "zz-test nobody", [])])).toEqual([]);
  });

  it("is left out when the person's picture is in the bin", async () => {
    const face = await picture("face.png");
    await t.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", face).execute();
    const person = await entity("person", "zz-test someone", [face]);
    expect((await compose(t.db, recipeById("ltx.video")!, { prompt: "zz-test" }, { cast: [{ id: person }], snippets: [] })).input.facePhoto).toBeUndefined();
  });
});
