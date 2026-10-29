import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withoutPaths } from "../src/downloads";
import { readSettings, updateSettings } from "../src/settings";
import { CHECKPOINT, makeApp, makeFake, type TestApp } from "./helpers";

/**
 * The models through MCP (mcpModels.ts), through the SDK's client: what each machine has, Find models, downloads with
 * their checks (the switch, a licence the user has not accepted, a pod without Spend), the downloads line, the Model sets
 * and the values saved per model file.
 */

let fake: FakeComfy;
let pod: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  fake = await makeFake();
  fake.models.loras = ["zz-test-lamp.safetensors", "zz-test-chair.safetensors"];
  pod = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  t.services.podFiles.forget("rp");
  await t.close();
  await Promise.all([fake, pod].map((x) => x.close().catch(() => {})));
});

async function connect(scopes: string[]): Promise<Client> {
  const res = await t.app.inject({ method: "POST", url: "/api/mcp/tokens", payload: { name: "zz-test models", start: "look" } });
  expect((await t.app.inject({ method: "POST", url: `/api/mcp/tokens/${res.json().view.id as string}`, payload: { scopes } })).statusCode).toBe(200);
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
  return JSON.parse(textOf(r)) as Record<string, any>;
};
const refused = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  return textOf(r);
};

const MANAGE = ["look", "make", "manage"];
/** A file of the shipped H3 preset, which comes under MiniMax's licence. */
const H3_FILE = "minimax_h3_fl2va_pruned_int8_convrot.safetensors";

describe("what the machines have", () => {
  it("lists the families, a family's slots, and a folder's files by words", async () => {
    const c = await connect(["look"]);
    const all = await ok(c, "list_models");
    const sdxl = all.families.find((f: { id: string }) => f.id === "sdxl");
    expect(sdxl.machines[0]).toMatchObject({ id: "m1", ready: true });
    expect(all.licencesAccepted).toEqual([]);
    const one = await ok(c, "list_models", { family: "sdxl" });
    expect(one.families).toHaveLength(1);
    expect(one.families[0].machines[0].slots).toBeDefined();
    const loras = await ok(c, "list_models", { folder: "loras", q: "lamp" });
    expect(loras.machines[0].files).toEqual(["zz-test-lamp.safetensors"]);
    expect(await refused(c, "list_models", { family: "nope" })).toMatch(/no model family called nope/);
    await c.close();
  });

  it("finds the user's own, and what a form lacks; Civitai and Hugging Face only with lookups on", async () => {
    const c = await connect(["look"]);
    const yours = await ok(c, "find_models", { site: "yours", q: "lamp" });
    expect(yours.files.map((f: { file: string }) => f.file)).toContain("zz-test-lamp.safetensors");
    const lacks = await ok(c, "find_models", { site: "lacks", form: "sdxl.text-to-picture", values: { prompt: "zz-test a lamp", checkpoint: CHECKPOINT } });
    expect(lacks).toMatchObject({ form: "sdxl.text-to-picture", ready: true, nodes: [] });
    expect(await refused(c, "find_models", { site: "civitai", q: "lamp" })).toMatch(/Searching Hugging Face and Civitai is off/);
    expect(await refused(c, "find_models", { site: "huggingface", q: "lamp" })).toMatch(/is off/);
    await c.close();
  });
});

