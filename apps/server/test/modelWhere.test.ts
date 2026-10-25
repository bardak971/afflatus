import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy, type FakeInit } from "@afflatus/comfy/testing";
import { fileManager } from "../src/modelWhere";
import { makeApp, referenceCatalog, type TestApp } from "./helpers";

/** Card #64: a model file's places on disk, and Show in folder only from this computer, for a file ComfyUI's folders hold. */
let disk: string;
let comfy: string;
let fake: FakeComfy | null;
let t: TestApp;
let shown: string[];

async function start(more: FakeInit = {}) {
  fake = await startFakeComfy({ catalog: referenceCatalog(), ...more });
  t = await makeApp({ comfyUrl: fake.url });
}

type From = { remoteAddress?: string; headers?: Record<string, string> };
const whereAll = (body: Record<string, unknown>, from: From = {}) => t.app.inject({ method: "POST", url: "/api/model-files/where", payload: body, ...from });
/** One file's places, asked as a list of one and read as the page reads its own row of the answer. */
const where = async (q: Record<string, string>, from: From = {}) => {
  const { machine, ...f } = q;
  const res = await whereAll({ files: [f], ...(machine ? { machine } : {}) }, from);
  const r = res.json();
  return { statusCode: res.statusCode, body: res.body, json: () => ({ known: r.known, reveal: r.reveal, places: r.places?.[0] }) };
};
const reveal = (body: Record<string, unknown>, from: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  t.app.inject({ method: "POST", url: "/api/model-files/reveal", payload: body, ...from });
const put = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
};

beforeEach(() => {
  disk = mkdtempSync(join(tmpdir(), "afflatus-where-"));
  comfy = join(disk, "ComfyUI");
  for (const d of ["custom_nodes", "models/loras", "models/diffusion_models", "models/unet"]) mkdirSync(join(comfy, d), { recursive: true });
  fake = null;
  shown = [];
  vi.spyOn(fileManager, "show").mockImplementation((path) => void shown.push(path));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake?.close();
  rmSync(disk, { recursive: true, force: true });
});

