import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makePng } from "@afflatus/comfy/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KitEdit } from "../src/mcpKit";
import { importLimits } from "../src/mcpLibrary";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, makeApp, post, until, type TestApp } from "./helpers";

/**
 * The library and the Prompt kit from outside (mcpLibrary.ts, mcpKit.ts), through the SDK's own client over HTTP as Claude
 * Code reaches /mcp: each tool through the web's own path, with its refusals; a binned item that comes back; nothing that
 * says where a file is on the disk; a kit change said to the open page as a "kit" live event.
 */

// an address on the internet that answers a picture, without the internet: the rest of outbound.ts as it is
const PICTURE_URL = "https://pictures.example/zz-test/lamp.png";
// one that answers only once let go (two imports at once), one of 120 kB that says no length, one that says 90 kB
const SLOW_URL = "https://pictures.example/zz-test/slow.png";
const NOLEN_URL = "https://pictures.example/zz-test/nolen.bin";
const SAID_URL = "https://pictures.example/zz-test/said.bin";
const slow = { asked: false, go: () => {} };
const picture = () => new Response(Buffer.from(makePng(24, 16, [9, 9, 9], [200, 10, 10])), { headers: { "content-type": "image/png" } });
vi.mock("../src/outbound", async (actual) => {
  const real = await actual<typeof import("../src/outbound")>();
  return {
    ...real,
    fetchPublic: vi.fn(async (url: string, ...rest: Parameters<typeof real.fetchPublic> extends [string, ...infer R] ? R : never) => {
      if (url === PICTURE_URL) return picture();
      if (url === SLOW_URL) {
        slow.asked = true;
        await new Promise<void>((go) => (slow.go = go));
        return picture();
      }
      if (url === NOLEN_URL) {
        let sent = 0;
        return new Response(new ReadableStream({ pull(c) { if (sent >= 2) return c.close(); sent++; c.enqueue(new Uint8Array(60_000).fill(7)); } }));
      }
      if (url === SAID_URL) return new Response(new Uint8Array(10), { headers: { "content-length": "90000" } });
      return real.fetchPublic(url, ...rest);
    }),
  };
});

let clip: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) clip = await patternClip(2, { size: "320x192", fps: 16 });
}, FFMPEG_TIMEOUT);

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

async function made(start: "look" | "make"): Promise<string> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
  return res.json().token as string;
}

async function connect(start: "look" | "make" = "make"): Promise<Client> {
  const token = await made(start);
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as AddressInfo).port;
  const client = new Client({ name: "Claude Code", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

type Called = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (r: Called) => (r.content as Array<{ text?: string }>)[0]!.text!;
const ok = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
  return JSON.parse(textOf(r));
};
const refused = async (c: Client, name: string, args: Record<string, unknown>, said: RegExp) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(r)).toMatch(said);
};

