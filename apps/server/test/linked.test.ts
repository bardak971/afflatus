import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, type FakeComfy } from "@afflatus/comfy/testing";
import { whyNotLinkable } from "../src/linked";
import { CHECKPOINT, complete, get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/** A directory with pictures in it and in a sub-directory, a hidden file and a text file. */
let dir: string;
let fake: FakeComfy;
let t: TestApp;
const picture = () => Buffer.from(makePng(16, 24, [10, 20, 30], [40, 50, 60]));
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "afflatus-linked-"));
  writeFileSync(join(dir, "one.png"), picture());
  writeFileSync(join(dir, "notes.txt"), "not a picture");
  writeFileSync(join(dir, ".hidden.png"), picture());
  mkdirSync(join(dir, "day 1"));
  writeFileSync(join(dir, "day 1", "two.png"), picture());
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

const folders = async () => (await get(t.app, "/api/folders")).json().items as Array<{ id: string; parentId: string | null; name: string; count: number; path: string | null; root: boolean }>;
const inFolder = async (id: string) => (await get(t.app, `/api/assets?folder=${id}`)).json().items as Array<{ id: string; name: string; kept: boolean; path: string | null }>;
const link = async () => (await post(t.app, "/api/folders/link", { path: dir, name: "Shoots" })).json() as { id: string };

