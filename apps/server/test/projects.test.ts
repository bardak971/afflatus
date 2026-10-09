import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get, makeApp, type TestApp } from "./helpers";
import { makePng } from "@afflatus/comfy/testing";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const call = async (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

describe("projects", () => {
  it("is made with a root folder of its name, and renamed with it", async () => {
    const p = await call("POST", "/api/projects", { name: "Film one" });
    expect(p.folderId).toBeTruthy();
    // what is brought in while the project is on lands in its root folder; a named folder wins
    const dropped = (await t.app.inject({ method: "POST", url: `/api/assets?name=drop.png&project=${p.id}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json();
    expect(dropped.folderId).toBe(p.folderId);
    const sub = await call("POST", "/api/folders", { name: "Bin A", parentId: p.folderId });
    const placed = (await t.app.inject({ method: "POST", url: `/api/assets?name=drop2.png&project=${p.id}&folder=${sub.id}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(16, 16, [1, 2, 3], [4, 5, 6])) })).json();
    expect(placed.folderId).toBe(sub.id);
    const folders = (await get(t.app, "/api/folders")).json().items as Array<{ id: string; name: string; projectId: string | null }>;
    expect(folders.find((f) => f.id === p.folderId)).toMatchObject({ name: "Film one", projectId: p.id });
    await call("PATCH", `/api/projects/${p.id}`, { name: "Film two" });
    const again = (await get(t.app, "/api/folders")).json().items as Array<{ id: string; name: string }>;
    expect(again.find((f) => f.id === p.folderId)?.name).toBe("Film two");
  });

  it("scopes drafts, timelines and the library; a folder made inside inherits; the Inbox is the rest", async () => {
    const p = await call("POST", "/api/projects", { name: "P" });
    const q = await call("POST", "/api/projects", { name: "Q" });
    // a draft and a timeline in P, one of each in the Inbox
    const dp = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id, forms: { "sdxl.txt2img": { prompt: "x" } } });
    const d0 = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", forms: { "sdxl.txt2img": { prompt: "x" } } });
    const tp = await call("POST", "/api/timelines", { name: "In P", project: p.id });
    const t0 = await call("POST", "/api/timelines", { name: "Loose" });
    expect(tp.projectId).toBe(p.id);
    expect(tp.folderId).toBe(p.folderId);
    expect(t0.projectId).toBeNull();
    const ids = (items: Array<{ id: string }>) => items.map((x) => x.id);
    expect(ids((await get(t.app, `/api/drafts?project=${p.id}`)).json().items)).toEqual([dp.id]);
    expect(ids((await get(t.app, "/api/drafts?project=none")).json().items)).toEqual([d0.id]);
    expect(ids((await get(t.app, "/api/drafts")).json().items).sort()).toEqual([dp.id, d0.id].sort());
    expect(ids((await get(t.app, `/api/timelines?project=${p.id}`)).json().items)).toEqual([tp.id]);
    expect(ids((await get(t.app, "/api/timelines?project=none")).json().items)).toEqual([t0.id]);
    // a folder made inside P's root is P's; one made at the top with no project is the Inbox's
    const sub = await call("POST", "/api/folders", { name: "refs", parentId: p.folderId });
    const loose = await call("POST", "/api/folders", { name: "misc", parentId: null });
    expect(sub.projectId).toBe(p.id);
    expect(loose.projectId).toBeNull();
    // moved under Q's root, it becomes Q's
    await call("PATCH", `/api/folders/${sub.id}`, { parentId: q.folderId });
    const folders = (await get(t.app, "/api/folders")).json().items as Array<{ id: string; projectId: string | null }>;
    expect(folders.find((f) => f.id === sub.id)?.projectId).toBe(q.id);
    const counts = (await get(t.app, "/api/projects")).json();
    expect(counts.items.map((x: { id: string }) => x.id).sort()).toEqual([p.id, q.id].sort());
    expect(counts.items.find((x: { id: string }) => x.id === p.id)).toMatchObject({ drafts: 1, timelines: 1 });
    expect(counts.inbox).toMatchObject({ drafts: 1, timelines: 1 });
  });

  it("takes a folder to another project with the folders inside it, or out of every project", async () => {
    const p = await call("POST", "/api/projects", { name: "From" });
    const q = await call("POST", "/api/projects", { name: "To" });
    const shots = await call("POST", "/api/folders", { name: "shots", parentId: p.folderId });
    const inner = await call("POST", "/api/folders", { name: "close-ups", parentId: shots.id });
    const of = async (id: string) => ((await get(t.app, "/api/folders")).json().items as Array<{ id: string; parentId: string | null; projectId: string | null }>).find((f) => f.id === id)!;
    // into Q's root folder, as the folder menu's "Move to" does: it and what is inside it are Q's
    await call("PATCH", `/api/folders/${shots.id}`, { parentId: q.folderId });
    expect(await of(shots.id)).toMatchObject({ parentId: q.folderId, projectId: q.id });
    expect((await of(inner.id)).projectId).toBe(q.id);
    // "The Inbox": at the top, in no project
    await call("PATCH", `/api/folders/${shots.id}`, { parentId: null, project: null });
    expect(await of(shots.id)).toMatchObject({ parentId: null, projectId: null });
    expect((await of(inner.id)).projectId).toBeNull();
  });

  it("takes the timelines filed in a folder along when the folder goes to another project", async () => {
    const q = await call("POST", "/api/projects", { name: "Seaside" });
    const shots = await call("POST", "/api/folders", { name: "Harbor", parentId: null });
    const tl = await t.services.timelines.create("Harbor walk", null, shots.id);
    await call("PATCH", `/api/folders/${shots.id}`, { parentId: q.folderId });
    const row = await t.db.selectFrom("timelines").select(["project_id", "folder_id"]).where("id", "=", tl.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ project_id: q.id, folder_id: shots.id });
  });

  it("loses its root folder cleanly when that folder is deleted, and a folder moved to it lands at its top", async () => {
    const p = await call("POST", "/api/projects", { name: "Rootless" });
    const r = await t.app.inject({ method: "DELETE", url: `/api/folders/${p.folderId}` });
    expect(r.statusCode).toBe(200);
    const now = (await get(t.app, "/api/projects")).json().items.find((x: { id: string }) => x.id === p.id);
    expect(now.folderId).toBeNull();
    const loose = await call("POST", "/api/folders", { name: "loose", parentId: null });
    await call("PATCH", `/api/folders/${loose.id}`, { parentId: null, project: p.id });
    const f = ((await get(t.app, "/api/folders")).json().items as Array<{ id: string; parentId: string | null; projectId: string | null }>).find((x) => x.id === loose.id);
    expect(f).toMatchObject({ parentId: null, projectId: p.id });
  });

  it("is archived and unarchived, and deleting it sends its things to the Inbox", async () => {
    const p = await call("POST", "/api/projects", { name: "Gone" });
    const d = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id, forms: { "sdxl.txt2img": { prompt: "x" } } });
    const tl = await call("POST", "/api/timelines", { name: "T", project: p.id });
    const arch = await call("PATCH", `/api/projects/${p.id}`, { archived: true });
    expect(arch.archivedAt).toBeTruthy();
    const back = await call("PATCH", `/api/projects/${p.id}`, { archived: false });
    expect(back.archivedAt).toBeNull();
    await call("DELETE", `/api/projects/${p.id}`);
    expect((await get(t.app, "/api/projects")).json().items).toHaveLength(0);
    expect((await get(t.app, "/api/drafts?project=none")).json().items.map((x: { id: string }) => x.id)).toContain(d.id);
    expect((await get(t.app, "/api/timelines?project=none")).json().items.map((x: { id: string }) => x.id)).toContain(tl.id);
    // the root folder stays, as a plain folder
    const folders = (await get(t.app, "/api/folders")).json().items as Array<{ id: string; projectId: string | null }>;
    expect(folders.find((f) => f.id === p.folderId)).toMatchObject({ projectId: null });
  });
});