describe("download", () => {
  it("goes through the downloads' own checks: refused with downloads off, and for a file under a licence the user has not accepted", async () => {
    const c = await connect(MANAGE);
    expect(await refused(c, "download", { folder: "loras", file: "zz-test.safetensors", url: "https://huggingface.co/o/r/resolve/main/zz-test.safetensors" })).toMatch(/[Dd]ownload/);
    await updateSettings(t.db, () => ({ downloadModels: true, civitaiLookups: true }));
    const said = await refused(c, "download", { folder: "diffusion_models", file: H3_FILE, url: `https://huggingface.co/x/resolve/main/${H3_FILE}` });
    expect(said).toMatch(/comes under the .*MiniMax.*the user accepts it in Afflatus/);
    expect((await readSettings(t.db)).acceptedPresets).toEqual([]);
    expect(t.services.downloads.list()).toEqual([]);
    await c.close();
  });

  it("onto a rented pod needs Spend", async () => {
    await updateSettings(t.db, () => ({ downloadModels: true, machines: [{ id: "m1", url: fake.url }, { id: "rp", url: pod.url, rented: { provider: "runpod", pod: "pod-1" } }] }));
    const c = await connect(MANAGE);
    expect(await refused(c, "download", { folder: "loras", file: "zz-test.safetensors", url: "https://huggingface.co/o/r/resolve/main/zz-test.safetensors", machine: "rp" })).toMatch(/cannot spend on rented GPUs, and .* is one: a pod fetching files is busy, billed/);
    const set = await ok(c, "edit_model_set", { action: "new", name: "zz-test set", files: [{ file: "zz-test-vae.safetensors", folder: "vae", url: "https://huggingface.co/o/r/resolve/main/zz-test-vae.safetensors" }] });
    expect(await refused(c, "edit_model_set", { action: "get", set: set.id, machine: "rp" })).toMatch(/cannot spend on rented GPUs/);
    expect(t.services.podFiles.view("rp")).toEqual([]);
    await c.close();
  });

  it("with no machine named goes to the first, a pod in a setup with rented GPUs only: needs Spend there too", async () => {
    await updateSettings(t.db, () => ({ downloadModels: true, civitaiLookups: true, machines: [{ id: "rp", url: pod.url, rented: { provider: "runpod", pod: "pod-1" } }] }));
    const c = await connect(MANAGE);
    expect(await refused(c, "download", { folder: "loras", file: "zz-test.safetensors", url: "https://huggingface.co/o/r/resolve/main/zz-test.safetensors" })).toMatch(/cannot spend on rented GPUs, and .* is one/);
    const set = await ok(c, "edit_model_set", { action: "new", name: "zz-test set", files: [{ file: "zz-test-vae.safetensors", folder: "vae", url: "https://huggingface.co/o/r/resolve/main/zz-test-vae.safetensors" }] });
    expect(await refused(c, "edit_model_set", { action: "get", set: set.id })).toMatch(/cannot spend on rented GPUs/);
    // a failed download asked again goes where it was first asked: the first machine, the pod
    vi.spyOn(t.services.downloads, "list").mockReturnValue([{ id: "d1", file: "zz-test.safetensors", folder: "loras", title: "zz-test", status: "error", bytes: 0, total: 0, error: "x" } as never]);
    vi.spyOn(t.services.downloads, "askOf").mockReturnValue({ ask: { folder: "loras", file: "zz-test.safetensors", url: "https://huggingface.co/o/r/resolve/main/zz-test.safetensors" } } as never);
    expect(await refused(c, "change_downloads", { action: "again", id: "d1" })).toMatch(/cannot spend on rented GPUs/);
    expect(t.services.podFiles.view("rp")).toEqual([]);
    vi.restoreAllMocks();
    await c.close();
  });

  it("says what went wrong without the folders on the disk", async () => {
    vi.spyOn(t.services.downloads, "list").mockReturnValue([{ id: "d1", file: "x.safetensors", folder: "loras", title: "x", status: "error", bytes: 0, total: 0, error: "EACCES: permission denied, open 'D:\\Models\\My LoRAs\\x.safetensors.part'" } as never]);
    const c = await connect(["look"]);
    const said = JSON.stringify(await ok(c, "downloads"));
    expect(said).toContain("x.safetensors.part");
    expect(said).not.toMatch(/My LoRAs|D:/);
    vi.restoreAllMocks();
    await c.close();
  });

  it("lists the downloads line without where on disk; clears it", async () => {
    const c = await connect(MANAGE);
    expect(await ok(c, "downloads")).toEqual({ downloadModels: false, items: [] });
    expect(await ok(c, "change_downloads", { action: "clear" })).toEqual({ cleared: 0 });
    expect(await refused(c, "change_downloads", { action: "cancel", id: "nope" })).toMatch(/no such download/);
    await c.close();
  });
});