describe("a folder linked to a directory of the disk", () => {
  it("shows what is in the directory, its sub-directories as sub-folders, and serves the files from where they are", async () => {
    const root = await link();
    const all = await folders();
    expect(all.map((f) => [f.name, f.root, f.count]).sort()).toEqual([["Shoots", true, 1], ["day 1", false, 1]]);
    const sub = all.find((f) => f.name === "day 1")!;
    expect(sub.parentId).toBe(root.id);
    const [one] = await inFolder(root.id);
    // the hidden file and the text file are not part of it; a file of the disk is the user's own: it is kept
    expect(one).toMatchObject({ name: "one.png", kept: true, path: join(dir, "one.png") });
    const served = await t.app.inject({ method: "GET", url: `/api/assets/${one!.id}/file` });
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(readFileSync(join(dir, "one.png")))).toBe(true);
    // nothing was copied: the picture is where it was
    expect(readdirSync(dir).sort()).toEqual([".hidden.png", "day 1", "notes.txt", "one.png"]);
  });

  it("refuses what is no directory, and a directory that is linked already or inside one that is", async () => {
    expect((await post(t.app, "/api/folders/link", { path: join(dir, "nowhere") })).statusCode).toBe(400);
    await link();
    expect((await post(t.app, "/api/folders/link", { path: dir })).statusCode).toBe(400);
    expect((await post(t.app, "/api/folders/link", { path: join(dir, "day 1") })).statusCode).toBe(400);
  });

  it("never links the system's own directories or the home folder itself, and only what LINK_ROOTS names when that is set", async () => {
    const refused = async (path: string) => {
      const res = await post(t.app, "/api/folders/link", { path });
      expect(res.statusCode).toBe(400);
      return res.json().error as string;
    };
    expect(await refused(homedir())).toContain("home folder");
    expect(await refused(parse(dir).root)).toContain("root of a drive");
    if (process.platform === "win32") {
      expect(await refused(join(parse(dir).root, "Windows"))).toContain("Windows");
      expect(await refused(join(parse(dir).root, "Windows", "System32"))).toContain("Windows");
      expect(await refused(join(homedir(), "AppData", "Local"))).toContain("AppData");
    } else {
      expect(await refused("/etc")).toContain("system");
      expect(whyNotLinkable("/var/log")).toContain("/var");
    }
    // the allow-list: a directory outside it is refused, one inside it goes through
    process.env.LINK_ROOTS = join(dir, "day 1");
    try {
      expect(await refused(dir)).toContain("LINK_ROOTS");
      expect((await post(t.app, "/api/folders/link", { path: join(dir, "day 1") })).statusCode).toBe(200);
    } finally {
      delete process.env.LINK_ROOTS;
    }
  });

  it("is read again on request: what was added appears, what was removed is gone", async () => {
    const root = await link();
    writeFileSync(join(dir, "three.png"), picture());
    mkdirSync(join(dir, "day 2"));
    rmSync(join(dir, "day 1"), { recursive: true });
    expect((await post(t.app, `/api/folders/${root.id}/scan`, {})).json()).toEqual({ files: 2, folders: 1 });
    expect((await folders()).map((f) => f.name).sort()).toEqual(["Shoots", "day 2"]);
    expect((await inFolder(root.id)).map((a) => a.name).sort()).toEqual(["one.png", "three.png"]);
  });

  it("takes a file to the bin by moving it out of the directory, and puts it back there", async () => {
    const root = await link();
    const [one] = await inFolder(root.id);
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${one!.id}` })).statusCode).toBe(200);
    expect(existsSync(join(dir, "one.png"))).toBe(false);
    const binned = (await get(t.app, "/api/assets?bin=1")).json().items;
    // in the bin it still says where it was
    expect(binned).toMatchObject([{ id: one!.id, path: join(dir, "one.png") }]);
    expect((await t.app.inject({ method: "GET", url: `/api/assets/${one!.id}/file` })).statusCode).toBe(200);
    await post(t.app, `/api/assets/${one!.id}/restore`, {});
    expect(existsSync(join(dir, "one.png"))).toBe(true);
    expect(await inFolder(root.id)).toMatchObject([{ id: one!.id, path: join(dir, "one.png") }]);
    // several at once go the same way
    await post(t.app, "/api/assets/bulk", { ids: [one!.id], action: "bin" });
    expect(existsSync(join(dir, "one.png"))).toBe(false);
    await post(t.app, "/api/assets/bulk", { ids: [one!.id], action: "restore" });
    expect(existsSync(join(dir, "one.png"))).toBe(true);
  });

  it("makes a new folder inside it a new directory, and an upload into it a file", async () => {
    const root = await link();
    const made = (await post(t.app, "/api/folders", { name: "new one", parentId: root.id })).json();
    expect(made).toMatchObject({ name: "new_one", path: join(dir, "new_one"), root: false });
    expect(existsSync(join(dir, "new_one"))).toBe(true);
    const up = (await t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent("my shot.png")}&folder=${made.id}`, headers: { "content-type": "image/png" }, payload: picture() })).json();
    expect(up.path).toBe(join(dir, "new_one", "my_shot.png"));
    expect(existsSync(join(dir, "new_one", "my_shot.png"))).toBe(true);
  });

  it("writes a result into the directory when it is kept, under the day it was made and the start of its prompt", async () => {
    const root = await link();
    await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "Terrace at Sunset, 1girl", checkpoint: CHECKPOINT }, folder: root.id });
    await until(() => fake.prompts.size === 1);
    complete(fake, [...fake.prompts.keys()][0]!);
    await until(async () => (await inFolder(root.id)).length === 2);
    const made = (await inFolder(root.id)).find((a) => a.name !== "one.png")!;
    // made into the folder, but not a file of the directory until it is kept
    expect(made).toMatchObject({ kept: false, path: null });
    expect(readdirSync(dir).filter((f) => f.endsWith(".png") && !f.startsWith("."))).toEqual(["one.png"]);

    const kept = (await post(t.app, `/api/assets/${made.id}/keep`, { kept: true })).json();
    const day = new Date().toISOString().slice(0, 10);
    expect(kept.path).toBe(join(dir, `${day}_terrace-at-sunset-1girl.png`));
    expect(existsSync(kept.path)).toBe(true);
    // a file of the disk cannot be "not kept"
    expect((await post(t.app, `/api/assets/${made.id}/keep`, { kept: false })).json().kept).toBe(true);
  });

  it("moves a library item into it as a file, moves its files between its folders, and keeps them on the disk", async () => {
    const root = await link();
    const sub = (await folders()).find((f) => f.name === "day 1")!;
    const mine = (await t.app.inject({ method: "POST", url: "/api/assets?name=loose.png", headers: { "content-type": "image/png" }, payload: picture() })).json();
    await post(t.app, "/api/assets/move", { ids: [mine.id], folderId: sub.id });
    expect(existsSync(join(dir, "day 1", "loose.png"))).toBe(true);
    // from one linked folder to another: the file moves on the disk
    await post(t.app, "/api/assets/move", { ids: [mine.id], folderId: root.id });
    expect(existsSync(join(dir, "day 1", "loose.png"))).toBe(false);
    expect(existsSync(join(dir, "loose.png"))).toBe(true);
    // out to a folder of the library, or out of any folder: refused, the file lives on the disk
    const plain = (await post(t.app, "/api/folders", { name: "Plain" })).json();
    expect((await post(t.app, "/api/assets/move", { ids: [mine.id], folderId: plain.id })).statusCode).toBe(400);
    expect((await post(t.app, "/api/assets/move", { ids: [mine.id], folderId: null })).statusCode).toBe(400);
    expect(existsSync(join(dir, "loose.png"))).toBe(true);
  });

  it("is unlinked without touching the disk; a sub-directory is not deleted from the app", async () => {
    const root = await link();
    const sub = (await folders()).find((f) => f.name === "day 1")!;
    expect((await t.app.inject({ method: "DELETE", url: `/api/folders/${sub.id}` })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "DELETE", url: `/api/folders/${root.id}` })).statusCode).toBe(200);
    expect(await folders()).toEqual([]);
    expect((await get(t.app, "/api/assets")).json().items).toEqual([]);
    expect(readdirSync(join(dir, "day 1"))).toEqual(["two.png"]);
    expect(existsSync(join(dir, "one.png"))).toBe(true);
  });
});
