import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import { isNetworkPath, slug, whyNotLinkableOnDisk } from "../src/linked";
import { installNodePack } from "../src/nodePack";
import { eraseAsset, ERASED, inUse, sweep, sweepOrphans, UNKEPT_MS } from "../src/sweep";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";
import { get, makeApp, post, type TestApp } from "./helpers";

/**
 * Linked folders keep what they know when the disk misbehaves: a directory that cannot be listed for a moment, a file
 * renamed, a file a timeline uses that went, a file another program holds open. The file system is the real one, but
 * for the paths named in `denied` (readdir answers EACCES) and `busy` (rm answers EBUSY), as a permission change or an
 * open file would.
 */
const fsTrap = vi.hoisted(() => ({ denied: new Set<string>(), busy: new Set<string>() }));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const refuse = (code: string) => Object.assign(new Error(`${code}: refused for the test`), { code });
  const readdir = (async (path: string, opts?: unknown) => {
    if (fsTrap.denied.has(String(path))) throw refuse("EACCES");
    return real.readdir(path, opts as never);
  }) as typeof real.readdir;
  const rm = (async (path: string, opts?: unknown) => {
    if (fsTrap.busy.has(String(path))) throw refuse("EBUSY");
    return real.rm(path, opts as never);
  }) as typeof real.rm;
  return { ...real, default: { ...real, readdir, rm }, readdir, rm };
});

