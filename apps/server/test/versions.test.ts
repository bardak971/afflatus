import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import { TOOLS } from "../src/mcpTools";
import { sweep, UNKEPT_MS } from "../src/sweep";
import { CHECKPOINT, complete, get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Versions of a picture (versions.ts, card #274): what a job sent with `versionOf` makes is filed under the stack's root,
 * out of the library and its listings (MCP's too); Keep puts a version in the head's place and sets the rest counting down;
 * the sweep bins what a Keep set aside, an uploaded original too, but never what something uses.
 */

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], upscale_models: [] } });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const row = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const upload = async (name: string, folder?: string) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}${folder ? `&folder=${folder}` : ""}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json() as { id: string };
/** A job sent (with `versionOf` when given), and its id. */
const send = async (versionOf?: string, draft?: string) => {
  const before = fake.prompts.size;
  const res = await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "zz-test a lamp", checkpoint: CHECKPOINT }, ...(versionOf ? { versionOf } : {}), ...(draft ? { draft } : {}) });
  expect(res.statusCode, res.body).toBe(200);
  await until(() => fake.prompts.size === before + 1);
  return { job: res.json().ids[0] as string, prompt: [...fake.prompts.keys()].at(-1)! };
};
/** A sent job finished, and the item it made. */
const finish = async (sent: { job: string; prompt: string }) => {
  complete(fake, sent.prompt);
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", sent.job).executeTakeFirstOrThrow()).status === "done");
  const job = await t.db.selectFrom("jobs").select("generation_id").where("id", "=", sent.job).executeTakeFirstOrThrow();
  return t.db.selectFrom("assets").selectAll().where("generation_id", "=", job.generation_id!).executeTakeFirstOrThrow();
};
const make = async (versionOf?: string, draft?: string) => finish(await send(versionOf, draft));
const listed = async (query = "") => (await get(t.app, `/api/assets${query}`)).json().items as Array<{ id: string; versions: number; versionOf: string | null }>;
const stack = async (id: string) => (await get(t.app, `/api/assets/${id}/versions`)).json() as { head: { id: string }; versions: Array<{ id: string; versionOf: string }> };

describe("a picture's versions", () => {
  it("are filed under the picture, hidden from the library and its counts, listed oldest first by the head's id or a version's", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    const b = await make(head.id);
    expect(a.version_of).toBe(head.id);
    // the lineage keeps what it was made from; the view says the head
    expect((await stack(head.id)).versions.map((v) => v.id)).toEqual([a.id, b.id]);
    expect((await stack(a.id)).head.id).toBe(head.id);
    expect((await stack(a.id)).versions[0]!.versionOf).toBe(head.id);
    const items = await listed();
    expect(items.map((i) => i.id)).toEqual([head.id]);
    expect(items[0]!.versions).toBe(2);
    expect((await get(t.app, "/api/assets/count")).json().count).toBe(1);
    expect((await get(t.app, "/api/assets/unkept")).json().count).toBe(0);
    // and from outside: MCP's search_library lists the library as the grid does
    const search = TOOLS.find((x) => x.name === "search_library")!;
    const found = (await search.run({}, { s: t.services, said: () => {} } as never)) as { items: Array<{ item: string }> };
    expect(found.items.map((i) => i.item)).toEqual([head.id]);
  });

  it("stay one flat stack: a fix of a version joins the head; a head binned or erased leaves new results plain", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    const b = await make(a.id);
    expect(b.version_of).toBe(head.id);
    // the job says the root too, as the strip matches its running tiles by it
    const sent = await send(a.id);
    expect((await t.db.selectFrom("jobs").select("version_of").where("id", "=", sent.job).executeTakeFirstOrThrow()).version_of).toBe(head.id);
    await finish(sent);
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${head.id}` })).statusCode).toBe(200);
    const plain = await make(head.id);
    expect(plain.version_of).toBeNull();
    // erased, the head lets its versions go as plain items
    await t.db.deleteFrom("assets").where("id", "=", head.id).execute();
    expect((await row(a.id)).version_of).toBeNull();
    expect((await listed()).map((i) => i.id)).toContain(a.id);
  });

  it("binned, a version leaves its stack: it shows in the Bin and comes back a plain picture", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${a.id}` })).statusCode).toBe(200);
    expect((await row(a.id)).version_of).toBeNull();
    expect((await listed("?bin=1")).map((i) => i.id)).toEqual([a.id]);
    await post(t.app, `/api/assets/${a.id}/restore`);
    expect((await listed()).map((i) => i.id).sort()).toEqual([head.id, a.id].sort());
    expect((await stack(head.id)).versions).toEqual([]);
  });
});

