import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { shippedPresetsDir } from "../src/presetFiles";
import { get, makeApp, post, referenceCatalog, type TestApp } from "./helpers";

/**
 * Presets with files: the shipped ones (read-only, listed among the entities), which files ComfyUI has,
 * the licence accepted once, the missing files fetched only when downloads are on.
 */

let fake: FakeComfy;
let t: TestApp;

const H3_FILES = {
  diffusion_models: ["minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax_h3_ref2va_pruned_int8_convrot.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
  loras: ["there.safetensors"], checkpoints: [],
};

beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: H3_FILES, manager: true });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const entities = async () => (await get(t.app, "/api/entities")).json().items as Array<Record<string, any>>;
const files = async () => (await get(t.app, "/api/presets/files")).json() as { online: boolean; items: Array<Record<string, any>> };
const settings = async () => (await get(t.app, "/api/settings")).json();

describe("presets with files", () => {
  it("lists the shipped presets among the entities, read-only, with their files and where they come from", async () => {
    const all = await entities();
    const h3 = all.find((e) => e.id === "shipped:minimax-h3");
    expect(h3).toMatchObject({ kind: "preset", source: "shipped", name: expect.stringContaining("MiniMax H3") });
    expect(h3!.def).toMatchObject({ recipe: "h3.video", inputs: { model: "minimax_h3_fl2va_pruned_int8_convrot.safetensors" }, author: "MiniMax" });
    expect(h3!.def.files[0]).toMatchObject({ file: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", folder: "diffusion_models", url: expect.stringContaining("huggingface.co/Comfy-Org/MiniMax-H3") });
    expect(h3!.def.licence.name).toMatch(/MiniMax H3/);
    // every shipped preset names a recipe that exists and sets its model among its files
    const recipes = ((await get(t.app, "/api/recipes")).json().recipes as Array<{ id: string; inputs: Array<{ id: string; type: string }> }>);
    for (const e of all.filter((x) => x.source === "shipped")) {
      const r = recipes.find((x) => x.id === e.def.recipe);
      expect(r, e.id).toBeDefined();
      for (const i of r!.inputs.filter((x) => x.type === "model")) {
        const named = e.def.inputs[i.id];
        if (named) expect(e.def.files.map((f: { file: string }) => f.file), `${e.id} ${i.id}`).toContain(named);
      }
    }
    // only presets come with the shipped ones
    expect((await get(t.app, "/api/entities?kind=person")).json().items).toEqual([]);
    expect((await get(t.app, "/api/entities?kind=preset")).json().items.some((e: { id: string }) => e.id === "shipped:minimax-h3")).toBe(true);
    // not to be changed or deleted
    expect((await t.app.inject({ method: "PUT", url: "/api/entities/shipped:minimax-h3", payload: { name: "x" } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "DELETE", url: "/api/entities/shipped:minimax-h3" })).statusCode).toBe(400);
    // a copy is the user's own, with the files and the credit kept
    const copy = await post(t.app, "/api/entities", { kind: "preset", name: h3!.name, def: h3!.def });
    expect(copy.statusCode).toBe(200);
    expect(copy.json().def).toMatchObject({ files: h3!.def.files, author: "MiniMax", licence: h3!.def.licence });
    expect(copy.json().source).toBeUndefined();
  });

  it("loads every preset file it ships", async () => {
    // A shipped preset that no longer reads is skipped with only a warning in the log: the count says so here.
    const onDisk = readdirSync(shippedPresetsDir()).filter((n) => n.endsWith(".json"));
    expect(onDisk.length).toBeGreaterThan(0);
    const loaded = (await entities()).filter((e) => e.source === "shipped");
    expect(loaded.length).toBe(onDisk.length);
    expect(new Set(loaded.map((e) => e.id)).size).toBe(onDisk.length);
  });

  it("takes only http and https addresses for a homepage, a licence, a page or a file", async () => {
    const preset = (def: Record<string, unknown>) => post(t.app, "/api/entities", { kind: "preset", name: "Links", def: { inputs: {}, ...def } });
    expect((await preset({ homepage: "javascript:alert(1)" })).statusCode).toBe(400);
    expect((await preset({ licence: { name: "L", url: "data:text/html,x" } })).statusCode).toBe(400);
    expect((await preset({ recipe: "h3.video", files: [{ file: "a.safetensors", folder: "loras", url: "file:///etc/passwd" }] })).statusCode).toBe(400);
    expect((await preset({ homepage: "https://example.com/", licence: { name: "L", url: "http://example.com/licence" } })).statusCode).toBe(200);
  });

  it("says which files ComfyUI has, and what the family itself still misses", async () => {
    const { online, items } = await files();
    expect(online).toBe(true);
    // the official H3 file is one the fake ComfyUI has; another shipped preset's file is not
    const h3 = items.find((p) => p.id === "shipped:minimax-h3");
    expect(h3).toMatchObject({ accepted: false, files: [{ file: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", have: true }], needs: { family: "h3", name: "MiniMax H3", missing: [] } });
    expect(items.some((p) => String(p.id).startsWith("shipped:") && p.files.some((f: { have: boolean }) => !f.have))).toBe(true);
    // a preset of the user's own with files is listed too; a file the fake has counts as present
    const mine = (await post(t.app, "/api/entities", {
      kind: "preset", name: "Mine", def: { recipe: "h3.video", inputs: {}, files: [{ file: "there.safetensors", folder: "loras" }, { file: "elsewhere.safetensors", folder: "loras", url: "https://example.com/elsewhere.safetensors", optional: true }] },
    })).json();
    const st = (await files()).items.find((p) => p.id === mine.id);
    expect(st).toMatchObject({ accepted: true, files: [{ file: "there.safetensors", have: true }, { file: "elsewhere.safetensors", have: false, optional: true }] });
    // a preset without files is not in this list
    const plain = (await post(t.app, "/api/entities", { kind: "preset", name: "Plain", def: { inputs: { prompt: "x" } } })).json();
    expect((await files()).items.some((p) => p.id === plain.id)).toBe(false);
  });

  it("fetches the missing files only under an accepted licence and when downloads are on; the optional ones when asked", async () => {
    // a shipped preset with a file the fake ComfyUI does not have
    const shipped = (await files()).items.find((p) => String(p.id).startsWith("shipped:") && p.files.some((f: { have: boolean }) => !f.have))!;
    const licence = (await entities()).find((e) => e.id === shipped.id)!.def.licence.name as string;
    const refused = await post(t.app, `/api/presets/${shipped.id}/get`, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain(licence);
    // accepted, but downloads are off: said per file, the licence remembered
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: false } });
    const off = (await post(t.app, `/api/presets/${shipped.id}/get`, { accept: true })).json();
    expect(off.started).toEqual([]);
    expect(off.failed[0].error).toContain("turned off");
    expect((await settings()).acceptedPresets).toEqual([shipped.id]);
    expect((await files()).items.find((p) => p.id === shipped.id)!.accepted).toBe(true);
    // on: a preset of the user's own, one required file from a URL and one optional
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: true, civitaiLookups: true } });
    const mine = (await post(t.app, "/api/entities", {
      kind: "preset", name: "Mine", def: { recipe: "h3.video", inputs: {}, files: [
        { file: "need.safetensors", folder: "loras", url: "https://example.com/need.safetensors" },
        { file: "there.safetensors", folder: "loras", url: "https://example.com/there.safetensors" },
        { file: "extra.safetensors", folder: "loras", url: "https://example.com/extra.safetensors", optional: true },
      ] },
    })).json();
    const required = (await post(t.app, `/api/presets/${mine.id}/get`, {})).json();
    expect(required.started.map((d: { file: string; folder: string }) => [d.file, d.folder])).toEqual([["need.safetensors", "loras"]]);
    expect(required.failed).toEqual([]);
    const withOptional = (await post(t.app, `/api/presets/${mine.id}/get`, { optional: true })).json();
    expect(withOptional.started.map((d: { file: string }) => d.file)).toEqual(["need.safetensors", "extra.safetensors"]);
    expect((await post(t.app, "/api/presets/nope/get", {})).statusCode).toBe(404);
  });
});
