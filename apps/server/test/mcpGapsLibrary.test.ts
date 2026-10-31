import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { makePng } from "@afflatus/comfy/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newAssetRow } from "../src/media";
import { uploadLimits } from "../src/mcpLibrary";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere, patternClip } from "./clipKit";
import { get, makeApp, post, type TestApp } from "./helpers";

/**
 * What the web did that an agent could not (card #151, part B), through the SDK's own client over HTTP as Claude Code
 * reaches /mcp: a file sent as its bytes (upload) through the web upload's own checks and held to its limits, then set as
 * a draft's reference; a picture mirrored, a video's sound out and the video without it; a folder and a project deleted
 * with nothing in them deleted, a project archived, a linked folder read again (and not unlinked); a kit item deleted; a
 * timeline duplicated (its ids its own) and deleted; the storage read and its idle takes binned; unused drafts cleared; a
 * finished job dismissed. Each refused with Look alone.
 */

// one address that answers only once let go: an import from it holds the token's one file at a time
const SLOW_URL = "https://pictures.example/zz-test/slow.png";
const slow = { asked: false, go: () => {} };
vi.mock("../src/outbound", async (actual) => {
  const real = await actual<typeof import("../src/outbound")>();
  return {
    ...real,
    fetchPublic: vi.fn(async (url: string, ...rest: Parameters<typeof real.fetchPublic> extends [string, ...infer R] ? R : never) => {
      if (url !== SLOW_URL) return real.fetchPublic(url, ...rest);
      slow.asked = true;
      await new Promise<void>((go) => (slow.go = go));
      return new Response(Buffer.from(makePng(8, 8, [9, 9, 9], [9, 9, 9])), { headers: { "content-type": "image/png" } });
    }),
  };
});

let clip: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) clip = await patternClip(1, { size: "160x96", fps: 12 });
}, FFMPEG_TIMEOUT);

let t: TestApp;
const was = { ...uploadLimits };
beforeEach(async () => {
  t = await makeApp();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  Object.assign(uploadLimits, was);
  vi.restoreAllMocks();
  await t.close();
});