describe("Keep", () => {
  it("puts the version in the head's place; the old head and the others count down under it, and go to the bin a day on", async () => {
    const folder = (await post(t.app, "/api/folders", { name: "zz-test shots" })).json().id as string;
    const head = await upload("zz-test terrace", folder);
    const a = await make(head.id);
    const b = await make(head.id);
    const res = await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: b.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().head.id).toBe(b.id);
    expect(res.json().versions.map((v: { id: string }) => v.id).sort()).toEqual([head.id, a.id].sort());
    const kept = await row(b.id);
    expect(kept).toMatchObject({ version_of: null, folder_id: folder, name: "zz-test terrace", countdown_from: null });
    expect(kept.kept_at).not.toBeNull();
    // the uploaded original is a version now, unkept: it counts down as a result does
    const old = await row(head.id);
    expect(old).toMatchObject({ version_of: b.id, kept_at: null });
    expect(old.countdown_from).not.toBeNull();
    expect((await row(a.id)).version_of).toBe(b.id);
    expect((await listed()).map((i) => i.id)).toEqual([b.id]);
    await sweep(t.db, t.services.storage, Date.now() + UNKEPT_MS + 60_000);
    for (const id of [head.id, a.id]) expect(await row(id)).toMatchObject({ version_of: null, deleted_at: expect.any(String) });
    expect((await row(b.id)).deleted_at).toBeNull();
    expect((await listed("?bin=1")).map((i) => i.id).sort()).toEqual([head.id, a.id].sort());
  });

  it("while versions still render: what they make joins the kept one", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    const running = await send(head.id);
    await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: a.id });
    // the job follows the new root, for the strip; and so does what it makes
    expect((await t.db.selectFrom("jobs").select("version_of").where("id", "=", running.job).executeTakeFirstOrThrow()).version_of).toBe(a.id);
    expect((await finish(running)).version_of).toBe(a.id);
    expect((await stack(a.id)).versions).toHaveLength(2);
  });

  it("of the head itself keeps it, and leaves its versions counting down from now", async () => {
    const t0 = now();
    const head = await make();
    const a = await make(head.id);
    const res = await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: head.id });
    expect(res.json().head.id).toBe(head.id);
    expect((await row(head.id)).kept_at).not.toBeNull();
    const v = await row(a.id);
    expect(v.version_of).toBe(head.id);
    expect(v.countdown_from! >= t0).toBe(true);
  });

  it("refuses what is not a version of the picture", async () => {
    const head = await upload("zz-test terrace");
    const other = await upload("zz-test other");
    expect((await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: other.id })).statusCode).toBe(404);
    expect((await row(other.id)).version_of).toBeNull();
  });

  it("never lets the sweep take an old head something uses (a draft's form): hidden, but kept", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    const at = now();
    await t.db.insertInto("drafts").values({ id: newId(), owner_id: OWNER, project_id: null, target: "new", recipe_id: "sdxl.inpaint", title: "zz-test", name: null, forms: JSON.stringify({ "sdxl.inpaint": { picture: head.id } }), count: 1, chat: null, look: null, created_at: at, updated_at: at } as never).execute();
    await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: a.id });
    await sweep(t.db, t.services.storage, Date.now() + UNKEPT_MS + 60_000);
    expect(await row(head.id)).toMatchObject({ version_of: a.id, deleted_at: null });
  });

  it("never lets the sweep take an old head a timeline uses (a clip's picture)", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    const at = now();
    await t.db.insertInto("timelines").values({ id: "zz-tl", owner_id: OWNER, name: "zz-test", created_at: at, updated_at: at } as never).execute();
    await t.db.insertInto("clips").values({ id: "zz-clip", timeline_id: "zz-tl", position: 0, take_id: null, joined: "cut", recipe_id: "h3.video", inputs: JSON.stringify({ start: head.id }), created_at: at, updated_at: at } as never).execute();
    await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: a.id });
    await sweep(t.db, t.services.storage, Date.now() + UNKEPT_MS + 60_000);
    expect(await row(head.id)).toMatchObject({ version_of: a.id, deleted_at: null });
  });

  it("all as pictures: every version leaves the stack, kept, in the head's folder", async () => {
    const folder = (await post(t.app, "/api/folders", { name: "zz-test shots" })).json().id as string;
    const head = await upload("zz-test terrace", folder);
    const a = await make(head.id);
    const b = await make(head.id);
    const res = await post(t.app, `/api/assets/${head.id}/versions/keep-all`);
    expect(res.json()).toMatchObject({ head: { id: head.id }, versions: [] });
    for (const id of [a.id, b.id]) {
      const r = await row(id);
      expect(r).toMatchObject({ version_of: null, folder_id: folder });
      expect(r.kept_at).not.toBeNull();
    }
    expect((await listed()).map((i) => i.id).sort()).toEqual([head.id, a.id, b.id].sort());
  });

  it("puts the version in the head's draft and its grid cell: the draft's column and the board still list it (#298, #314)", async () => {
    const draft = newId();
    const head = await make(undefined, draft);
    await t.db.updateTable("assets").set({ grid_id: "zz-grid", grid_cell: "1.0.0" }).where("id", "=", head.id).execute();
    // a fix sent from the viewer says no draft
    const a = await make(head.id);
    expect((await listed(`?draft=${draft}`)).map((i) => i.id)).toEqual([head.id]);
    await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: a.id });
    expect((await listed(`?draft=${draft}`)).map((i) => i.id)).toEqual([a.id]);
    expect(await row(a.id)).toMatchObject({ grid_id: "zz-grid", grid_cell: "1.0.0" });
    expect(await row(head.id)).toMatchObject({ grid_id: null, grid_cell: null });
    expect((await listed("?grid=zz-grid")).map((i) => i.id)).toEqual([a.id]);
  });

  it("all as pictures: each joins the head's draft beside it", async () => {
    const draft = newId();
    const head = await make(undefined, draft);
    const a = await make(head.id);
    await post(t.app, `/api/assets/${head.id}/versions/keep-all`);
    expect((await listed(`?draft=${draft}`)).map((i) => i.id).sort()).toEqual([head.id, a.id].sort());
  });

  it("a version kept by itself (S, MCP's keep, a bulk keep) leaves its stack as a picture of its own, never kept and hidden", async () => {
    const folder = (await post(t.app, "/api/folders", { name: "zz-test shots" })).json().id as string;
    const head = await upload("zz-test terrace", folder);
    const a = await make(head.id);
    const b = await make(head.id);
    expect((await post(t.app, `/api/assets/${a.id}/keep`, { kept: true })).statusCode).toBe(200);
    expect(await row(a.id)).toMatchObject({ version_of: null, folder_id: folder });
    expect((await row(a.id)).kept_at).not.toBeNull();
    const bulk = await post(t.app, "/api/assets/bulk", { ids: [b.id], action: "keep" });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect((await row(b.id)).version_of).toBeNull();
    expect((await listed()).map((i) => i.id).sort()).toEqual([head.id, a.id, b.id].sort());
  });

  it("leaves an old head something uses kept, as an unkeep of it would be refused", async () => {
    const head = await upload("zz-test terrace");
    await post(t.app, `/api/assets/${head.id}/keep`, { kept: true });
    const a = await make(head.id);
    const at = now();
    await t.db.insertInto("drafts").values({ id: newId(), owner_id: OWNER, project_id: null, target: "new", recipe_id: "sdxl.inpaint", title: "zz-test", name: null, forms: JSON.stringify({ "sdxl.inpaint": { picture: head.id } }), count: 1, chat: null, look: null, created_at: at, updated_at: at } as never).execute();
    await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: a.id });
    expect((await row(head.id)).version_of).toBe(a.id);
    expect((await row(head.id)).kept_at).not.toBeNull();
  });

  it("all as pictures after a Keep: none comes out with the name of another (the old head numbered on)", async () => {
    const head = await upload("zz-test terrace");
    const a = await make(head.id);
    const b = await make(head.id);
    await t.db.updateTable("assets").set({ name: "zz-test terrace" }).where("id", "=", b.id).execute();
    // the kept one takes the head's name; the old head, a version now, still has it
    await post(t.app, `/api/assets/${head.id}/versions/keep`, { version: a.id });
    expect((await row(a.id)).name).toBe("zz-test terrace");
    await post(t.app, `/api/assets/${a.id}/versions/keep-all`);
    // oldest first: the old head, then b, each numbered past what is taken
    expect((await row(head.id)).name).toBe("zz-test terrace · 2");
    expect((await row(b.id)).name).toBe("zz-test terrace · 3");
    expect((await row(a.id)).name).toBe("zz-test terrace");
  });
});
