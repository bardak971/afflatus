import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { writeSettings } from "../src/settings";
import { get, makeApp, makeFake, post, type TestApp } from "./helpers";

/** Model sets (modelSets.ts): named lists of model files, presets by reference and files of their own. */

let fake: FakeComfy;
let t: TestApp;
let comfyDir: string;

beforeEach(async () => {
  fake = await makeFake();
  fake.models.loras = ["have.safetensors"];
  fake.models.diffusion_models = [];
  fake.models.vae = [];
  t = await makeApp({ comfyUrl: fake.url });
  comfyDir = mkdtempSync(join(tmpdir(), "afflatus-sets-"));
  mkdirSync(join(comfyDir, "models", "loras"), { recursive: true });
  writeFileSync(join(comfyDir, "models", "loras", "mine.safetensors"), Buffer.alloc(4096, 1));
  await writeSettings(t.db, { comfyDir });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const put = (url: string, payload: Record<string, unknown>) => t.app.inject({ method: "PUT", url, payload });
/** A preset of the user's own that names two files. */
async function preset(files: unknown[]): Promise<string> {
  const res = await post(t.app, "/api/entities", { kind: "preset", name: "My H3", def: { recipe: "sdxl.text-to-picture", inputs: {}, files } });
  expect(res.statusCode).toBe(200);
  return res.json().id as string;
}
const UNET = { file: "h3_v4.safetensors", folder: "diffusion_models", civitai: { version: 77 }, size: 20 * 2 ** 30 };
const VAE = { file: "h3_vae.safetensors", folder: "vae", url: "https://huggingface.co/o/r/resolve/main/h3_vae.safetensors", size: 400 * 2 ** 20 };

describe("a model set", () => {
  it("holds presets by reference and files of its own: a preset changed changes the set, a file left out stays out", async () => {
    const id = await preset([UNET, VAE]);
    const made = await post(t.app, "/api/model-sets", { name: "Video · H3", presets: [id], files: [{ file: "have.safetensors", folder: "loras" }] });
    expect(made.statusCode).toBe(200);
    const set = made.json();
    expect(set).toMatchObject({ name: "Video · H3", count: 3, bytes: UNET.size + VAE.size, presets: [{ id, name: "My H3", accepted: true }] });
    // the preset moves to a new version of its model: the set follows
    await put(`/api/entities/${id}`, { name: "My H3", def: { recipe: "sdxl.text-to-picture", inputs: {}, files: [{ ...UNET, file: "h3_v5.safetensors" }, VAE] } });
    const files = (await get(t.app, `/api/model-sets/${set.id}/files`)).json().items as Array<{ file: string; preset?: { name: string }; off: boolean; via: string | null; on: Record<string, boolean> }>;
    expect(files.map((f) => [f.file, f.preset?.name ?? null, f.via])).toEqual([["h3_v5.safetensors", "My H3", "civitai"], ["h3_vae.safetensors", "My H3", "hf"], ["have.safetensors", null, null]]);
    // where each is: this computer's ComfyUI has the LoRA, not the preset's files
    expect(files.map((f) => Object.values(f.on)[0])).toEqual([false, false, true]);
    // a preset's file left out of the set: listed as left out, not counted
    const off = await put(`/api/model-sets/${set.id}`, { name: "Video · H3", presets: [id], files: [{ file: "have.safetensors", folder: "loras" }], off: ["vae|h3_vae.safetensors"] });
    expect(off.json()).toMatchObject({ count: 2, bytes: UNET.size });
  });

  it("is listed, duplicated and deleted", async () => {
    const a = (await post(t.app, "/api/model-sets", { name: "Pictures", files: [{ file: "a.safetensors", folder: "loras", url: "https://huggingface.co/x/resolve/main/a.safetensors" }] })).json();
    const copy = (await post(t.app, `/api/model-sets/${a.id}/duplicate`, {})).json();
    expect(copy).toMatchObject({ name: "Pictures copy", count: 1 });
    expect(((await get(t.app, "/api/model-sets")).json().items as Array<{ name: string }>).map((x) => x.name)).toEqual(["Pictures", "Pictures copy"]);
    expect((await t.app.inject({ method: "DELETE", url: `/api/model-sets/${a.id}` })).statusCode).toBe(200);
    expect((await get(t.app, `/api/model-sets/${a.id}/files`)).statusCode).toBe(404);
    // a set needs a name; a file needs a folder
    expect((await post(t.app, "/api/model-sets", { name: " ", files: [] })).statusCode).toBe(400);
    expect((await post(t.app, "/api/model-sets", { name: "x", files: [{ file: "a.safetensors" }] })).statusCode).toBe(400);
  });

  it("is saved as a file that reads anywhere, its presets written out, and brought in again", async () => {
    const id = await preset([UNET, VAE]);
    const set = (await post(t.app, "/api/model-sets", { name: "Video · H3", presets: [id], files: [{ file: "mine.safetensors", folder: "loras" }], off: ["vae|h3_vae.safetensors"] })).json();
    const res = await get(t.app, `/api/model-sets/${set.id}/export`);
    expect(res.headers["content-disposition"]).toContain("Video · H3.json".replace(/[^\w .-]+/g, "_"));
    const file = res.json();
    expect(file).toEqual({ afflatusModelSet: 1, name: "Video · H3", files: [{ ...UNET, from: "My H3" }, { file: "mine.safetensors", folder: "loras" }] });
    const back = await post(t.app, "/api/model-sets/import", file);
    expect(back.json()).toMatchObject({ name: "Video · H3", presets: [], files: [UNET, { file: "mine.safetensors", folder: "loras" }], count: 2 });
    expect((await post(t.app, "/api/model-sets/import", { name: "x" })).json().error).toMatch(/not a model set file/);
  });

  it("asks for a preset's licence before any of its files is fetched", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "Shipped", presets: ["shipped:minimax-h3"] })).json();
    expect(set.presets[0]).toMatchObject({ id: "shipped:minimax-h3", accepted: false, licence: { name: expect.stringContaining("MiniMax") } });
    const refused = await post(t.app, `/api/model-sets/${set.id}/get`, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/accept it first/);
    // accepted once: kept, as for the preset itself (downloads off here, so nothing is fetched)
    await post(t.app, `/api/model-sets/${set.id}/get`, { accept: true });
    expect(((await get(t.app, "/api/model-sets")).json().items[0].presets[0]).accepted).toBe(true);
  });

  it("sends what a rented pod lacks to it, after what its jobs wait for", async () => {
    const pod = await makeFake();
    pod.models.loras = ["have.safetensors"];
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", url: fake.url }, { id: "rp", url: pod.url, rented: { provider: "runpod", pod: "pod-1" } }] } });
      const set = (await post(t.app, "/api/model-sets", { name: "LoRAs", files: [{ file: "have.safetensors", folder: "loras" }, { ...VAE, folder: "loras" }] })).json();
      expect((await post(t.app, `/api/model-sets/${set.id}/get`, { machine: "rp" })).json()).toEqual({ sent: 1, failed: [], skipped: 0 });
      expect(t.services.podFiles.view("rp")).toEqual([expect.objectContaining({ file: VAE.file, folder: "loras", tier: "ahead", jobs: [] })]);
    } finally {
      t.services.podFiles.forget("rp");
      await pod.close();
    }
  });

  it("finds presets, families and this computer's files to add", async () => {
    await preset([UNET, VAE]);
    const found = (await get(t.app, "/api/model-sets/search?q=h3")).json();
    expect(found.presets.map((p: { name: string }) => p.name)).toContain("My H3");
    expect(found.families.map((f: { id: string }) => f.id)).toContain("h3");
    expect(found.families.find((f: { id: string }) => f.id === "h3").files[0]).toMatchObject({ folder: expect.any(String), url: expect.stringMatching(/^https:\/\//) });
    const mine = (await get(t.app, "/api/model-sets/search?q=mine")).json();
    expect(mine.files).toEqual([]);
    fake.models.loras = ["have.safetensors", "mine.safetensors"];
    expect((await get(t.app, "/api/model-sets/search?q=mine")).json().files).toEqual([{ file: "mine.safetensors", folder: "loras", size: 4096 }]);
  });
});