async function connect(start: "look" | "make" = "make"): Promise<Client> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: `zz-test ${start}`, start } });
  if (!t.app.server.listening) await t.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (t.app.server.address() as AddressInfo).port;
  const client = new Client({ name: "Claude Code", version: "2.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${res.json().token as string}` } } }));
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
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const png = (w = 24, h = 16) => makePng(w, h, [10, 20, 30], [200, 10, 10]);
const row = (id: string) => t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const hex = () => randomUUID().replace(/-/g, "");

describe("upload", () => {
  it("takes a picture's bytes through the web upload's path, then sets it as a draft's reference", async () => {
    const c = await connect();
    const p = (await post(t.app, "/api/projects", { name: "zz-test place" })).json();
    const up = await ok(c, "upload", { data: b64(png()), name: "zz-test lamp", project: p.id });
    expect(up).toMatchObject({ kind: "image", name: "zz-test lamp", width: 24, height: 16, kept: true, folder: p.folderId });
    expect(JSON.stringify(up)).not.toMatch(/assets[\\/]|file_key|path/);
    expect((await row(up.item)).origin).toBe("uploaded");
    // a data: address is taken as it is
    expect((await ok(c, "upload", { data: `data:image/png;base64,${b64(png(8, 8))}` })).width).toBe(8);
    const form = t.services.registry.recipes().find((r) => r.inputs.some((i) => i.type === "references"))!;
    const refs = form.inputs.find((i) => i.type === "references") as { id: string; roles: readonly string[] };
    const d = await ok(c, "new_draft", { form: form.id });
    const edited = await ok(c, "edit_draft", { draft: d.id, set: { [refs.id]: [{ asset: up.item, role: refs.roles[0] }] } });
    expect(edited.draft.values[refs.id]).toEqual([expect.objectContaining({ asset: up.item })]);
    await c.close();
  });

  it("refuses what is no base64, no picture, a file past its cap or the day's, a second file while one comes, and a token that only looks", async () => {
    const c = await connect();
    await refused(c, "upload", { data: "not base64 at all!" }, /not base64/);
    await refused(c, "upload", { data: b64(Buffer.from("zz-test plain words, no picture")) }, /not an image, a video or an audio file/);
    uploadLimits.file = 500;
    await refused(c, "upload", { data: b64(png(64, 64)) }, /at most 1 kB a file/);
    uploadLimits.file = was.file;
    // what was sent counts, taken in or refused: the refused words above count too
    uploadLimits.day = 100;
    await refused(c, "upload", { data: b64(png()) }, /may still upload today/);
    uploadLimits.day = was.day;
    // an import from an address holds the token's one file at a time
    const importing = c.callTool({ name: "import_from_url", arguments: { url: SLOW_URL } });
    await vi.waitFor(() => expect(slow.asked).toBe(true));
    await refused(c, "upload", { data: b64(png()) }, /one at a time/);
    slow.go();
    expect((await importing).isError).toBeFalsy();
    const look = await connect("look");
    await refused(look, "upload", { data: b64(png()) }, /needs Make/);
    await look.close();
    await c.close();
  });

  it("takes a call past the app's 8 MB once its token is known, and turns one without a token away first", async () => {
    const c = await connect();
    // 12 MB of zeros: read by the tool (no picture), not refused by the body's size
    await refused(c, "upload", { data: "A".repeat(12 * 2 ** 20) }, /not an image, a video or an audio file/);
    await c.close();
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upload", arguments: { data: "A".repeat(12 * 2 ** 20) } } };
    const res = await t.app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: JSON.stringify(call) });
    expect(res.statusCode).toBe(401);
  });

  it.skipIf(!ffmpegThere)("refuses a DASH manifest, sent as its bytes, before ffmpeg opens what it names", async () => {
    const c = await connect();
    const dir = await mkdtemp(join(tmpdir(), "afflatus-zz-dash-"));
    try {
      const there = join(dir, "elsewhere.mp4").replace(/\\/g, "/");
      await writeFile(there, clip);
      const mpd = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1000"><BaseURL>file:${there}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
      await refused(c, "upload", { data: b64(Buffer.from(mpd)) }, /not an image, a video or an audio file/);
      // a real video goes in, its frames read
      expect(await ok(c, "upload", { data: b64(clip), name: "zz-test pattern" })).toMatchObject({ kind: "video", width: 160, hasSound: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await c.close();
  }, FFMPEG_TIMEOUT);
});

describe("the library's own makings", () => {
  it("mirrors a picture beside it, and refuses a video", async () => {
    const c = await connect();
    const up = await ok(c, "upload", { data: b64(png()), name: "zz-test arrow" });
    const m = await ok(c, "mirror", { item: up.item });
    expect(m).toMatchObject({ kind: "image", width: 24, height: 16, kept: true });
    expect(m.item).not.toBe(up.item);
    expect((await row(m.item)).source_id).toBe(up.item);
    await c.close();
  });

  it.skipIf(!ffmpegThere)("takes a video's sound out as its own item, and makes the video without it", async () => {
    const c = await connect();
    const v = await ok(c, "upload", { data: b64(clip), name: "zz-test pattern" });
    const sound = await ok(c, "extract_sound", { item: v.item });
    expect(sound).toMatchObject({ kind: "audio", kept: true });
    const silent = await ok(c, "remove_sound", { item: v.item });
    expect(silent).toMatchObject({ kind: "video", hasSound: false });
    await refused(c, "remove_sound", { item: silent.item }, /no sound to remove/);
    await refused(c, "extract_sound", { item: sound.item }, /takes a video/);
    await refused(c, "mirror", { item: v.item }, /only a picture/);
    await c.close();
  }, FFMPEG_TIMEOUT);

  // release review 0.9.0, B3: a video lasts as long as its picture since #207; its sound item lasts as long as the sound
  it.skipIf(!ffmpegThere)("files a sound running past its video's picture at the sound's own length", async () => {
    const c = await connect();
    const longer = await ffmpegMade(["-f", "lavfi", "-i", "testsrc2=size=160x96:rate=12:duration=1", "-f", "lavfi", "-i", "sine=frequency=330:duration=2.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
    const v = await ok(c, "upload", { data: b64(longer), name: "zz-test longer sound" });
    expect((await row(v.item)).duration_ms).toBeLessThan(1200);
    const sound = await ok(c, "extract_sound", { item: v.item });
    expect((await row(sound.item)).duration_ms).toBeGreaterThan(2300);
    await c.close();
  }, FFMPEG_TIMEOUT);
});

describe("places", () => {
  it("deletes a folder with nothing in it deleted, archives and deletes a project with what it held to the Inbox, and leaves a linked folder linked", async () => {
    const c = await connect();
    const p = await ok(c, "new_project", { name: "zz-test show" });
    const outer = await ok(c, "new_folder", { name: "zz-test outer", project: p.id });
    const inner = await ok(c, "new_folder", { name: "zz-test inner", parent: outer.id });
    const up = await ok(c, "upload", { data: b64(png()), folder: inner.id });
    const gone = await ok(c, "delete_folder", { folder: inner.id });
    expect(gone).toMatchObject({ deleted: inner.id, movedTo: outer.id });
    expect((await row(up.item)).folder_id).toBe(outer.id);
    expect((await row(up.item)).deleted_at).toBeNull();
    // a project archived, back, then deleted: its folders, drafts and timelines in the Inbox
    expect(await ok(c, "archive_project", { project: p.id })).toMatchObject({ archived: true });
    expect(await ok(c, "archive_project", { project: p.id, archived: false })).toMatchObject({ archived: false });
    // a draft with a name is written at once (a blank one waits in memory for something put in it)
    const d = await ok(c, "new_draft", { form: t.services.registry.recipes()[0]!.id, project: p.id, name: "zz-test sketch" });
    const tl = await ok(c, "new_timeline", { name: "zz-test reel", project: p.id });
    await ok(c, "delete_project", { project: p.id });
    expect(await t.db.selectFrom("projects").select("id").where("id", "=", p.id).executeTakeFirst()).toBeUndefined();
    expect((await t.db.selectFrom("folders").select("project_id").where("id", "=", outer.id).executeTakeFirstOrThrow()).project_id).toBeNull();
    expect((await t.db.selectFrom("timelines").select("project_id").where("id", "=", tl.id).executeTakeFirstOrThrow()).project_id).toBeNull();
    expect((await t.db.selectFrom("drafts").select("project_id").where("id", "=", d.id).executeTakeFirstOrThrow()).project_id).toBeNull();
    expect((await row(up.item)).deleted_at).toBeNull();
    // a folder of the disk: read again, never unlinked from here
    const disk = await mkdtemp(join(tmpdir(), "afflatus-zz-linked-"));
    try {
      await writeFile(join(disk, "zz-test.png"), png());
      const linked = hex();
      await t.db.insertInto("folders").values({ id: linked, owner_id: "local", parent_id: null, name: "zz-test disk", path: disk, project_id: null, created_at: new Date().toISOString() }).execute();
      await t.services.linked.load?.();
      expect(await ok(c, "look_again", { folder: linked })).toMatchObject({ folder: linked, files: 1 });
      await refused(c, "delete_folder", { folder: linked }, /unlinking it stays in Afflatus/);
      expect(await t.db.selectFrom("folders").select("path").where("id", "=", linked).executeTakeFirst()).toMatchObject({ path: disk });
      await refused(c, "look_again", { folder: outer.id }, /not linked/);
    } finally {
      await rm(disk, { recursive: true, force: true });
    }
    const look = await connect("look");
    for (const [name, args] of [["delete_folder", { folder: outer.id }], ["archive_project", { project: "x" }], ["delete_project", { project: "x" }], ["look_again", { folder: outer.id }]] as const) await refused(look, name, args, /needs Make/);
    await look.close();
    await c.close();
  });
});

describe("the Prompt kit", () => {
  it("deletes an item, its uploaded picture to the bin and the casts letting go of it; a shipped preset is refused", async () => {
    const c = await connect();
    const pic = (await t.app.inject({ method: "POST", url: "/api/assets?as=kit", headers: { "content-type": "image/png" }, payload: Buffer.from(png()) })).json() as { id: string };
    const person = await ok(c, "new_kit_item", { kind: "person", name: "zz-test Iris", def: { pictures: [pic.id], sentence: "a woman with red hair" } });
    const tl = await ok(c, "new_timeline", { name: "zz-test cast" });
    await t.db.updateTable("timelines").set({ look: JSON.stringify({ cast: [{ id: person.id }], places: [], style: null, snippets: [] }) }).where("id", "=", tl.id).execute();
    const gone = await ok(c, "delete_kit_item", { item: "@zz_test_Iris" });
    expect(gone).toMatchObject({ deleted: person.id, kind: "person", name: "zz-test Iris" });
    expect(await t.db.selectFrom("entities").select("id").where("id", "=", person.id).executeTakeFirst()).toBeUndefined();
    expect((await row(pic.id)).deleted_at).not.toBeNull();
    await refused(c, "delete_kit_item", { item: person.id }, /no|not found/i);
    const shipped = (await get(t.app, "/api/entities?kind=preset")).json().items.find((i: { source?: string }) => i.source === "shipped");
    if (shipped) await refused(c, "delete_kit_item", { item: shipped.id }, /ships with Afflatus/);
    await c.close();
  });
});

describe("timelines", () => {
  it("duplicates one with ids of its own (the web's route too), and deletes one named back, refusing a wrong name", async () => {
    const c = await connect();
    const tl = await ok(c, "new_timeline", { name: "zz-test reel" });
    const first = (await post(t.app, `/api/timelines/${tl.id}/clips`, {})).json().clip ?? (await post(t.app, `/api/timelines/${tl.id}/clips`, {})).json();
    const clips = await t.db.selectFrom("clips").select(["id"]).where("timeline_id", "=", tl.id).orderBy("position").execute();
    expect(clips.length).toBeGreaterThan(0);
    const clipId = clips[0]!.id;
    void first;
    const video = hex();
    await t.db.insertInto("assets").values(newAssetRow({ id: video, kind: "video", origin: "uploaded", name: "zz-test take", file_key: `assets/zz/${video}.mp4`, mime: "video/mp4", bytes: 1, width: 64, height: 64, duration_ms: 2000, has_sound: 0, created_at: new Date().toISOString() })).execute();
    const take = hex();
    await t.db.insertInto("takes").values({ id: take, clip_id: clipId, asset_id: video, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, join_kind: null, created_at: new Date().toISOString() }).execute();
    await t.db.updateTable("clips").set({ take_id: take }).where("id", "=", clipId).execute();
    await t.db.updateTable("timelines").set({ music_start_clip_id: clipId }).where("id", "=", tl.id).execute();

    const copy = await ok(c, "duplicate_timeline", { timeline: tl.id });
    expect(copy).toMatchObject({ name: "zz-test reel copy", clips: clips.length });
    expect(copy.id).not.toBe(tl.id);
    const theirs = await t.db.selectFrom("clips").selectAll().where("timeline_id", "=", copy.id).orderBy("position").execute();
    expect(theirs.map((x) => x.id)).not.toContain(clipId);
    const copiedTake = await t.db.selectFrom("takes").selectAll().where("clip_id", "=", theirs[0]!.id).executeTakeFirstOrThrow();
    expect(copiedTake.id).not.toBe(take);
    expect(copiedTake.asset_id).toBe(video);
    expect(theirs[0]!.take_id).toBe(copiedTake.id);
    expect((await t.db.selectFrom("timelines").select("music_start_clip_id").where("id", "=", copy.id).executeTakeFirstOrThrow()).music_start_clip_id).toBe(theirs[0]!.id);
    // the original as it was
    expect((await t.db.selectFrom("clips").select("take_id").where("id", "=", clipId).executeTakeFirstOrThrow()).take_id).toBe(take);
    // the web's own Duplicate
    const web = (await post(t.app, `/api/timelines/${tl.id}/duplicate`, { name: "zz-test reel B" })).json();
    expect(web).toMatchObject({ name: "zz-test reel B" });

    await refused(c, "delete_timeline", { timeline: copy.id, name: "zz-test reel" }, /not “zz-test reel”: nothing was deleted/);
    expect(await ok(c, "delete_timeline", { timeline: copy.id, name: "zz-test reel copy" })).toMatchObject({ deleted: copy.id });
    expect(await t.db.selectFrom("timelines").select("id").where("id", "=", copy.id).executeTakeFirst()).toBeUndefined();
    // its take's video stays, and so does the original
    expect((await row(video)).deleted_at).toBeNull();
    expect(await t.db.selectFrom("takes").select("id").where("id", "=", take).executeTakeFirst()).toBeTruthy();
    const look = await connect("look");
    await refused(look, "duplicate_timeline", { timeline: tl.id }, /needs Make/);
    await refused(look, "delete_timeline", { timeline: tl.id, name: "zz-test reel" }, /needs Make/);
    await look.close();
    await c.close();
  });
});

describe("storage and tidying", () => {
  it("reads the storage, bins the takes no clip plays, clears unused drafts but the one open, and dismisses a finished job", async () => {
    const c = await connect();
    const look = await connect("look");
    const st = await ok(look, "storage");
    expect(st).toMatchObject({ idleTakes: { count: 0 }, bin: { count: 0 } });
    expect(await ok(c, "bin_idle_takes")).toMatchObject({ binned: 0 });
    // a take no clip plays, beside the one that plays
    const tl = await ok(c, "new_timeline", { name: "zz-test idle" });
    await post(t.app, `/api/timelines/${tl.id}/clips`, {});
    const clipId = (await t.db.selectFrom("clips").select("id").where("timeline_id", "=", tl.id).executeTakeFirstOrThrow()).id;
    const takes: string[] = [];
    for (const name of ["zz-test plays", "zz-test idle"]) {
      const a = hex();
      await t.db.insertInto("assets").values(newAssetRow({ id: a, kind: "video", origin: "generated", name, file_key: `assets/zz/${a}.mp4`, mime: "video/mp4", bytes: 1000, width: 64, height: 64, duration_ms: 2000, has_sound: 0, kept_at: new Date().toISOString(), created_at: new Date().toISOString() })).execute();
      const take = hex();
      await t.db.insertInto("takes").values({ id: take, clip_id: clipId, asset_id: a, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, join_kind: null, created_at: new Date().toISOString() }).execute();
      takes.push(take);
    }
    await t.db.updateTable("clips").set({ take_id: takes[0]! }).where("id", "=", clipId).execute();
    expect(await ok(c, "bin_idle_takes")).toMatchObject({ binned: 1 });
    expect(await t.db.selectFrom("takes").select("id").where("id", "=", takes[1]!).executeTakeFirst()).toBeUndefined();
    expect(await t.db.selectFrom("takes").select("id").where("id", "=", takes[0]!).executeTakeFirst()).toBeTruthy();
    expect((await ok(look, "storage")).bin.count).toBe(1);
    // two unused drafts: the one open stays
    const form = t.services.registry.recipes()[0]!.id;
    const blank = (id: string) => ({ id, owner_id: "local", project_id: null, target: "new", recipe_id: form, title: "", name: null, forms: "{}", count: 1, chat: null, look: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const a = blank(hex());
    const b = blank(hex());
    for (const x of [a, b]) await t.db.insertInto("drafts").values(x as never).execute();
    await post(t.app, "/api/where", { key: "zz-test-device", path: "/", draft: b.id });
    expect(await ok(c, "clear_unused_drafts")).toMatchObject({ deleted: 1 });
    expect(await t.db.selectFrom("drafts").select("id").where("id", "=", a.id).executeTakeFirst()).toBeUndefined();
    expect(await t.db.selectFrom("drafts").select("id").where("id", "=", b.id).executeTakeFirst()).toBeTruthy();
    // a finished job off the list; one waiting refused
    const at = new Date().toISOString();
    // written as the queue's history holds them: one done, one still running (nothing picks it up: no machine answers)
    const job = (status: "done" | "running") => ({
      id: hex(), owner_id: "local", recipe_id: form, label: `zz-test ${status}`, inputs: "{}", status, warm: 0, look: null, priority: 0, depends_on: null, attempts: 0, resume: null, error: null,
      generation_id: null, clip_id: null, timeline_id: null, clip_fit: 0, finished_from: null, draft_id: null, folder_id: null, created_at: at, started_at: at, finished_at: status === "done" ? at : null, updated_at: at,
    });
    const done = job("done");
    const waiting = job("running");
    for (const j of [done, waiting]) await t.db.insertInto("jobs").values(j as never).execute();
    expect(await ok(c, "dismiss", { job: done.id })).toMatchObject({ dismissed: done.id });
    expect(await t.db.selectFrom("jobs").select("id").where("id", "=", done.id).executeTakeFirst()).toBeUndefined();
    await refused(c, "dismiss", { job: waiting.id }, /has not ended yet/);
    for (const name of ["bin_idle_takes", "clear_unused_drafts"]) await refused(look, name, {}, /needs Make/);
    await refused(look, "dismiss", { job: done.id }, /needs Make/);
    await look.close();
    await c.close();
  });
});