describe("a model file's places", () => {
  it("lists each place a file is, ComfyUI's own models/<folder> first, an older name's and an extra path's too", async () => {
    const a1111 = join(disk, "a1111", "models", "Lora");
    put(join(a1111, "soft.safetensors"));
    put(join(comfy, "models", "loras", "soft.safetensors"));
    put(join(comfy, "models", "unet", "wan", "high.safetensors"));
    // ComfyUI lists the extra path and the older name first (as the owner's did)
    await start({ folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [a1111, join(comfy, "models", "loras")], diffusion_models: [join(comfy, "models", "unet"), join(comfy, "models", "diffusion_models")] } });
    expect((await where({ folder: "loras", file: "soft.safetensors" })).json()).toEqual({
      known: true,
      reveal: true,
      places: [{ path: join(comfy, "models", "loras", "soft.safetensors"), kind: "own" }, { path: join(a1111, "soft.safetensors"), kind: "other" }],
    });
    // a sub-folder's file in the folder's older name, asked by either name
    for (const folder of ["diffusion_models", "unet"]) {
      const res = (await where({ folder, file: "wan\\high.safetensors" })).json();
      expect(res.places).toEqual([{ path: join(comfy, "models", "unet", "wan", "high.safetensors"), kind: expect.stringMatching(/own|older/) }]);
    }
    // a file it does not have: known, no place
    expect((await where({ folder: "loras", file: "gone.safetensors" })).json()).toEqual({ known: true, reveal: true, places: [] });
  });

  it("never says a path out of ComfyUI's folders: a name going up, a folder it does not list", async () => {
    put(join(comfy, "models", "secret.safetensors"));
    put(join(disk, "outside.safetensors"));
    await start({ folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [join(comfy, "models", "loras")] } });
    // a name going up is refused; a whole path (refused on Windows for its drive's colon) finds nothing either way
    for (const file of ["../secret.safetensors", "..\\..\\..\\outside.safetensors", join(disk, "outside.safetensors")]) {
      const res = await where({ folder: "loras", file });
      if (res.statusCode !== 400) expect(res.json().places, file).toEqual([]);
      expect([400, 404], file).toContain((await reveal({ folder: "loras", file })).statusCode);
    }
    // a folder ComfyUI does not list, custom_nodes
    for (const folder of ["checkpoints", "custom_nodes"]) {
      expect((await where({ folder, file: "secret.safetensors" })).json().places, folder).toEqual([]);
      expect((await reveal({ folder, file: "secret.safetensors" })).statusCode, folder).toBe(404);
    }
    // a folder name that is a path: no place, the rest of its list still answered
    const res = await whereAll({ files: [{ folder: "../models", file: "secret.safetensors" }, { folder: "loras", file: "gone.safetensors" }] });
    expect(res.json().places).toEqual([[], []]);
    expect(res.body).not.toContain("secret");
    expect(shown).toEqual([]);
  });

  it("finds nothing for a folder of dots or a name that is no model file's, with ComfyUI not saying its folders (its own folder looked in)", async () => {
    // ComfyUI's own files, in the folder set in Settings: models/.. is ComfyUI's folder itself
    put(join(comfy, "extra_model_paths.yaml"));
    put(join(comfy, "models", "loras", "notes.yaml"));
    await start({ folderPaths: {}, hideFolderPaths: true });
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyDir: comfy } });
    for (const q of [{ folder: "..", file: "extra_model_paths.yaml" }, { folder: ".", file: "extra_model_paths.yaml" }, { folder: "..", file: "x.safetensors" }, { folder: "loras", file: "notes.yaml" }]) {
      // one odd name in a list is answered with no place, not by refusing the whole list
      const res = await where(q);
      expect(res.statusCode, JSON.stringify(q)).toBe(200);
      expect(res.json().places, JSON.stringify(q)).toEqual([]);
      expect(res.body).not.toContain(comfy.replace(/\\/g, "\\\\"));
      expect((await reveal(q)).statusCode, JSON.stringify(q)).toBe(400);
    }
    // a body with more than it takes is refused, a path beside a file or beside the list
    expect((await whereAll({ files: [{ folder: "loras", file: "soft.safetensors", path: "C:\\Windows" }] })).statusCode).toBe(400);
    expect((await whereAll({ files: [{ folder: "loras", file: "soft.safetensors" }], path: "C:\\Windows" })).statusCode).toBe(400);
    expect(shown).toEqual([]);
  });

  it("reads the folder set in Settings from a ComfyUI that does not say its folders", async () => {
    put(join(comfy, "models", "loras", "soft.safetensors"));
    await start({ folderPaths: {}, hideFolderPaths: true });
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyDir: comfy } });
    expect((await where({ folder: "loras", file: "soft.safetensors" })).json().places).toEqual([{ path: join(comfy, "models", "loras", "soft.safetensors"), kind: "own" }]);
  });

  it("is not known for a ComfyUI on another machine: no path, no Show in folder", async () => {
    t = await makeApp({ comfyUrl: "http://192.0.2.10:8188" });
    expect((await where({ folder: "loras", file: "soft.safetensors" })).json()).toEqual({ known: false, places: [], reveal: false });
    expect((await whereAll({ files: [{ folder: "loras", file: "a.safetensors" }, { folder: "vae", file: "b.safetensors" }] })).json()).toEqual({ known: false, places: [[], []], reveal: false });
    expect((await reveal({ folder: "loras", file: "soft.safetensors" })).statusCode).toBe(409);
    expect(shown).toEqual([]);
  });
});

