import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";
import { IDLE_DRAFT_MS } from "../src/drafts";

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
  const render = async (draft?: string) => {
    await post(t.app, "/api/jobs", { ...job(), ...(draft ? { draft } : {}) });
    await until(() => fake.prompts.size === 1);
    finish([...fake.prompts.keys()][0]!);
    await until(async () => (await get(t.app, "/api/assets")).json().items.length === 1);
    return (await get(t.app, "/api/assets")).json().items[0] as { id: string; bytes: number };
  };

  it("give each draft in the list its newest output and their count; unused drafts are counted and cleared, never the open one", async () => {
    const made = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "a harbor walk" } } })).json();
    const a = await render(made.id);
    // written once, then its prompt rubbed out, nothing made: unused (the open one is kept when clearing)
    const emptied = async (steps: number) => {
      const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "for now" } } })).json();
      await put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: { steps } } });
      return d;
    };
    const bare = await emptied(30);
    const open = await emptied(20);
    const named = await emptied(20);
    await put(`/api/drafts/${named.id}`, { name: "Kept by its name" });

    const list = (await get(t.app, "/api/drafts")).json();
    const byId = new Map(list.items.map((d: { id: string }) => [d.id, d]));
    expect(byId.get(made.id)).toMatchObject({ cover: a.id, coverKind: "image", outputs: 1, bytes: a.bytes, unused: false });
    expect(byId.get(bare.id)).toMatchObject({ cover: null, outputs: 0, bytes: 0, unused: true });
    expect(byId.get(named.id)).toMatchObject({ unused: false });
    expect(list.unused).toBe(2);
    // a limit reads more than the recent ones (the projects panel), never past 1000
    expect((await get(t.app, "/api/drafts?limit=2")).json().items).toHaveLength(2);
    expect((await get(t.app, "/api/drafts?limit=5000")).statusCode).toBe(400);

    expect((await post(t.app, "/api/drafts/clear-unused", { keep: open.id })).json()).toEqual({ deleted: 1 });
    const left = (await get(t.app, "/api/drafts")).json().items.map((d: { id: string }) => d.id);
    expect(left).not.toContain(bare.id);
    expect(left).toEqual(expect.arrayContaining([made.id, open.id, named.id]));
  });

  it("clears the unused drafts of one project, or of the Inbox, and no other", async () => {
    const p = (await post(t.app, "/api/projects", { name: "Elsewhere" })).json();
    const emptied = async (project?: string) => {
      const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "for now" } }, project })).json();
      await put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: {} } });
      return d;
    };
    const inProject = await emptied(p.id);
    const inInbox = await emptied();
    expect((await post(t.app, "/api/drafts/clear-unused", { project: "none" })).json()).toEqual({ deleted: 1 });
    const left = (await get(t.app, "/api/drafts")).json().items.map((d: { id: string }) => d.id);
    expect(left).toContain(inProject.id);
    expect(left).not.toContain(inInbox.id);
    expect((await post(t.app, "/api/drafts/clear-unused", { project: p.id })).json()).toEqual({ deleted: 1 });
  });

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

describe("drafts emptied, left alone", () => {
  it("are thrown away by the server once they are old, never while just opened (in another tab, on another device), never when something was made from them", async () => {
    const emptied = async () => {
      const d = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "for now" } } })).json();
      await put(`/api/drafts/${d.id}`, { forms: { [RECIPE]: { steps: 30 } } });
      return d;
    };
    const fresh = await emptied();
    const old = await emptied();
    const worked = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "kept" } } })).json();
    const long = new Date(Date.now() - IDLE_DRAFT_MS - 60_000).toISOString();
    await t.db.updateTable("drafts").set({ updated_at: long }).where("id", "in", [old.id, worked.id]).execute();
    const ids = (await get(t.app, "/api/drafts")).json().items.map((d: { id: string }) => d.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(worked.id);
    expect(ids).not.toContain(old.id);
    expect((await get(t.app, `/api/drafts/${old.id}`)).statusCode).toBe(404);
    // a save to one that went answers 404: the page makes it again with what it holds
    expect((await put(`/api/drafts/${old.id}`, { count: 2 })).statusCode).toBe(404);
  });
});

