import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recipeById } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { compose, withMentions } from "../src/entities";
import { newAssetRow } from "../src/media";
import { makeApp, type TestApp } from "./helpers";

/**
 * "@Nicolas" in a prompt part (the rethink's prompt parts, card #34): the Prompt kit person of that name cast for the
 * render, their pictures sent as references, and said in the text by how they look (a name means nothing to H3).
 */
let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function person(name: string, sentence: string) {
  const id = newId();
  const picture = newId();
  await t.db.insertInto("assets").values(newAssetRow({ id: picture, kind: "image", origin: "uploaded", name: `${name}.png`, file_key: `assets/zz/${picture}`, thumb_key: null, mime: "image/png", bytes: 1, width: 512, height: 512, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now() })).execute();
  await t.db.insertInto("entities").values({ id, owner_id: OWNER, kind: "person", name, def: JSON.stringify({ pictures: [picture], sentence }), created_at: now(), updated_at: now() }).execute();
  return { id, picture };
}

describe("a Prompt kit person named in a part", () => {
  it("is cast for the render and said by how they look", async () => {
    const { id: nicolas, picture } = await person("Nicolas D", "a man with short dark hair and a light beard.");
    const swap = recipeById("h3.swap")!;
    const { input, look } = await withMentions(t.db, swap, { look: "a black leather jacket", happens: "@nicolas_d dances", inSource: "the man in the hoodie" }, null);
    expect(input.happens).toBe("the person (a man with short dark hair and a light beard) dances");
    expect(input.inSource).toBe("the man in the hoodie");
    expect(look?.cast.map((c) => c.id)).toEqual([nicolas]);
    // composed: their picture goes in as a reference, as a cast person's does
    const composed = await compose(t.db, swap, { happens: "@Nicolas_D waves", references: [] }, null);
    expect((composed.input.references as Array<{ asset: string }>).map((r) => r.asset)).toContain(picture);
  });

  it("leaves a name that is no one's as it was typed, and a form without one as it was", async () => {
    const swap = recipeById("h3.swap")!;
    const { input, look } = await withMentions(t.db, swap, { happens: "@nobody waves" }, null);
    expect(input.happens).toBe("@nobody waves");
    expect(look).toBeNull();
    const plain = { happens: "he waves" };
    expect((await withMentions(t.db, swap, plain, null)).input).toBe(plain);
  });
});
