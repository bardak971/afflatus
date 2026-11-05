import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import { BIN_MS, ERASED, eraseUnused, sweep, UNKEPT_MS } from "../src/sweep";
import { CHECKPOINT, complete, get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Keep and the files of linked folders (card #322): a picture of a linked folder that a Keep made a version (an old head)
 * stays kept through every later Keep, and is never erased from the user's disk, by the sweep or the bin, whatever put
 * its row there. Also the stack's edge cases: an old head something uses, a head in the bin, two Keeps racing, S on an
 * old head that is a linked file.
 */

let dir: string;
let fake: FakeComfy;
let t: TestApp;
const picture = () => Buffer.from(makePng(16, 24, [10, 20, 30], [40, 50, 60]));
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "afflatus-versions-linked-"));
  writeFileSync(join(dir, "mine.png"), picture());
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const row = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
/** The folder linked to `dir`, and the item of its one picture. */
const linkedPicture = async () => {
  const folder = (await post(t.app, "/api/folders/link", { path: dir, name: "zz-test shoots" })).json() as { id: string };
  const [item] = (await get(t.app, `/api/assets?folder=${folder.id}`)).json().items as Array<{ id: string }>;
  return { folder: folder.id, item: item!.id };
};
const upload = async (name: string) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}`, headers: { "content-type": "image/png" }, payload: picture() })).json() as { id: string };
/** A version of `of` made by a job, as a Paint and fix sends it. */
const version = async (of: string) => {
  const before = fake.prompts.size;
  const res = await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "zz-test a lamp", checkpoint: CHECKPOINT }, versionOf: of });
  expect(res.statusCode, res.body).toBe(200);
  await until(() => fake.prompts.size === before + 1);
  const job = res.json().ids[0] as string;
  complete(fake, [...fake.prompts.keys()].at(-1)!);
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", job).executeTakeFirstOrThrow()).status === "done");
  const made = await t.db.selectFrom("jobs").select("generation_id").where("id", "=", job).executeTakeFirstOrThrow();
  return t.db.selectFrom("assets").selectAll().where("generation_id", "=", made.generation_id!).executeTakeFirstOrThrow();
};
const keep = (head: string, v: string) => post(t.app, `/api/assets/${head}/versions/keep`, { version: v });
const later = (ms: number) => sweep(t.db, t.services.storage, Date.now() + ms);
const inDraft = async (id: string) => {
  const at = now();
  await t.db.insertInto("drafts").values({ id: newId(), owner_id: OWNER, project_id: null, target: "new", recipe_id: "sdxl.inpaint", title: "zz-test", name: null, forms: JSON.stringify({ "sdxl.inpaint": { picture: id } }), count: 1, chat: null, look: null, created_at: at, updated_at: at } as never).execute();
};

describe("Keep on a picture of a linked folder", () => {
  it("never erases the user's file: two Keeps, the sweep a day on and after the bin's time, and the file is still there (the review's scenario)", async () => {
    const { item } = await linkedPicture();
    const file = join(dir, "mine.png");
    const bytes = readFileSync(file);
    const v1 = await version(item);
    const v2 = await version(item);
    expect((await keep(item, v1.id)).statusCode).toBe(200);
    expect((await keep(v1.id, v2.id)).statusCode).toBe(200);
    // the original is an old head under v2 now, and still kept, as a file of a linked folder always is
    const old = await row(item);
    expect(old).toMatchObject({ version_of: v2.id, file_key: `linked:${file}` });
    expect(old.kept_at).not.toBeNull();
    // v1, written into the folder on its Keep, is a linked file too, and stays kept as well
    expect((await row(v1.id)).kept_at).not.toBeNull();
    await later(UNKEPT_MS + 60_000);
    expect((await row(item)).deleted_at).toBeNull();
    await later(UNKEPT_MS + BIN_MS + 60_000);
    expect(await row(item)).toMatchObject({ deleted_at: null, file_key: `linked:${file}` });
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });

  it("a linked file a plain update put in the bin (before the fix) comes back, and its file is never erased", async () => {
    const { item } = await linkedPicture();
    const file = join(dir, "mine.png");
    // as the old second Keep and the sweep left it: unkept, in the bin by a plain update, its key still in its folder
    await t.db.updateTable("assets").set({ kept_at: null, deleted_at: new Date(Date.now() - BIN_MS - 60_000).toISOString() }).where("id", "=", item).execute();
    await later(BIN_MS + 60_000);
    const back = await row(item);
    expect(back.deleted_at).toBeNull();
    expect(back.kept_at).not.toBeNull();
    expect(existsSync(file)).toBe(true);
  });

  it("the storage refuses to remove a linked file, whatever asks: the bin emptied names it, the file stays", async () => {
    const { item } = await linkedPicture();
    const file = join(dir, "mine.png");
    await expect(t.services.storage.delete(`linked:${file}`)).rejects.toThrow(/never deleted from the disk/);
    // the bin emptied now (Storage's empty-the-bin) with such a row in it does not erase it either
    await t.db.updateTable("assets").set({ kept_at: null, deleted_at: new Date(Date.now() - BIN_MS - 60_000).toISOString() }).where("id", "=", item).execute();
    const { erased } = await eraseUnused(t.db, t.services.storage, (tx) => tx.selectFrom("assets").select(ERASED).where("deleted_at", "is not", null).execute());
    expect(erased).toEqual([]);
    expect(existsSync(file)).toBe(true);
    expect((await row(item)).id).toBe(item);
  });

  it("taken to the bin by hand it still moves out of its folder, and is erased from the bin's own copy only", async () => {
    const { item } = await linkedPicture();
    const file = join(dir, "mine.png");
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${item}` })).statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    const binned = await row(item);
    expect(binned.file_key.startsWith("linked:")).toBe(false);
    await later(BIN_MS + 60_000);
    expect(await t.db.selectFrom("assets").select("id").where("id", "=", item).executeTakeFirst()).toBeUndefined();
  });

  it("S on the old head (a linked file that is a version) makes it a picture of its own again, in its own folder", async () => {
    const { folder, item } = await linkedPicture();
    const v1 = await version(item);
    await keep(item, v1.id);
    expect((await row(item)).version_of).toBe(v1.id);
    const res = await post(t.app, `/api/assets/${item}/keep`, { kept: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(item)).toMatchObject({ version_of: null, folder_id: folder });
  });

  it("a bulk keep frees a linked old head too", async () => {
    const { folder, item } = await linkedPicture();
    const v1 = await version(item);
    await keep(item, v1.id);
    const res = await post(t.app, "/api/assets/bulk", { ids: [item], action: "keep" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toBe(1);
    expect(await row(item)).toMatchObject({ version_of: null, folder_id: folder });
  });

  it("kept back as the head from the strip, the old linked head stays in the folder its file lies in", async () => {
    const { folder, item } = await linkedPicture();
    const other = (await post(t.app, "/api/folders", { name: "zz-test elsewhere" })).json().id as string;
    const v1 = await version(item);
    await keep(item, v1.id);
    // the new head moved to another folder of the library meanwhile
    await t.db.updateTable("assets").set({ folder_id: other }).where("id", "=", v1.id).execute();
    expect((await keep(v1.id, item)).statusCode).toBe(200);
    expect(await row(item)).toMatchObject({ version_of: null, folder_id: folder });
  });
});

describe("Keep's other edge cases", () => {
  it("an old head something uses stays kept through a second Keep, not only the first", async () => {
    const head = await upload("zz-test terrace");
    await post(t.app, `/api/assets/${head.id}/keep`, { kept: true });
    await inDraft(head.id);
    const a = await version(head.id);
    const b = await version(head.id);
    await keep(head.id, a.id);
    await keep(a.id, b.id);
    const old = await row(head.id);
    expect(old.version_of).toBe(b.id);
    expect(old.kept_at).not.toBeNull();
    // a was the head and nothing uses it: it counts down as any other version
    expect((await row(a.id)).kept_at).toBeNull();
  });

  it("a Keep while the head is in the bin takes its grid cell all the same: put back, it shares it with nobody", async () => {
    const head = await upload("zz-test terrace");
    const a = await version(head.id);
    await t.db.updateTable("assets").set({ grid_id: "zz-grid", grid_cell: "1.0.0" }).where("id", "=", head.id).execute();
    // binned from another tab while the strip was open: the version stays a version in that strip's eyes
    await t.db.updateTable("assets").set({ deleted_at: now() }).where("id", "=", head.id).execute();
    expect((await keep(head.id, a.id)).statusCode).toBe(200);
    expect(await row(a.id)).toMatchObject({ grid_id: "zz-grid", grid_cell: "1.0.0" });
    expect(await row(head.id)).toMatchObject({ grid_id: null, grid_cell: null, version_of: null });
  });

  it("Keep the original, raced by a Keep of a version: refused, and the old head is not left kept but hidden", async () => {
    const head = await upload("zz-test terrace");
    const a = await version(head.id);
    // the other Keep lands between the original's look at its stack and its transaction
    const real = t.db.transaction.bind(t.db);
    vi.spyOn(t.db, "transaction").mockImplementationOnce(() => ({
      execute: async (work: never) => {
        expect((await keep(head.id, a.id)).statusCode).toBe(200);
        return real().execute(work);
      },
    }) as never);
    const res = await keep(head.id, head.id);
    expect(res.statusCode).toBe(409);
    const old = await row(head.id);
    expect(old.version_of).toBe(a.id);
    expect(old.kept_at).toBeNull();
  });
});