describe("a draft that holds nothing yet", () => {
  it("is not written: never listed or counted, until something worth keeping is put in it; settings alone are not", async () => {
    const made = (await post(t.app, "/api/drafts", { recipe: RECIPE })).json();
    const listed = async () => (await get(t.app, "/api/drafts")).json().items.find((d: { id: string }) => d.id === made.id);
    const save = (payload: unknown) => put(`/api/drafts/${made.id}`, payload);
    // the page can still open it and save into it, by its id
    expect((await get(t.app, `/api/drafts/${made.id}`)).json()).toMatchObject({ id: made.id, title: "" });
    expect(await listed()).toBeUndefined();
    expect((await save({ forms: { [RECIPE]: { steps: 30, size: { width: 1024, height: 1024 } } } })).json()).toMatchObject({ forms: { [RECIPE]: { steps: 30 } } });
    expect(await listed()).toBeUndefined();
    expect(await t.db.selectFrom("drafts").select("id").where("id", "=", made.id).executeTakeFirst()).toBeUndefined();
    // something written: it is written, under the same id, with what it held
    await save({ forms: { [RECIPE]: { steps: 30, prompt: "a lighthouse in a storm" } } });
    expect(await listed()).toMatchObject({ title: "a lighthouse in a storm" });
    expect((await get(t.app, `/api/drafts/${made.id}`)).json().forms[RECIPE]).toMatchObject({ steps: 30 });
  });

  it("is written by a name, someone from the kit, or a render sent from it; deleted, it is gone", async () => {
    const blank = async () => (await post(t.app, "/api/drafts", { recipe: RECIPE })).json() as { id: string };
    const written = async (id: string) => Boolean(await t.db.selectFrom("drafts").select("id").where("id", "=", id).executeTakeFirst());
    const named = await blank();
    await put(`/api/drafts/${named.id}`, { name: "For later" });
    expect(await written(named.id)).toBe(true);
    const person = (await post(t.app, "/api/entities", { kind: "person", name: "Mara" })).json();
    const cast = await blank();
    await put(`/api/drafts/${cast.id}`, { look: { cast: [{ id: person.id }], snippets: [] } });
    expect(await written(cast.id)).toBe(true);
    const sent = await blank();
    expect((await post(t.app, "/api/jobs", { ...job({ prompt: "sent at once" }), draft: sent.id })).statusCode).toBe(200);
    expect(await written(sent.id)).toBe(true);
    const left = await blank();
    expect((await t.app.inject({ method: "DELETE", url: `/api/drafts/${left.id}` })).statusCode).toBe(200);
    expect((await get(t.app, `/api/drafts/${left.id}`)).statusCode).toBe(404);
  });

  it("never takes back someone or something deleted from the kit: a tab's save drops them, and they hold nothing", async () => {
    const blank = async () => (await post(t.app, "/api/drafts", { recipe: RECIPE })).json() as { id: string };
    const written = async (id: string) => Boolean(await t.db.selectFrom("drafts").select("id").where("id", "=", id).executeTakeFirst());
    const gone = (id: string) => t.app.inject({ method: "DELETE", url: `/api/entities/${id}` });
    const mara = (await post(t.app, "/api/entities", { kind: "person", name: "Mara" })).json();
    const film = (await post(t.app, "/api/entities", { kind: "style", name: "Film" })).json();
    const note = (await post(t.app, "/api/entities", { kind: "snippet", name: "Rain", def: { text: "in the rain" } })).json();
    // the open draft's tab still holds all three after they are deleted, and saves them back
    const open = (await post(t.app, "/api/drafts", { recipe: RECIPE, forms: { [RECIPE]: { prompt: "a street" } } })).json();
    for (const e of [mara, film, note]) expect((await gone(e.id)).statusCode).toBe(200);
    const ghost = { cast: [{ id: mara.id }], style: film.id, snippets: [note.id] };
    expect((await put(`/api/drafts/${open.id}`, { look: ghost })).json().look).toEqual({ cast: [], style: null, snippets: [] });
    expect((await get(t.app, `/api/drafts/${open.id}`)).json().look).toEqual({ cast: [], style: null, snippets: [] });
    // a ghost alone is nothing worth keeping: a blank draft stays unwritten, and is listed as empty
    const blankOne = await blank();
    await put(`/api/drafts/${blankOne.id}`, { look: ghost });
    expect(await written(blankOne.id)).toBe(false);
    // a blank draft with someone picked, not written yet, loses them when they are deleted
    const unwritten = await blank();
    expect(await written(unwritten.id)).toBe(false);
    const ines = (await post(t.app, "/api/entities", { kind: "person", name: "Ines" })).json();
    const { unwrittenOf } = await import("../src/unwrittenDrafts");
    const row = unwrittenOf(t.db).get(unwritten.id)!;
    row.look = JSON.stringify({ cast: [{ id: ines.id }], snippets: [] });
    expect((await gone(ines.id)).statusCode).toBe(200);
    expect((await get(t.app, `/api/drafts/${unwritten.id}`)).json().look).toEqual({ cast: [], snippets: [] });
  });
});
