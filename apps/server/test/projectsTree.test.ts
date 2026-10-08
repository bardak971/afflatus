import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../src/db";
import { newAssetRow } from "../src/media";
import { get, makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};
/** An item of the library straight in the table: its size, its folder, its origin, in the bin or not. */
async function item(folder: string | null, bytes: number, opts: { origin?: "uploaded" | "mask" | "kit"; binned?: boolean; kind?: "image" | "video" | "audio" } = {}) {
  const id = newId();
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: opts.kind ?? "image", origin: opts.origin ?? "uploaded", name: "x.png", file_key: `assets/${id}.png`, thumb_key: null, mime: "image/png", bytes,
    width: 8, height: 8, duration_ms: null, fps: null, has_sound: 0, folder_id: folder, generation_id: null, source_id: null, deleted_at: opts.binned ? "2026-10-08T00:00:00.000Z" : null,
  })).execute();
  return id;
}
const tree = async (q?: string) => (await get(t.app, `/api/projects/tree${q !== undefined ? `?q=${encodeURIComponent(q)}` : ""}`)).json();

describe("the projects tree", () => {
  it("groups the Inbox then projects by name then archived ones, with folders under the root, counts and sizes", async () => {
    const zed = await call("POST", "/api/projects", { name: "zed" });
    const alpha = await call("POST", "/api/projects", { name: "Alpha" });
    const old = await call("POST", "/api/projects", { name: "Old" });
    await call("PATCH", `/api/projects/${old.id}`, { archived: true });
    const shots = await call("POST", "/api/folders", { name: "shots", parentId: alpha.folderId });
    const close = await call("POST", "/api/folders", { name: "close", parentId: shots.id });
    const boards = await call("POST", "/api/folders", { name: "boards", parentId: alpha.folderId });
    const loose = await call("POST", "/api/folders", { name: "loose", parentId: null });
    await item(alpha.folderId, 100);
    await item(shots.id, 20);
    await item(close.id, 3);
    await item(close.id, 1000, { origin: "mask" });
    await item(close.id, 1000, { origin: "kit" });
    await item(close.id, 5000, { binned: true });
    await item(null, 7);
    await item(loose.id, 9);
    const tl = await call("POST", "/api/timelines", { name: "Cut one", project: alpha.id });
    await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: alpha.id });
    await call("POST", "/api/drafts", { recipe: "sdxl.txt2img" });

    const r = await tree();
    // everything not in the bin, masks and kit pictures too
    expect(r.totalBytes).toBe(100 + 20 + 3 + 2000 + 7 + 9);
    expect(r.groups.map((g: { name: string }) => g.name)).toEqual(["Inbox", "Alpha", "zed", "Old"]);
    const [inbox, a, z, o] = r.groups;
    expect(inbox).toMatchObject({ id: null, kind: "inbox", archived: false, rootFolderId: null, counts: { drafts: 1, timelines: 0, items: 2 }, bytes: 16 });
    expect(inbox.folders).toEqual([{ id: loose.id, name: "loose", linked: false, items: 1, totalItems: 1, bytes: 9, children: [] }]);
    expect(inbox.drafts).toBeUndefined();
    // the root is the project itself: its items count in the project, its children are the top folders
    expect(a).toMatchObject({ id: alpha.id, kind: "project", archived: false, rootFolderId: alpha.folderId, counts: { drafts: 1, timelines: 1, items: 3 }, bytes: 123 });
    expect(a.folders.map((f: { name: string }) => f.name)).toEqual(["boards", "shots"]);
    expect(a.folders[1]).toMatchObject({ id: shots.id, items: 1, totalItems: 2, bytes: 23, children: [{ id: close.id, items: 1, totalItems: 1, bytes: 3, children: [] }] });
    expect(a.folders[0]).toMatchObject({ id: boards.id, items: 0, totalItems: 0, bytes: 0 });
    expect(a.timelines).toEqual([{ id: tl.id, name: "Cut one", folderId: alpha.folderId, clips: 0, durationMs: 0, bytes: 0, exported: false, updatedAt: expect.any(String) }]);
    expect(z).toMatchObject({ rootFolderId: zed.folderId, folders: [], counts: { items: 0 } });
    expect(o).toMatchObject({ archived: true });
  });

  it("shows a project without a root folder with its folders at the top, and gives it one", async () => {
    const p = await call("POST", "/api/projects", { name: "Rootless" });
    const keep = await call("POST", "/api/folders", { name: "keep", parentId: p.folderId });
    await item(keep.id, 50);
    await call("DELETE", `/api/folders/${p.folderId}`);
    let g = (await tree()).groups.find((x: { id: string }) => x.id === p.id);
    expect(g).toMatchObject({ rootFolderId: null, counts: { items: 1 }, bytes: 50 });
    expect(g.folders.map((f: { id: string }) => f.id)).toEqual([keep.id]);

    // a new folder named after it becomes the root
    const made = await call("POST", `/api/projects/${p.id}/root`, {});
    expect(made).toMatchObject({ id: p.id, name: "Rootless" });
    expect(made.folderId).toBeTruthy();
    g = (await tree()).groups.find((x: { id: string }) => x.id === p.id);
    expect(g.rootFolderId).toBe(made.folderId);
    expect(g.folders.map((f: { id: string }) => f.id)).toEqual([keep.id]);
    const folders = (await get(t.app, "/api/folders")).json().items as Array<{ id: string; name: string; projectId: string; parentId: string | null }>;
    expect(folders.find((f) => f.id === made.folderId)).toMatchObject({ name: "Rootless", projectId: p.id, parentId: null });

    // or one of its own folders does, put at its top
    const inner = await call("POST", "/api/folders", { name: "inner", parentId: keep.id });
    const chosen = await call("POST", `/api/projects/${p.id}/root`, { folderId: inner.id });
    expect(chosen.folderId).toBe(inner.id);
    expect(((await get(t.app, "/api/folders")).json().items as Array<{ id: string; parentId: string | null }>).find((f) => f.id === inner.id)?.parentId).toBeNull();
    g = (await tree()).groups.find((x: { id: string }) => x.id === p.id);
    expect(g.rootFolderId).toBe(inner.id);
    expect(g.folders.map((f: { id: string }) => f.id).sort()).toEqual([keep.id, made.folderId].sort());
  });

  it("refuses a root folder of another project or a linked one", async () => {
    const p = await call("POST", "/api/projects", { name: "P" });
    const q = await call("POST", "/api/projects", { name: "Q" });
    const other = await t.app.inject({ method: "POST", url: `/api/projects/${p.id}/root`, payload: { folderId: q.folderId } });
    expect(other.statusCode).toBe(400);
    await t.db.updateTable("folders").set({ path: "C:/somewhere" }).where("id", "=", p.folderId).execute();
    const linked = await t.app.inject({ method: "POST", url: `/api/projects/${p.id}/root`, payload: { folderId: p.folderId } });
    expect(linked.statusCode).toBe(400);
    const missing = await t.app.inject({ method: "POST", url: `/api/projects/${p.id}/root`, payload: { folderId: "nope" } });
    expect(missing.statusCode).toBe(400);
  });

  it("prunes to what matches when searching, ancestors kept, with the matching drafts", async () => {
    const p = await call("POST", "/api/projects", { name: "Film" });
    const q = await call("POST", "/api/projects", { name: "Other" });
    const shots = await call("POST", "/api/folders", { name: "shots", parentId: p.folderId });
    const sunset = await call("POST", "/api/folders", { name: "Sunset takes", parentId: shots.id });
    await call("POST", "/api/folders", { name: "boards", parentId: p.folderId });
    await call("POST", "/api/folders", { name: "misc", parentId: q.folderId });
    await call("POST", "/api/timelines", { name: "SUNSET cut", project: p.id });
    await call("POST", "/api/timelines", { name: "morning", project: p.id });
    const d = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id });
    await call("PUT", `/api/drafts/${d.id}`, { name: "sunset look" });
    await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id });
    await item(sunset.id, 11);

    const r = await tree("  sunset ");
    expect(r.groups.map((g: { name: string }) => g.name)).toEqual(["Film"]);
    const g = r.groups[0];
    expect(g.folders).toHaveLength(1);
    expect(g.folders[0]).toMatchObject({ id: shots.id, totalItems: 1, children: [{ id: sunset.id, name: "Sunset takes", bytes: 11 }] });
    expect(g.timelines.map((x: { name: string }) => x.name)).toEqual(["SUNSET cut"]);
    expect(g.drafts).toEqual([{ id: d.id, title: "", name: "sunset look", recipe: "sdxl.txt2img", updatedAt: expect.any(String) }]);
    // the counts stay the group's own
    expect(g.counts).toMatchObject({ drafts: 2, timelines: 2, items: 1 });
    // a group whose own name matches stays, with nothing else
    const other = (await tree("othe")).groups;
    expect(other).toEqual([expect.objectContaining({ name: "Other", folders: [], timelines: [], drafts: [] })]);
    expect((await tree("inbox")).groups.map((x: { name: string }) => x.name)).toEqual(["Inbox"]);
    // an empty search is no search; a long one is refused
    expect((await tree("")).groups[0].drafts).toBeUndefined();
    expect((await get(t.app, `/api/projects/tree?q=${"x".repeat(101)}`)).statusCode).toBe(400);
  });

  it("moves a draft to another project or the Inbox, and nothing else with it", async () => {
    const p = await call("POST", "/api/projects", { name: "P" });
    const q = await call("POST", "/api/projects", { name: "Q" });
    const d = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id });
    const tl = await call("POST", "/api/timelines", { name: "stays", project: p.id });
    expect((await call("PUT", `/api/drafts/${d.id}`, { project: q.id })).projectId).toBe(q.id);
    let r = await tree();
    expect(r.groups.find((g: { id: string }) => g.id === q.id).counts.drafts).toBe(1);
    expect(r.groups.find((g: { id: string }) => g.id === p.id).counts).toMatchObject({ drafts: 0, timelines: 1 });
    expect((await get(t.app, `/api/timelines/${tl.id}`)).json().projectId).toBe(p.id);
    expect((await call("PUT", `/api/drafts/${d.id}`, { project: null })).projectId).toBeNull();
    r = await tree();
    expect(r.groups[0].counts.drafts).toBe(1);
    const bad = await t.app.inject({ method: "PUT", url: `/api/drafts/${d.id}`, payload: { project: "nope" } });
    expect(bad.statusCode).toBe(404);
  });
});

