import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng } from "@studai/comfy/testing";
import { newId, OWNER } from "../src/db";
import { get, makeApp, post, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

const put = (url: string, payload: unknown) => t.app.inject({ method: "PUT", url, payload: payload as object });
const patch = (url: string, payload: unknown) => t.app.inject({ method: "PATCH", url, payload: payload as object });
const del = (url: string) => t.app.inject({ method: "DELETE", url });

async function addAsset(): Promise<string> {
  const id = newId();
  await t.db
    .insertInto("assets")
    .values({
      id, owner_id: OWNER, kind: "image", origin: "generated", name: "", file_key: `assets/${id}.png`, thumb_key: null, mime: "image/png",
      bytes: 1, width: 1, height: 1, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null,
      kept_at: null, deleted_at: null, created_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

describe("model settings", () => {
  const FILE = "illustrious.safetensors";

  it("are saved per model file and listed", async () => {
    const res = await put("/api/model-settings", { family: "sdxl", file: FILE, values: { steps: 24, cfg: 4.5, quality: "masterpiece, best quality" } });
    expect(res.statusCode).toBe(200);
    await put("/api/model-settings", { family: "sdxl", file: "pony.safetensors", values: { clipSkip: 2 } });
    const { items } = (await get(t.app, "/api/model-settings")).json();
    expect(items).toHaveLength(2);
    expect(items.find((i: { file: string }) => i.file === FILE).values).toEqual({ steps: 24, cfg: 4.5, quality: "masterpiece, best quality" });
  });

  it("replace what was saved before for the same file", async () => {
    await put("/api/model-settings", { family: "sdxl", file: FILE, values: { steps: 24, cfg: 4.5 } });
    await put("/api/model-settings", { family: "sdxl", file: FILE, values: { steps: 30 } });
    expect((await get(t.app, "/api/model-settings")).json().items).toEqual([{ family: "sdxl", file: FILE, values: { steps: 30 } }]);
  });

  it("keep only what belongs to a model: not the prompt, the seed or the LoRAs", async () => {
    const res = await put("/api/model-settings", { family: "sdxl", file: FILE, values: { steps: 24, prompt: "a cat", seed: 7, loras: [], nonsense: 1 } });
    expect(res.json().values).toEqual({ steps: 24 });
  });

  it("can be removed, and refuse a family that does not exist", async () => {
    await put("/api/model-settings", { family: "sdxl", file: FILE, values: { steps: 24 } });
    await del(`/api/model-settings?family=sdxl&file=${encodeURIComponent(FILE)}`);
    expect((await get(t.app, "/api/model-settings")).json().items).toEqual([]);
    expect((await put("/api/model-settings", { family: "nope", file: FILE, values: {} })).statusCode).toBe(400);
  });
});

describe("folders", () => {
  const create = async (name: string, parentId: string | null = null) => (await post(t.app, "/api/folders", { name, parentId })).json().id as string;
  const folders = async () => (await get(t.app, "/api/folders")).json().items as Array<{ id: string; parentId: string | null; name: string; count: number }>;

  it("nest, are renamed, and count what is directly inside", async () => {
    const project = await create("Terrace project");
    const refs = await create("  Reference pictures ", project);
    const a = await addAsset();
    await post(t.app, "/api/assets/move", { ids: [a], folderId: refs });
    await patch(`/api/folders/${project}`, { name: "Terrace" });

    const list = await folders();
    expect(list.map((f) => [f.name, f.parentId, f.count])).toEqual([["Reference pictures", project, 1], ["Terrace", null, 0]]);
    expect((await post(t.app, "/api/folders", { name: "   " })).statusCode).toBe(400);
  });

  it("filter the library, and filing something keeps it", async () => {
    const f = await create("Kept things");
    const [a, b] = [await addAsset(), await addAsset()];
    expect((await post(t.app, "/api/assets/move", { ids: [a], folderId: f })).json()).toEqual({ moved: 1 });

    const inFolder = (await get(t.app, `/api/assets?folder=${f}`)).json().items;
    expect(inFolder.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(inFolder[0]).toMatchObject({ folderId: f, kept: true });
    expect((await get(t.app, "/api/assets?folder=none")).json().items.map((x: { id: string }) => x.id)).toEqual([b]);

    await post(t.app, "/api/assets/move", { ids: [a], folderId: null });
    expect((await get(t.app, `/api/assets?folder=${f}`)).json().items).toEqual([]);
    expect((await post(t.app, "/api/assets/move", { ids: [a], folderId: "nope" })).statusCode).toBe(404);
  });

  it("cannot be put inside themselves or their own subfolders", async () => {
    const top = await create("Top");
    const mid = await create("Middle", top);
    const low = await create("Low", mid);
    expect((await patch(`/api/folders/${top}`, { parentId: top })).statusCode).toBe(400);
    expect((await patch(`/api/folders/${top}`, { parentId: low })).statusCode).toBe(400);
    expect((await patch(`/api/folders/${low}`, { parentId: top })).statusCode).toBe(200);
    expect((await patch(`/api/folders/${low}`, { parentId: null })).statusCode).toBe(200);
  });

  it("move their contents up one level when deleted: nothing inside is lost", async () => {
    const top = await create("Top");
    const mid = await create("Middle", top);
    const low = await create("Low", mid);
    const a = await addAsset();
    await post(t.app, "/api/assets/move", { ids: [a], folderId: mid });

    expect((await del(`/api/folders/${mid}`)).statusCode).toBe(200);
    const list = await folders();
    expect(list.find((f) => f.id === low)!.parentId).toBe(top);
    expect(list.find((f) => f.id === top)!.count).toBe(1);
    expect((await get(t.app, `/api/assets/${a}`)).json().folderId).toBe(top);
    expect((await del(`/api/folders/${mid}`)).statusCode).toBe(404);
  });
});

describe("several items at once", () => {
  it("are kept, sent to the bin and put back together; an upload can go straight into a folder", async () => {
    const t = await makeApp();
    try {
      const folder = (await post(t.app, "/api/folders", { name: "Shoot" })).json();
      const up = async (name: string, into?: string) =>
        (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}${into ? `&folder=${into}` : ""}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(8, 8, [1, 2, 3], [4, 5, 6])) })).json();
      const a = await up("a.png", folder.id);
      const b = await up("b.png", folder.id);
      const c = await up("c.png", "no-such-folder");
      expect((await get(t.app, `/api/assets?folder=${folder.id}`)).json().items.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id].sort());
      // a folder that does not exist: the file is brought in all the same, unfiled
      expect((await get(t.app, "/api/assets?folder=none")).json().items.map((x: { id: string }) => x.id)).toEqual([c.id]);

      const bulk = async (ids: string[], action: string) => (await post(t.app, "/api/assets/bulk", { ids, action })).json();
      expect(await bulk([a.id, b.id], "unkeep")).toEqual({ changed: 2 });
      expect((await get(t.app, "/api/assets?kept=1")).json().items.map((x: { id: string }) => x.id)).toEqual([c.id]);
      // keeping what is kept already changes nothing
      expect(await bulk([a.id, c.id], "keep")).toEqual({ changed: 1 });
      expect(await bulk([a.id, b.id], "bin")).toEqual({ changed: 2 });
      expect((await get(t.app, "/api/assets")).json().items).toHaveLength(1);
      expect((await get(t.app, "/api/assets?bin=1")).json().items).toHaveLength(2);
      expect(await bulk([a.id], "restore")).toEqual({ changed: 1 });
      expect((await get(t.app, "/api/assets")).json().items).toHaveLength(2);
      expect((await post(t.app, "/api/assets/bulk", { ids: [], action: "bin" })).statusCode).toBe(400);
    } finally {
      await t.close();
    }
  });
});
