import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recipeById } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { compose } from "../src/entities";
import { newAssetRow } from "../src/media";
import { makeApp, type TestApp } from "./helpers";

/**
 * Krea 2's person reference takes the cast as the other forms' references do (card #219): a cast person's picture fills it,
 * no picture of a place or a style reference.
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

async function entity(kind: "person" | "place", name: string, pictures: string[], sentence = "zz-test"): Promise<string> {
  const id = newId();
  await t.db.insertInto("entities").values({ id, owner_id: OWNER, kind, name, def: JSON.stringify({ pictures, sentence }), created_at: now(), updated_at: now() }).execute();
  return id;
}

describe("Krea 2's person reference, from the cast", () => {
  it("is the cast person's first picture, a place's never, and their face is not described in words", async () => {
    const face = await picture("face.png");
    const person = await entity("person", "zz-test Mara", [face, await picture("side.png")], "a woman with short red hair");
    const place = await entity("place", "zz-test room", [await picture("room.png")]);
    const { input, added } = await compose(t.db, recipeById("krea2.text-to-picture")!, { prompt: "zz-test on a terrace" }, { cast: [{ id: person }, { id: place }], snippets: [] });
    expect(input.person).toEqual([{ asset: face, role: "person" }]);
    expect(input.references).toBeUndefined();
    expect(added.skipped).toEqual(["1 reference picture did not fit: this model takes 1"]);
    // the picture says who they are: their look is not told again in words, their place is
    expect(String(input.prompt)).not.toContain("short red hair");
  });

  it("leaves the user's own picture of the person as it is", async () => {
    const own = await picture("own.png");
    const person = await entity("person", "zz-test Mara", [await picture("face.png")]);
    const { input } = await compose(t.db, recipeById("krea2.text-to-picture")!, { prompt: "zz-test", person: [{ asset: own, role: "person" }] }, { cast: [{ id: person }], snippets: [] });
    expect(input.person).toEqual([{ asset: own, role: "person" }]);
  });
});