describe("the projects tree, one kind of item", () => {
  it("counts and sizes only that kind, in folders and in groups", async () => {
    const p = await call("POST", "/api/projects", { name: "P" });
    const shots = await call("POST", "/api/folders", { name: "shots", parentId: p.folderId });
    await item(shots.id, 10);
    await item(shots.id, 200, { kind: "video" });
    await item(shots.id, 300, { kind: "video" });
    await item(p.folderId, 7, { kind: "audio" });
    const all = (await get(t.app, "/api/projects/tree")).json();
    const videos = (await get(t.app, "/api/projects/tree?kind=video")).json();
    const of = (tr: { groups: Array<{ id: string | null; counts: { items: number }; bytes: number; folders: Array<{ name: string; items: number; totalItems: number; bytes: number }> }> }) => tr.groups.find((g) => g.id === p.id)!;
    expect(of(all).counts.items).toBe(4);
    expect(of(videos)).toMatchObject({ counts: { items: 2 }, bytes: 500 });
    expect(of(videos).folders[0]).toMatchObject({ name: "shots", items: 2, totalItems: 2, bytes: 500 });
    expect(of((await get(t.app, "/api/projects/tree?kind=audio")).json())).toMatchObject({ counts: { items: 1 }, bytes: 7 });
  });
  it("refuses a kind that is not one", async () => {
    expect((await get(t.app, "/api/projects/tree?kind=mask")).statusCode).toBe(400);
  });
});
