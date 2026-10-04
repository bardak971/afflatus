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
    const dp = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id });
    const d0 = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img" });
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

  it("is archived and unarchived, and deleting it sends its things to the Inbox", async () => {
    const p = await call("POST", "/api/projects", { name: "Gone" });
    const d = await call("POST", "/api/drafts", { recipe: "sdxl.txt2img", project: p.id });
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