describe("withoutPaths", () => {
  it("makes each path on a disk its file's name, and leaves addresses and plain words alone", () => {
    expect(withoutPaths("EACCES: permission denied, open 'D:\\models\\loras\\x.part'")).toBe("EACCES: permission denied, open 'x.part'");
    expect(withoutPaths("open \"C:\\My Models\\a b.gguf\" failed")).toBe("open \"a b.gguf\" failed");
    expect(withoutPaths("ENOENT: no such file, stat C:\\ComfyUI\\models\\vae")).toBe("ENOENT: no such file, stat vae");
    expect(withoutPaths("open /home/me/ComfyUI/models/loras/x.part failed")).toBe("open x.part failed");
    expect(withoutPaths("\\\\nas\\share\\models\\x.gguf is gone")).toBe("x.gguf is gone");
    for (const kept of ["https://huggingface.co/o/r/resolve/main/x.safetensors (404)", "ENOSPC: no space left on device, write", "(409: that file is there already)", "and/or 3/4 done"]) expect(withoutPaths(kept)).toBe(kept);
  });
});

describe("Model sets and the values per file", () => {
  it("makes, changes, lists, duplicates and deletes a set; a preset's licence not accepted is refused at Get", async () => {
    const c = await connect(MANAGE);
    const made = await ok(c, "edit_model_set", { action: "new", name: "zz-test set", files: [{ file: "zz-test-lamp.safetensors", folder: "loras" }] });
    expect(made).toMatchObject({ name: "zz-test set", count: 1 });
    const edited = await ok(c, "edit_model_set", { action: "edit", set: made.id, presets: ["shipped:minimax-h3"] });
    expect(edited.presets[0]).toMatchObject({ id: "shipped:minimax-h3", accepted: false });
    const one = await ok(c, "model_sets", { set: made.id });
    expect(one.files.find((f: { file: string }) => f.file === "zz-test-lamp.safetensors").on).toEqual({ m1: true });
    expect(await refused(c, "edit_model_set", { action: "get", set: made.id })).toMatch(/the user accepts it in Afflatus/);
    expect((await readSettings(t.db)).acceptedPresets).toEqual([]);
    const copy = await ok(c, "edit_model_set", { action: "duplicate", set: made.id });
    expect(copy.name).toBe("zz-test set copy");
    expect((await ok(c, "model_sets")).sets).toHaveLength(2);
    await ok(c, "edit_model_set", { action: "delete", set: copy.id });
    expect((await ok(c, "model_sets")).sets).toHaveLength(1);
    // Look reads, never changes
    const look = await connect(["look"]);
    expect(await refused(look, "edit_model_set", { action: "delete", set: made.id })).toMatch(/needs Manage/);
    await look.close();
    await c.close();
  });

  it("saves the values per model file the family marks per model, the rest dropped; null forgets them", async () => {
    const c = await connect(MANAGE);
    const saved = await ok(c, "change_model_settings", { family: "sdxl", file: CHECKPOINT, values: { steps: 28, prompt: "dropped" } });
    expect(saved.values).not.toHaveProperty("prompt");
    const listed = await ok(c, "model_settings", { family: "sdxl" });
    expect(listed.items).toEqual([expect.objectContaining({ family: "sdxl", file: CHECKPOINT, values: saved.values })]);
    await ok(c, "change_model_settings", { family: "sdxl", file: CHECKPOINT, values: null });
    expect((await ok(c, "model_settings")).items).toEqual([]);
    expect(await refused(c, "change_model_settings", { family: "nope", file: "x", values: {} })).toMatch(/no model family called nope/);
    await c.close();
  });
});

describe("the model files", () => {
  it("are listed with their use, read only: no tool deletes one", async () => {
    const home = mkdtempSync(join(tmpdir(), "afflatus-mcp-files-"));
    try {
      mkdirSync(join(home, "models", "loras"), { recursive: true });
      writeFileSync(join(home, "models", "loras", "zz-test-lamp.safetensors"), Buffer.alloc(2 ** 20, 1));
      await updateSettings(t.db, () => ({ comfyDir: home }));
      const c = await connect(["look"]);
      const r = await ok(c, "model_files", {});
      expect(r).toMatchObject({ readOnly: false, count: 1, files: [{ folder: "loras", file: "zz-test-lamp.safetensors", kind: "LoRA", uses: 0, lastUsed: null }] });
      expect((await c.listTools()).tools.map((x) => x.name).filter((n) => /model_file/.test(n))).toEqual(["model_files"]);
      await c.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