let dir: string;
let t: TestApp;
const picture = (shade = 30) => Buffer.from(makePng(16, 24, [10, 20, shade], [40, 50, 60]));
beforeEach(async () => {
  fsTrap.denied.clear();
  fsTrap.busy.clear();
  dir = mkdtempSync(join(tmpdir(), "afflatus-linked-"));
  writeFileSync(join(dir, "one.png"), picture(31));
  mkdirSync(join(dir, "day 1"));
  writeFileSync(join(dir, "day 1", "two.png"), picture(32));
  writeFileSync(join(dir, "day 1", "three.png"), picture(33));
  t = await makeApp();
});
afterEach(async () => {
  fsTrap.denied.clear();
  fsTrap.busy.clear();
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

type Item = { id: string; name: string; path: string | null; folderId: string | null };
const link = async () => (await post(t.app, "/api/folders/link", { path: dir, name: "Shoots" })).json() as { id: string };
const scan = (id: string) => post(t.app, `/api/folders/${id}/scan`, {});
const all = async () => (await t.db.selectFrom("assets").select(["id", "name", "file_key", "folder_id"]).execute()).map((a) => ({ id: a.id, name: a.name, key: a.file_key, folder: a.folder_id }));
const byName = async (name: string) => (await all()).find((a) => a.name === name);
const folders = async () => (await get(t.app, "/api/folders")).json().items as Array<{ id: string; name: string; path: string | null }>;

/** The asset on a timeline: a clip that plays it as its take. */
async function onTimeline(assetId: string): Promise<void> {
  const timeline = (await post(t.app, "/api/timelines", {})).json().id as string;
  const clip = newId();
  const take = newId();
  await t.db.insertInto("clips").values({ id: clip, timeline_id: timeline, position: 0, take_id: null, joined: "cut", recipe_id: null, inputs: "{}", created_at: now(), updated_at: now() } as never).execute();
  await t.db.insertInto("takes").values({
    id: take, clip_id: clip, asset_id: assetId, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, created_at: now(),
  } as never).execute();
  await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clip).execute();
}

describe("a linked folder read when the disk misbehaves", () => {
  it("forgets nothing under a directory it cannot list for a moment (EACCES), and finds it all again under the same ids", async () => {
    const root = await link();
    const before = await all();
    expect(before).toHaveLength(3);
    fsTrap.denied.add(join(dir, "day 1"));
    expect((await scan(root.id)).statusCode).toBe(200);
    expect(await all()).toEqual(before);
    expect((await folders()).map((f) => f.name).sort()).toEqual(["Shoots", "day 1"]);
    // the whole folder unreadable: nothing goes either
    fsTrap.denied.add(dir);
    expect((await scan(root.id)).statusCode).toBe(200);
    expect(await all()).toEqual(before);
    fsTrap.denied.clear();
    await scan(root.id);
    expect(await all()).toEqual(before);
  });

  it("follows a file renamed or moved on the disk: same id, its name given in Afflatus kept, its take still on the timeline", async () => {
    const root = await link();
    const one = (await byName("one.png"))!;
    const two = (await byName("two.png"))!;
    await onTimeline(one.id);
    await t.app.inject({ method: "PATCH", url: `/api/assets/${two.id}`, payload: { name: "Hero shot" } });
    // a rename keeps the time the file was last written: that, and its size, is how it is known again
    renameSync(join(dir, "one.png"), join(dir, "uno.png"));
    renameSync(join(dir, "day 1", "two.png"), join(dir, "moved.png"));
    expect((await scan(root.id)).statusCode).toBe(200);
    const after = await all();
    expect(after).toHaveLength(3);
    expect(after.find((a) => a.id === one.id)).toMatchObject({ name: "uno.png", key: `linked:${join(dir, "uno.png")}`, folder: root.id });
    expect(after.find((a) => a.id === two.id)).toMatchObject({ name: "Hero shot", key: `linked:${join(dir, "moved.png")}`, folder: root.id });
    expect((await t.db.selectFrom("takes").select("asset_id").execute()).map((r) => r.asset_id)).toEqual([one.id]);
  });

  it("keeps the row of a file a timeline uses when the file goes (answered as not on the disk), and forgets one nothing uses", async () => {
    const root = await link();
    const two = (await byName("two.png"))!;
    const three = (await byName("three.png"))!;
    await onTimeline(two.id);
    const kept = readFileSync(join(dir, "day 1", "two.png"));
    rmSync(join(dir, "day 1"), { recursive: true });
    expect((await scan(root.id)).statusCode).toBe(200);
    const ids = (await all()).map((a) => a.id);
    expect(ids).toContain(two.id);
    expect(ids).not.toContain(three.id);
    // the library says it is missing (its tile says so, rather than wait for a picture), the other items not
    const listed = (await get(t.app, "/api/assets")).json().items as Array<{ id: string; missing?: true }>;
    expect(listed.find((a) => a.id === two.id)?.missing).toBe(true);
    expect(listed.filter((a) => a.missing).map((a) => a.id)).toEqual([two.id]);
    expect((await get(t.app, `/api/assets/${two.id}`)).json().missing).toBe(true);
    // its folder stays, so that it is found where it was
    expect((await folders()).map((f) => f.name).sort()).toEqual(["Shoots", "day 1"]);
    const res = await t.app.inject({ method: "GET", url: `/api/assets/${two.id}/file` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not on the disk any more/);
    // back on the disk: served again, same id
    mkdirSync(join(dir, "day 1"));
    writeFileSync(join(dir, "day 1", "two.png"), kept);
    await scan(root.id);
    expect((await t.app.inject({ method: "GET", url: `/api/assets/${two.id}/file` })).statusCode).toBe(200);
    expect((await get(t.app, `/api/assets/${two.id}`)).json().missing).toBeUndefined();
  });

  it("is not unlinked while a timeline uses one of its files, and says which", async () => {
    const root = await link();
    const two = (await byName("two.png"))!;
    await onTimeline(two.id);
    const res = await t.app.inject({ method: "DELETE", url: `/api/folders/${root.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("two.png");
    expect(res.json().error).toContain("a timeline");
    expect(await all()).toHaveLength(3);
    await t.db.deleteFrom("clips").execute();
    expect((await t.app.inject({ method: "DELETE", url: `/api/folders/${root.id}` })).statusCode).toBe(200);
    expect(await all()).toHaveLength(0);
  });

  it("leaves a file another program holds open where it is, row and all, when it is taken to the bin", async () => {
    const root = await link();
    const one = (await byName("one.png"))!;
    fsTrap.busy.add(join(dir, "one.png"));
    const res = await t.app.inject({ method: "DELETE", url: `/api/assets/${one.id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/open in another program/);
    expect(await byName("one.png")).toMatchObject({ id: one.id, key: `linked:${join(dir, "one.png")}` });
    expect(existsSync(join(t.dir, "assets", one.id.slice(0, 2), `${one.id}.png`))).toBe(false);
    // read again: still one item for it, not two
    await scan(root.id);
    expect((await all()).filter((a) => a.key.endsWith("one.png"))).toHaveLength(1);
  });
});

/** A short video, made once for the file with ffmpeg (these tests are skipped without it). */
let video: Buffer;
beforeAll(async () => {
  if (ffmpegThere) video = Buffer.from(await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=64x48:rate=12:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]));
}, FFMPEG_TIMEOUT);

describe.skipIf(!ffmpegThere)("a range of a linked video split out", () => {
  it("takes the source to the bin as a linked file goes there (a copy kept, put back into its folder), never erasing the user's file", async () => {
    writeFileSync(join(dir, "clip.mp4"), video);
    const root = await link();
    const row = (await t.db.selectFrom("assets").selectAll().where("name", "=", "clip.mp4").executeTakeFirstOrThrow());
    const made = await t.services.timelines.range.cutRange(row, 500, 1500, "split");
    expect(made.length).toBeGreaterThanOrEqual(2);
    const source = await t.db.selectFrom("assets").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
    expect(source.deleted_at).not.toBeNull();
    expect(source.linked_path).toBe(join(dir, "clip.mp4"));
    expect(source.file_key.startsWith("assets/")).toBe(true);
    // emptying the bin erases Afflatus's copy; the user's folder is as the split left it
    await post(t.app, `/api/assets/${row.id}/restore`, {});
    expect(readFileSync(join(dir, "clip.mp4")).equals(video)).toBe(true);
    expect((await t.db.selectFrom("assets").select(["file_key", "folder_id"]).where("id", "=", row.id).executeTakeFirstOrThrow())).toEqual({ file_key: `linked:${join(dir, "clip.mp4")}`, folder_id: root.id });
  });

  it("is refused while a timeline plays the source; Copy to library still works", async () => {
    writeFileSync(join(dir, "clip.mp4"), video);
    await link();
    const row = (await byName("clip.mp4"))!;
    await t.db.updateTable("assets").set({ duration_ms: 2000 }).where("id", "=", row.id).execute();
    await onTimeline(row.id);
    for (const action of ["split", "remove"]) {
      const res = await post(t.app, `/api/assets/${row.id}/range`, { startMs: 500, endMs: 1500, action });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("a timeline");
    }
    // and a cut that was queued before the video came to be used leaves it where it is
    const full = await t.db.selectFrom("assets").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();
    await t.services.timelines.range.cutRange(full, 500, 1500, "remove");
    expect((await t.db.selectFrom("assets").select(["deleted_at", "file_key"]).where("id", "=", row.id).executeTakeFirstOrThrow())).toEqual({ deleted_at: null, file_key: `linked:${join(dir, "clip.mp4")}` });
    expect(existsSync(join(dir, "clip.mp4"))).toBe(true);
  });
});

describe("a linked file changed on the disk", () => {
  it("is served with a tag of its version and asked again each time; Afflatus's own files stay cached for good", async () => {
    await link();
    const one = (await byName("one.png"))!;
    const first = await t.app.inject({ method: "GET", url: `/api/assets/${one.id}/file` });
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const tag = String(first.headers.etag);
    expect(tag).toMatch(/^".+"$/);
    expect((await t.app.inject({ method: "GET", url: `/api/assets/${one.id}/file`, headers: { "if-none-match": tag } })).statusCode).toBe(304);
    // retouched elsewhere: another tag, the new bytes
    writeFileSync(join(dir, "one.png"), picture(99));
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(dir, "one.png"), later, later);
    const again = await t.app.inject({ method: "GET", url: `/api/assets/${one.id}/file`, headers: { "if-none-match": tag } });
    expect(again.statusCode).toBe(200);
    expect(again.headers.etag).not.toBe(tag);
    expect((await t.app.inject({ method: "GET", url: `/api/assets/${one.id}/thumb` })).headers["cache-control"]).toBe("private, no-cache");
    const own = (await t.app.inject({ method: "POST", url: "/api/assets?name=own.png", headers: { "content-type": "image/png" }, payload: picture() })).json() as { id: string };
    expect((await t.app.inject({ method: "GET", url: `/api/assets/${own.id}/file` })).headers["cache-control"]).toContain("immutable");
  });
});

describe("linking checks where a path really leads", () => {
  it("refuses a network path before asking the disk anything, here and for ComfyUI's folder", async () => {
    expect(isNetworkPath("\\\\192.0.2.1\\share\\x")).toBe(true);
    expect(isNetworkPath("//192.0.2.1/share/x")).toBe(true);
    expect(isNetworkPath(dir)).toBe(false);
    const started = Date.now();
    const res = await post(t.app, "/api/folders/link", { path: "//192.0.2.1/share/x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/network path/);
    expect(await installNodePack("\\\\192.0.2.1\\comfy")).toMatchObject({ written: false });
    // nothing reached for the share: an SMB attempt takes many seconds to fail
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("follows a junction or a symbolic link before the LINK_ROOTS rule", async () => {
    const allowed = join(dir, "allowed");
    const other = join(dir, "other");
    mkdirSync(allowed);
    mkdirSync(other);
    symlinkSync(other, join(allowed, "door"), "junction");
    const env = { ...process.env, LINK_ROOTS: allowed };
    expect(await whyNotLinkableOnDisk(join(allowed, "door"), "", env)).toContain("LINK_ROOTS");
    expect(await whyNotLinkableOnDisk(allowed, "", env)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("sees through Windows's short names", async () => {
    expect(await whyNotLinkableOnDisk("C:/PROGRA~1/Windows NT")).toContain("Windows");
  });
});

describe("what a draft or a job still to run names", () => {
  /** A result nobody kept, old enough for the bin. */
  async function unkept(): Promise<string> {
    const id = newId();
    const key = `assets/${id.slice(0, 2)}/${id}.png`;
    await t.services.storage.put(key, picture());
    await t.db.insertInto("assets").values({
      id, owner_id: OWNER, kind: "image", origin: "generated", name: "", file_key: key, thumb_key: null, mime: "image/png", bytes: 1, width: 1, height: 1, duration_ms: null,
      fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: null, fine_latent_key: null, deleted_at: null, created_at: new Date(Date.now() - UNKEPT_MS - 60_000).toISOString(),
    } as never).execute();
    return id;
  }

  it("is not taken to the bin: a picture pinned in a draft's form, its look, the item it edits, a job's resume", async () => {
    const inForm = await unkept();
    const inLook = await unkept();
    const edited = await unkept();
    const resumed = await unkept();
    const free = await unkept();
    const at = now();
    const draft = { owner_id: OWNER, project_id: null, recipe_id: "sdxl.text-to-picture", title: "zz-test", name: null, count: 1, chat: null, created_at: at, updated_at: at };
    await t.db.insertInto("drafts").values({ ...draft, id: newId(), target: "new", forms: JSON.stringify({ "sdxl.text-to-picture": { image: inForm } }), look: JSON.stringify({ people: [{ picture: inLook }] }) }).execute();
    await t.db.insertInto("drafts").values({ ...draft, id: newId(), target: `asset:${edited}`, forms: "{}", look: null }).execute();
    await t.db.insertInto("jobs").values({
      id: newId(), owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "zz-test", inputs: "{}", status: "running", warm: 0, look: null, priority: 0, depends_on: null, attempts: 1,
      resume: JSON.stringify({ neighbour: { asset: resumed } }), error: null, generation_id: null, clip_id: null, timeline_id: null, clip_fit: 0, finished_from: null, draft_id: null, folder_id: null, created_at: at, started_at: at, finished_at: null, updated_at: at,
    } as never).execute();
    const used = await inUse(t.db);
    expect([inForm, inLook, edited, resumed].map((id) => used.get(id))).toEqual(["a draft", "a draft", "a draft", "a job still to run"]);
    await sweep(t.db, t.services.storage);
    const binned = (await t.db.selectFrom("assets").select("id").where("deleted_at", "is not", null).execute()).map((r) => r.id);
    expect(binned).toEqual([free]);
  });
});

describe("the files of Afflatus's own storage", () => {
  const old = (path: string) => {
    const then = new Date(Date.now() - UNKEPT_MS - 60_000);
    utimesSync(path, then, then);
  };

  it("that no item names are erased a day after they were written; the files of items, and new ones, stay", async () => {
    const orphan = newId();
    const fresh = newId();
    const mine = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test.png", headers: { "content-type": "image/png" }, payload: picture() })).json() as { id: string };
    await t.services.storage.put(`assets/${orphan.slice(0, 2)}/${orphan}.png`, picture());
    await t.services.storage.put(`thumbs/${orphan.slice(0, 2)}/${orphan}.webp`, picture());
    await t.services.storage.put(`assets/${fresh.slice(0, 2)}/${fresh}.png`, picture());
    writeFileSync(join(t.dir, "assets", `${mine.id.slice(0, 2)}`, "left.png.1a2b3c4d.part"), "half");
    writeFileSync(join(t.dir, "notes.txt"), "not the library's");
    for (const p of [`assets/${orphan.slice(0, 2)}/${orphan}.png`, `thumbs/${orphan.slice(0, 2)}/${orphan}.webp`, `assets/${mine.id.slice(0, 2)}/${mine.id}.png`, `assets/${mine.id.slice(0, 2)}/left.png.1a2b3c4d.part`, "notes.txt"]) old(join(t.dir, p));
    expect(await sweepOrphans(t.db, t.services.storage)).toBe(3);
    expect(existsSync(join(t.dir, "assets", orphan.slice(0, 2), `${orphan}.png`))).toBe(false);
    expect(existsSync(join(t.dir, "assets", fresh.slice(0, 2), `${fresh}.png`))).toBe(true);
    expect(existsSync(join(t.dir, "assets", mine.id.slice(0, 2), `${mine.id}.png`))).toBe(true);
    expect(existsSync(join(t.dir, "notes.txt"))).toBe(true);
  });

  it("are written whole or not at all: no part file is left beside one", async () => {
    await t.services.storage.put("assets/ab/zz-test.png", picture(1));
    await t.services.storage.put("assets/ab/zz-test.png", picture(2));
    expect(readdirSync(join(t.dir, "assets", "ab"))).toEqual(["zz-test.png"]);
    expect(readFileSync(join(t.dir, "assets", "ab", "zz-test.png")).equals(picture(2))).toBe(true);
  });

  it("erased while a backup is made stay until it is done, unless written again meanwhile", async () => {
    const mine = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test.png", headers: { "content-type": "image/png" }, payload: picture() })).json() as { id: string };
    const row = await t.db.selectFrom("assets").select(ERASED).where("id", "=", mine.id).executeTakeFirstOrThrow();
    const file = join(t.dir, row.file_key);
    const release = t.services.storage.hold!();
    await eraseAsset(t.db, t.services.storage, row);
    expect(existsSync(file)).toBe(true);
    await t.services.storage.delete("assets/ab/again.png");
    await t.services.storage.put("assets/ab/again.png", picture());
    await release();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(t.dir, "assets", "ab", "again.png"))).toBe(true);
  });

  it("are counted for the backup's plan once a minute at most", async () => {
    const first = (await get(t.app, "/api/backup")).json();
    if (!first.available) return;
    writeFileSync(join(t.dir, "zz-test.bin"), "x");
    expect((await get(t.app, "/api/backup")).json().files).toBe(first.files);
  });
});

it("a file name made from a prompt keeps its letters without their accents", () => {
  expect(slug("Crème brûlée à la plage")).toBe("creme-brulee-a-la-plage");
  expect(statSync(tmpdir()).isDirectory()).toBe(true);
});
