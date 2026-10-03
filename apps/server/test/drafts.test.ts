import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const put = (url: string, payload: unknown) => t.app.inject({ method: "PUT", url, payload: payload as object });
const RECIPE = "sdxl.text-to-picture";

describe("a draft's name", () => {
  it("can be given, stays when the draft is saved again, and goes back to what is written when emptied", async () => {
    const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "a quiet harbour at dawn" } } })).json();
    expect(d).toMatchObject({ name: null, title: "a quiet harbour at dawn" });
    expect((await put(`/api/drafts/${d.id}`, { name: "  Harbour, version 2 " })).json()).toMatchObject({ name: "Harbour, version 2", title: "a quiet harbour at dawn" });
    // saving the form (what typing does) leaves the name alone
    expect((await put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: { prompt: "a harbour at dusk" } } })).json()).toMatchObject({ name: "Harbour, version 2", title: "a harbour at dusk" });
    expect((await get(t.app, "/api/drafts")).json().items[0]).toMatchObject({ name: "Harbour, version 2" });
    expect((await put(`/api/drafts/${d.id}`, { name: "" })).json()).toMatchObject({ name: null });
  });
});

describe("drafts", () => {
  it("are created, saved while typing, listed newest first and deleted", async () => {
    const a = (await post(t.app, "/api/drafts", { recipe: RECIPE })).json();
    expect(a).toMatchObject({ recipe: RECIPE, title: "", forms: {}, count: 1, target: "new" });
    const b = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "a quiet harbour at dawn" } }, count: 2 })).json();
    expect(b.title).toBe("a quiet harbour at dawn");

    await new Promise((r) => setTimeout(r, 5));
    const saved = (await put(`/api/drafts/${a.id}`, { forms: { [RECIPE]: { prompt: "  a cat\n on a   roof  ", steps: 40 } } })).json();
    expect(saved).toMatchObject({ title: "a cat on a roof", forms: { [RECIPE]: { steps: 40 } } });

    const list = (await get(t.app, "/api/drafts")).json().items;
    expect(list.map((d: { id: string }) => d.id)).toEqual([a.id, b.id]);
    expect(list[0].forms).toBeUndefined();

    expect((await t.app.inject({ method: "DELETE", url: `/api/drafts/${b.id}` })).statusCode).toBe(200);
    expect((await get(t.app, `/api/drafts/${b.id}`)).statusCode).toBe(404);
  });

  it("keep the form of each recipe they have been on, and change only what is sent", async () => {
    const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "one" }, "other.recipe": { prompt: "two" } } })).json();
    const after = (await put(`/api/drafts/${d.id}`, { count: 4 })).json();
    expect(after).toMatchObject({ count: 4, recipe: RECIPE, forms: { [RECIPE]: { prompt: "one" }, "other.recipe": { prompt: "two" } } });
    // on a recipe Afflatus does not know (a workflow that was removed), the draft is still there, just untitled
    expect((await put(`/api/drafts/${d.id}`, { recipe: "other.recipe" })).json()).toMatchObject({ recipe: "other.recipe", title: "" });
  });

  it("accept a half-written form: a draft is not checked against its recipe", async () => {
    const res = await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { steps: 9999, whatever: true } } });
    expect(res.statusCode).toBe(200);
  });

  it("survive a restart", async () => {
    const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "still here" } } })).json();
    const again = await makeApp({ db: t.db, dir: t.dir });
    expect((await get(again.app, `/api/drafts/${d.id}`)).json().forms[RECIPE].prompt).toBe("still here");
    await again.app.close();
  });

  it("refuse a draft that is absurdly large, and unknown fields", async () => {
    const d = (await post(t.app, "/api/drafts", { recipe: RECIPE })).json();
    expect((await put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: { prompt: "x".repeat(300_000) } } })).statusCode).toBe(413);
    expect((await put(`/api/drafts/${d.id}`, { nope: 1 })).statusCode).toBe(400);
  });
});

describe("thumbnails", () => {
  let fake: FakeComfy;
  beforeEach(async () => {
    await t.close();
    fake = await makeFake();
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
  });
  afterEach(() => fake.close());

  /** Finish a prompt with a real picture (the usual test helper sends only a PNG header). */
  const finish = (promptId: string) => {
    const out = Object.entries(fake.prompts.get(promptId)!).find(([, n]) => n.class_type === "PreviewImage")![0];
    fake.files[`${promptId}.png`] = makePng(832, 1216, [120, 60, 40], [40, 80, 120]);
    fake.pending = [];
    fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { images: [{ filename: `${promptId}.png`, subfolder: "", type: "temp" }] } } };
  };
  const render = async () => {
    await post(t.app, "/api/jobs", job());
    await until(() => fake.prompts.size === 1);
    finish([...fake.prompts.keys()][0]!);
    await until(async () => (await get(t.app, "/api/assets")).json().items.length === 1);
    return (await get(t.app, "/api/assets")).json().items[0] as { id: string; bytes: number };
  };

  it("are made when a picture is stored, small and in WebP", async () => {
    const a = await render();
    const row = await t.db.selectFrom("assets").select("thumb_key").where("id", "=", a.id).executeTakeFirstOrThrow();
    expect(row.thumb_key).toMatch(/^thumbs\/.+\.webp$/);
    const thumb = await get(t.app, `/api/assets/${a.id}/thumb`);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(thumb.rawPayload.length).toBeLessThan(a.bytes);
    // the stored picture is untouched
    expect((await get(t.app, `/api/assets/${a.id}/file`)).rawPayload.length).toBe(a.bytes);
  });

  it("are made on first request for a picture that has none", async () => {
    const a = await render();
    await t.db.updateTable("assets").set({ thumb_key: null }).where("id", "=", a.id).execute();
    expect((await get(t.app, `/api/assets/${a.id}/thumb`)).headers["content-type"]).toBe("image/webp");
    expect((await t.db.selectFrom("assets").select("thumb_key").where("id", "=", a.id).executeTakeFirstOrThrow()).thumb_key).not.toBeNull();
  });

  it("fall back to the picture itself when one cannot be made", async () => {
    const id = "damaged";
    await t.services.storage.put("assets/damaged.png", new Uint8Array([1, 2, 3]));
    await t.db
      .insertInto("assets")
      .values({
        id, owner_id: "local", kind: "image", origin: "uploaded", name: "", file_key: "assets/damaged.png", thumb_key: null, mime: "image/png",
        bytes: 3, width: null, height: null, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
        kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
      })
      .execute();
    const res = await get(t.app, `/api/assets/${id}/thumb`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect([...res.rawPayload]).toEqual([1, 2, 3]);
  });
});

describe("a draft nothing was done in", () => {
  it("says so in the list, until something is set, someone is in it, or it is named", async () => {
    const t = await makeApp();
    try {
      const made = (await post(t.app, "/api/drafts", { recipe: "sdxl.text-to-picture" })).json();
      const listed = async () => (await get(t.app, "/api/drafts")).json().items.find((d: { id: string }) => d.id === made.id);
      const put = (payload: unknown) => t.app.inject({ method: "PUT", url: `/api/drafts/${made.id}`, payload: payload as object });
      expect((await listed()).empty).toBe(true);
      await put({ forms: { "sdxl.text-to-picture": {} } });
      expect((await listed()).empty).toBe(true);
      await put({ forms: { "sdxl.text-to-picture": { steps: 30 } } });
      expect((await listed()).empty).toBe(false);
      await put({ forms: { "sdxl.text-to-picture": {} }, name: "Kept for later" });
      expect((await listed()).empty).toBe(false);
    } finally {
      await t.close();
    }
  });
});