const upload = async (name: string, bytes: Uint8Array = makePng(16, 16, [1, 2, 3], [4, 5, 6]), type = "image/png") =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${encodeURIComponent(name)}`, headers: { "content-type": type }, payload: Buffer.from(bytes) })).json() as { id: string };
const row = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

describe("the library", () => {
  it("is listed to a token with Look, and changed only with Make", async () => {
    const look = await connect("look");
    const names = (await look.listTools()).tools.map((x) => x.name);
    for (const n of ["search_library", "keep", "unkeep", "bin", "restore", "move", "rename", "list_places", "new_folder", "edit_folder", "new_project", "rename_project", "import_from_url", "cut_range", "find_scenes", "extract_scenes", "save_frame", "list_kit", "read_kit_item", "new_kit_item", "edit_kit_item"]) expect(names).toContain(n);
    expect(names).toHaveLength(82);
    const up = await upload("zz-test lamp");
    expect((await ok(look, "search_library", {})).items.map((i: { item: string }) => i.item)).toEqual([up.id]);
    await refused(look, "bin", { items: [up.id] }, /needs Make/);
    await refused(look, "new_kit_item", { kind: "snippet", name: "zz-test" }, /needs Make/);
    expect((await row(up.id)).deleted_at).toBeNull();
    // bin says that nothing is erased, and that erasing is never offered
    const binTool = (await look.listTools()).tools.find((x) => x.name === "bin")!;
    expect(binTool.description).toMatch(/Erasing for good is never offered through MCP/);
    await look.close();
  });

  it("is searched by words, kind, kept and folder, and never says where a file is on the disk", async () => {
    const c = await connect();
    const lamp = await upload("zz-test lamp");
    await upload("zz-test chair");
    const found = await ok(c, "search_library", { words: "lamp" });
    expect(found.items.map((i: { item: string }) => i.item)).toEqual([lamp.id]);
    expect(found.items[0]).toMatchObject({ kind: "image", name: "zz-test lamp", kept: true, inBin: false, width: 16 });
    expect(JSON.stringify(found)).not.toMatch(/"path"|assets\//);
    expect((await ok(c, "search_library", { kind: "video" })).items).toEqual([]);
    expect((await ok(c, "search_library", { kept: false })).items).toEqual([]);
    await c.close();
  });

  it("bins an item where restore brings it back, and refuses one something uses", async () => {
    const c = await connect();
    const up = await upload("zz-test lamp");
    expect(await ok(c, "bin", { items: [up.id] })).toEqual({ changed: 1 });
    expect((await row(up.id)).deleted_at).not.toBeNull();
    expect((await ok(c, "search_library", {})).items).toEqual([]);
    expect((await ok(c, "search_library", { inBin: true })).items.map((i: { item: string }) => i.item)).toEqual([up.id]);
    await ok(c, "restore", { items: [up.id] });
    expect((await row(up.id)).deleted_at).toBeNull();
    expect((await get(t.app, `/api/assets/${up.id}`)).json().inBin).toBe(false);
    // a person's picture stays out of the bin, as from the web, and a bulk bin leaves it and says so
    const other = await upload("zz-test chair");
    await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann", def: { pictures: [up.id] } });
    await refused(c, "bin", { items: [up.id] }, /still used by/);
    const bulk = await ok(c, "bin", { items: [up.id, other.id] });
    expect(bulk).toMatchObject({ changed: 1, inUse: 1 });
    expect((await row(up.id)).deleted_at).toBeNull();
    expect((await row(other.id)).deleted_at).not.toBeNull();
    // Unkeep is refused the same way; Keep and Unkeep otherwise go as the web's
    await refused(c, "unkeep", { items: [up.id] }, /still used by/);
    await ok(c, "restore", { items: [other.id] });
    await ok(c, "unkeep", { items: [other.id] });
    expect((await row(other.id)).kept_at).toBeNull();
    await ok(c, "keep", { items: [other.id] });
    expect((await row(other.id)).kept_at).not.toBeNull();
    await c.close();
  });

  it("makes projects and folders, moves items into them, renames all three", async () => {
    const c = await connect();
    const up = await upload("zz-test lamp");
    const project = await ok(c, "new_project", { name: "zz-test Shoot" });
    const folder = await ok(c, "new_folder", { name: "zz-test Picks", project: project.id });
    expect(folder.project).toBe(project.id);
    const moved = await ok(c, "move", { items: [up.id], folder: folder.id });
    expect(moved.moved).toBe(1);
    expect((await row(up.id)).folder_id).toBe(folder.id);
    expect((await ok(c, "search_library", { folder: folder.id })).items).toHaveLength(1);
    expect((await ok(c, "search_library", { project: project.id })).items).toHaveLength(1);
    // into the project's root folder
    await ok(c, "move", { items: [up.id], project: project.id });
    expect((await row(up.id)).folder_id).toBe(project.rootFolder);
    await ok(c, "edit_folder", { folder: folder.id, name: "zz-test Keepers", parent: project.rootFolder });
    await ok(c, "rename_project", { project: project.id, name: "zz-test Shoot 2" });
    await ok(c, "rename", { item: up.id, name: "zz-test the lamp" });
    expect((await row(up.id)).name).toBe("zz-test the lamp");
    const places = await ok(c, "list_places");
    expect(places.projects).toEqual([expect.objectContaining({ id: project.id, name: "zz-test Shoot 2", items: 1 })]);
    expect(places.folders).toEqual(expect.arrayContaining([expect.objectContaining({ id: folder.id, name: "zz-test Keepers", parent: project.rootFolder, project: project.id })]));
    await refused(c, "edit_folder", { folder: project.rootFolder, parent: folder.id }, /inside itself/);
    await refused(c, "move", { items: [up.id] }, /Say where to/);
    await c.close();
  });

  it("imports a picture from a public address, and refuses one inside the network", async () => {
    const c = await connect();
    const project = await ok(c, "new_project", { name: "zz-test Shoot" });
    const got = await ok(c, "import_from_url", { url: PICTURE_URL, project: project.id });
    expect(got).toMatchObject({ kind: "image", name: "lamp", width: 24, height: 16, kept: true, folder: project.rootFolder });
    expect((await row(got.item)).origin).toBe("uploaded");
    await refused(c, "import_from_url", { url: "http://192.168.1.20/a.png" }, /inside your own network/);
    await refused(c, "import_from_url", { url: "http://127.0.0.1:8188/view?filename=a.png" }, /inside your own network/);
    await c.close();
  });

  it("imports one file at a time per token, each held to an agent's most, and no more than the token's bytes of the day", async () => {
    const was = { ...importLimits };
    Object.assign(importLimits, { file: 100_000, day: 150_000 });
    try {
      const c = await connect();
      // a second import while the first is under way is refused; once it ends, the next goes
      const first = ok(c, "import_from_url", { url: SLOW_URL });
      await until(() => slow.asked);
      await refused(c, "import_from_url", { url: PICTURE_URL }, /already importing a file: one at a time/);
      slow.go();
      expect((await first).kind).toBe("image");
      // past the most of a file: stopped as it comes when no length is said, at once when one is
      await refused(c, "import_from_url", { url: NOLEN_URL }, /an agent imports at most/);
      // what it fetched counts: 120 kB of the day's 150 kB, so 90 kB said goes past what is left
      await refused(c, "import_from_url", { url: SAID_URL }, /goes past what this token may still fetch today/);
      expect((await ok(c, "import_from_url", { url: PICTURE_URL })).kind).toBe("image");
      await refused(c, "import_from_url", { url: NOLEN_URL }, /may still fetch today/);
      await refused(c, "import_from_url", { url: PICTURE_URL }, /over the last 24 hours, the most it may/);
      // another token has a day of its own
      const other = await connect();
      expect((await ok(other, "import_from_url", { url: PICTURE_URL })).kind).toBe("image");
      await Promise.all([c.close(), other.close()]);
    } finally {
      Object.assign(importLimits, was);
    }
  });
});

describe.skipIf(!ffmpegThere)("a video's ranges and frames", { timeout: FFMPEG_TIMEOUT }, () => {
  const settled = (id: string) => until(async () => ["done", "failed"].includes((await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirst())?.status ?? ""), 60_000, 50);

  it("copies a range, saves a frame, finds the shots, and a split bins the source where restore finds it", async () => {
    await t.services.queue.start();
    const c = await connect();
    const video = await upload("zz-test clip.mp4", clip, "video/mp4");
    const copy = await ok(c, "cut_range", { item: video.id, startMs: 500, endMs: 1500, action: "copy" });
    await settled(copy.job);
    const items = (await ok(c, "search_library", { kind: "video" })).items as Array<{ item: string; durationMs: number }>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.item !== video.id)!.durationMs).toBeGreaterThan(900);
    const frame = await ok(c, "save_frame", { item: video.id, atMs: 1000 });
    expect(frame).toMatchObject({ kind: "image", width: 320, height: 192 });
    const scenes = await ok(c, "find_scenes", { item: video.id });
    expect(Array.isArray(scenes.cuts)).toBe(true);
    await refused(c, "find_scenes", { item: frame.item }, /takes a video/);
    const split = await ok(c, "cut_range", { item: video.id, startMs: 500, endMs: 1500, action: "split" });
    expect(split.then).toMatch(/restore brings it back/);
    await settled(split.job);
    await until(async () => (await row(video.id)).deleted_at !== null);
    expect((await ok(c, "search_library", { inBin: true })).items.map((i: { item: string }) => i.item)).toContain(video.id);
    await ok(c, "restore", { items: [video.id] });
    expect((await row(video.id)).deleted_at).toBeNull();
    await c.close();
  });
});

describe("the Prompt kit", () => {
  it("makes a person from a picture, lists them with their @Name, and reads them", async () => {
    const c = await connect();
    const up = await upload("zz-test face");
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann Lee", def: { pictures: [up.id], sentence: "a woman with short grey hair" } });
    expect(person).toMatchObject({ kind: "person", name: "zz-test Ann Lee", mention: "@zz_test_Ann_Lee", pictures: 1 });
    const kit = await ok(c, "list_kit", { kind: "person" });
    expect(kit).toEqual([expect.objectContaining({ id: person.id, mention: "@zz_test_Ann_Lee", words: "a woman with short grey hair" })]);
    const read = await ok(c, "read_kit_item", { item: "@zz_test_Ann_Lee" });
    expect(read.def).toMatchObject({ pictures: [up.id], sentence: "a woman with short grey hair" });
    // a picture of the library chosen for them is kept from then on
    expect((await row(up.id)).kept_at).not.toBeNull();
    await c.close();
  });

  it("changes an item through the kit's save, said to the open page as a kit event with what it was", async () => {
    const c = await connect();
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann", def: { sentence: "a woman" } });
    const heard: KitEdit[] = [];
    t.services.queue.events.on("kit", (e: KitEdit) => heard.push(e));
    const done = await ok(c, "edit_kit_item", { item: person.id, name: "zz-test Ann B", set: { sentence: "a woman in a red coat", tags: "1girl, red coat" } });
    expect(done.changed.sort()).toEqual(["name", "sentence", "tags"]);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ id: person.id, kind: "person", by: "zz-test make", name: { was: "zz-test Ann", now: "zz-test Ann B" } });
    expect(heard[0]!.fields).toEqual(expect.arrayContaining([
      { key: "sentence", had: true, was: "a woman", now: "a woman in a red coat" },
      { key: "tags", had: true, was: "", now: "1girl, red coat" },
    ]));
    // what the page reads is what was saved
    const items = (await get(t.app, "/api/entities?kind=person")).json().items as Array<{ id: string; name: string; def: { sentence: string } }>;
    expect(items.find((e) => e.id === person.id)).toMatchObject({ name: "zz-test Ann B", def: { sentence: "a woman in a red coat" } });
    // nothing changed: nothing said
    await ok(c, "edit_kit_item", { item: person.id, set: { tags: "1girl, red coat" } });
    expect(heard).toHaveLength(1);
    await c.close();
  });

  it("refuses what the kit's slots refuse, a part a kind has not, and a shipped preset", async () => {
    const c = await connect();
    const up = await upload("zz-test face");
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Ann" });
    await refused(c, "edit_kit_item", { item: person.id, set: { voice: up.id } }, /voice sample has to be a sound/);
    await refused(c, "edit_kit_item", { item: person.id, set: { pictures: ["nope"] } }, /no library item nope/);
    await refused(c, "edit_kit_item", { item: person.id, set: { colour: "red" } }, /has no part colour/);
    await refused(c, "new_kit_item", { kind: "snippet", name: "zz-test", def: { text: 3 } }, /snippet: text/);
    const shipped = (await ok(c, "list_kit", { kind: "preset" })).find((p: { shipped?: boolean }) => p.shipped);
    if (shipped) await refused(c, "edit_kit_item", { item: shipped.id, name: "zz-test mine" }, /ships with Afflatus/);
    await c.close();
  });
});

describe("the routes the tools share", () => {
  it("still answer the web as before: bin, restore, bulk, rename, move", async () => {
    const up = await upload("zz-test lamp");
    expect((await t.app.inject({ method: "DELETE", url: `/api/assets/${up.id}` })).json()).toEqual({ ok: true });
    expect((await post(t.app, `/api/assets/${up.id}/restore`, {})).json()).toMatchObject({ id: up.id, inBin: false });
    expect((await post(t.app, "/api/assets/bulk", { ids: [up.id], action: "unkeep" })).json()).toEqual({ changed: 1 });
    expect((await t.app.inject({ method: "PATCH", url: `/api/assets/${up.id}`, payload: { name: "zz-test b" } })).json()).toMatchObject({ name: "zz-test b" });
    const f = (await post(t.app, "/api/folders", { name: "zz-test F" })).json();
    expect((await post(t.app, "/api/assets/move", { ids: [up.id], folderId: f.id })).json()).toMatchObject({ moved: 1 });
    expect((await t.app.inject({ method: "PATCH", url: `/api/folders/${f.id}`, payload: { name: "zz-test G" } })).json()).toEqual({ ok: true });
    const p = (await post(t.app, "/api/projects", { name: "zz-test P" })).json();
    expect((await t.app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, payload: { name: "zz-test Q" } })).json()).toMatchObject({ name: "zz-test Q" });
  });
});