describe("a list's places in one request (card #74)", () => {
  it("answers a page's 80 files at once, each its own places in the order they were named", async () => {
    const a1111 = join(disk, "a1111", "models", "Lora");
    const names = Array.from({ length: 80 }, (_, i) => `zz-test-${String(i).padStart(2, "0")}.safetensors`);
    for (const [i, name] of names.entries()) put(i % 3 ? join(comfy, "models", "loras", name) : join(a1111, name));
    put(join(comfy, "models", "unet", "wan", "high.safetensors"));
    await start({ folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [a1111, join(comfy, "models", "loras")], diffusion_models: [join(comfy, "models", "unet"), join(comfy, "models", "diffusion_models")] } });
    const files = [...names.map((file) => ({ folder: "loras", file })), { folder: "diffusion_models", file: "wan/high.safetensors" }, { folder: "loras", file: "gone.safetensors" }, { folder: "loras", file: "notes.yaml" }];
    const res = await whereAll({ files });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r).toMatchObject({ known: true, reveal: true });
    expect(r.places).toHaveLength(files.length);
    for (const [i, name] of names.entries()) expect(r.places[i], name).toEqual([i % 3 ? { path: join(comfy, "models", "loras", name), kind: "own" } : { path: join(a1111, name), kind: "other" }]);
    expect(r.places.slice(80)).toEqual([[{ path: join(comfy, "models", "unet", "wan", "high.safetensors"), kind: expect.stringMatching(/own|older/) }], [], []]);
  });

  it("takes a list of 1 to 200 files, never more, and no longer answers one file's GET", async () => {
    await start({ folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [join(comfy, "models", "loras")] } });
    const many = (n: number) => ({ files: Array.from({ length: n }, (_, i) => ({ folder: "loras", file: `zz-test-${i}.safetensors` })) });
    expect((await whereAll(many(200))).json().places).toHaveLength(200);
    expect((await whereAll(many(201))).statusCode).toBe(400);
    expect((await whereAll(many(0))).statusCode).toBe(400);
    expect((await t.app.inject({ method: "GET", url: "/api/model-files/where?folder=loras&file=a.safetensors" })).statusCode).toBe(404);
  });
});

describe("Show in folder", () => {
  beforeEach(async () => {
    put(join(comfy, "models", "loras", "soft.safetensors"));
    put(join(disk, "extra", "soft.safetensors"));
    await start({ folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [join(disk, "extra"), join(comfy, "models", "loras")] } });
  });

  it("opens the file manager on the place asked, found again here: the page sends no path", async () => {
    expect((await reveal({ folder: "loras", file: "soft.safetensors" })).json()).toEqual({ ok: true });
    expect((await reveal({ folder: "loras", file: "soft.safetensors", at: 1 })).statusCode).toBe(200);
    expect(shown).toEqual([join(comfy, "models", "loras", "soft.safetensors"), join(disk, "extra", "soft.safetensors")]);
    // a third place it does not have, and a path sent along
    expect((await reveal({ folder: "loras", file: "soft.safetensors", at: 2 })).statusCode).toBe(404);
    expect((await reveal({ folder: "loras", file: "soft.safetensors", path: "C:\\Windows" })).statusCode).toBe(400);
    expect(shown).toHaveLength(2);
  });

  it("is refused from another computer and through a proxy, which still see the paths", async () => {
    for (const from of [{ remoteAddress: "192.168.1.20" }, { headers: { "x-forwarded-for": "203.0.113.9" } }]) {
      expect((await where({ folder: "loras", file: "soft.safetensors" }, from)).json()).toMatchObject({ known: true, reveal: false, places: [expect.anything(), expect.anything()] });
      const res = await reveal({ folder: "loras", file: "soft.safetensors" }, from);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/copy the path/);
    }
    expect(shown).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("says a file linked from elsewhere where it is listed, not where the link leads", async () => {
    const elsewhere = join(disk, "store", "big.safetensors");
    put(elsewhere);
    symlinkSync(elsewhere, join(comfy, "models", "loras", "big.safetensors"));
    expect((await where({ folder: "loras", file: "big.safetensors" })).json().places).toEqual([{ path: join(comfy, "models", "loras", "big.safetensors"), kind: "own" }]);
  });
});

