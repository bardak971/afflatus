import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, OWNER } from "../src/db";
import { get, makeApp, post, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const RECIPE = "sdxl.text-to-picture";
const del = (url: string) => t.app.inject({ method: "DELETE", url });

/** A picture in the library. */
async function picture(): Promise<string> {
  const id = newId();
  const key = `assets/${id}.png`;
  await t.services.storage.put(key, new Uint8Array([1]));
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind: "image", origin: "generated", name: "", file_key: key, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1, duration_ms: null,
    fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
  }).execute();
  return id;
}

describe("a picture a draft still uses, on its way to the bin", () => {
  it("names the drafts that use it, with which items, and only those", async () => {
    const [a, b, free] = [await picture(), await picture(), await picture()];
    const one = (await post(t.app, "/api/drafts", { recipe: RECIPE, name: "zz-test one", forms: { [RECIPE]: { prompt: "a cat", image: a } } })).json();
    const two = (await post(t.app, "/api/drafts", { recipe: RECIPE, name: "zz-test two", forms: { other: { refs: [{ asset: a, role: "face" }, { asset: b, role: "style" }] } } })).json();
    const using = (await post(t.app, "/api/drafts/using", { ids: [a, b, free] })).json().drafts as Array<{ id: string; name: string; assets: string[] }>;
    expect(using.map((d) => [d.name, d.assets.sort()])).toEqual(expect.arrayContaining([["zz-test one", [a]], ["zz-test two", [a, b].sort()]]));
    expect(using).toHaveLength(2);
    expect(using.map((d) => d.id).sort()).toEqual([one.id, two.id].sort());
    expect((await post(t.app, "/api/drafts/using", { ids: [free] })).json().drafts).toEqual([]);
  });

  it("is refused by the bin, then taken out of the drafts (the fields follow their default, the rest stays) and binned", async () => {
    const [a, b] = [await picture(), await picture()];
    const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "a cat", image: a, clip: { asset: a, at: 1200 }, refs: [{ asset: a, role: "face" }, { asset: b, role: "style" }] } } })).json();
    expect((await del(`/api/assets/${a}`)).statusCode).toBe(409);
    expect((await post(t.app, "/api/drafts/release", { ids: [a] })).json()).toEqual({ changed: 1 });
    expect((await get(t.app, `/api/drafts/${d.id}`)).json().forms[RECIPE]).toEqual({ prompt: "a cat", refs: [{ asset: b, role: "style" }] });
    expect((await del(`/api/assets/${a}`)).statusCode).toBe(200);
    // the other picture is still in the draft: still refused
    expect((await del(`/api/assets/${b}`)).statusCode).toBe(409);
  });

  it("is not pinned by a draft's target: none is taken, and an old row's 'asset:' one still loads and pins nothing", async () => {
    const a = await picture();
    // the old Edit-draft flow's field is refused, never stored
    expect((await post(t.app, "/api/drafts", { recipe: RECIPE, target: `asset:${a}`, forms: { [RECIPE]: { prompt: "a cat" } } })).statusCode).toBe(400);
    // a row saved by that flow before: it opens as it was, and the picture it once edited is free
    const at = new Date().toISOString();
    const old = newId();
    await t.db.insertInto("drafts").values({ id: old, owner_id: OWNER, project_id: null, target: `asset:${a}`, recipe_id: RECIPE, title: "a cat", name: "zz-test old edit", forms: JSON.stringify({ [RECIPE]: { prompt: "a cat" } }), count: 1, chat: null, look: null, created_at: at, updated_at: at } as never).execute();
    expect((await get(t.app, `/api/drafts/${old}`)).json()).toMatchObject({ id: old, name: "zz-test old edit", forms: { [RECIPE]: { prompt: "a cat" } } });
    expect((await post(t.app, "/api/drafts/using", { ids: [a] })).json().drafts).toEqual([]);
    expect((await del(`/api/assets/${a}`)).statusCode).toBe(200);
    expect((await t.db.selectFrom("drafts").select("target").where("id", "=", old).executeTakeFirstOrThrow()).target).toBe(`asset:${a}`);
  });

  it("goes to the bin once the draft is deleted; the bulk bin says how many it left", async () => {
    const [a, b] = [await picture(), await picture()];
    const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "a cat", image: a } } })).json();
    expect((await post(t.app, "/api/assets/bulk", { ids: [a, b], action: "bin" })).json()).toMatchObject({ changed: 1, inUse: 1 });
    await del(`/api/drafts/${d.id}`);
    expect((await post(t.app, "/api/assets/bulk", { ids: [a], action: "bin" })).json()).toMatchObject({ changed: 1 });
  });
});
