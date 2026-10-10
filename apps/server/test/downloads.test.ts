import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { wan } from "../../../packages/workflows/test/fixtures";
import { get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/** A pretend Civitai (and file host): one model version with one file, 300 000 bytes long. */
const FILE = Buffer.alloc(300_000, 7);
let asked: Array<{ url: string; auth?: string }>;
let site: Server;
let siteUrl: string;
let fake: FakeComfy;
let t: TestApp;
let self: string;

async function start(manager: boolean | "refuses") {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [], loras: ["there.safetensors"] }, manager });
  t = await makeApp({ comfyUrl: fake.url });
  t.services.downloads.listedEveryMs = 10;
  t.services.downloads.startsWithinMs = 150;
  // the pretend Manager fetches for real: Afflatus has to listen on a port
  await t.app.listen({ host: "127.0.0.1", port: 0 });
  self = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  process.env.PUBLIC_URL = self;
}

beforeEach(async () => {
  asked = [];
  site = createServer((req, res) => {
    asked.push({ url: req.url ?? "", auth: req.headers.authorization });
    if (req.url === "/api/v1/model-versions/42") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        id: 42, name: "v2", model: { name: "Soft Light" },
        files: [
          { name: "notes.txt", type: "Training Data", downloadUrl: `${siteUrl}/files/notes` },
          { name: "Soft_Light-v2.safetensors", type: "Model", primary: true, sizeKB: FILE.length / 1024, downloadUrl: `${siteUrl}/files/soft` },
        ],
      }));
    }
    // a model with two versions, each in two sizes
    const version = (id: number, name: string) => ({
      id, name, modelId: 9, baseModel: "MiniMax H3", model: { name: "Some H3", type: "Checkpoint" },
      files: [
        { name: `SomeH3_${name}_int4.safetensors`, type: "Model", sizeKB: 100, metadata: { fp: "int4", format: "SafeTensor" }, downloadUrl: `${siteUrl}/files/big4` },
        { name: `SomeH3_${name}_int8.safetensors`, type: "Model", sizeKB: FILE.length / 1024, metadata: { fp: "int8", format: "SafeTensor" }, downloadUrl: `${siteUrl}/files/big8` },
      ],
    });
    if (req.url === "/api/v1/models/9") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: 9, name: "Some H3", type: "Checkpoint", modelVersions: [version(50, "v3"), version(49, "v2")] }));
    }
    if (req.url === "/api/v1/model-versions/50") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(version(50, "v3")));
    }
    if (req.url === "/files/soft" || req.url === "/files/plain.safetensors" || req.url === "/files/big8") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FILE.length });
      return res.end(FILE);
    }
    if (req.url === "/files/slow.safetensors") {
      // a first part, then nothing more for a long while: a download to stop
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FILE.length });
      res.write(FILE.subarray(0, 50_000));
      return;
    }
    if (req.url === "/files/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html>sign in</html>");
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  process.env.CIVITAI_URL = siteUrl;
});
afterEach(async () => {
  delete process.env.CIVITAI_URL;
  delete process.env.PUBLIC_URL;
  await t.close();
  await fake.close().catch(() => {});
  await new Promise((r) => site.close(r));
});

// fetching needs downloads on, and lookups on too: with lookups off Afflatus never contacts Civitai or Hugging Face
const on = () => t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: true, civitaiLookups: true, civitaiKey: "k-123" } });
const list = async () => (await get(t.app, "/api/downloads")).json();
const done = (id: string) => until(async () => ["done", "error"].includes((await list()).items.find((d: { id: string }) => d.id === id)?.status));

describe("fetching a missing model file into ComfyUI", () => {
  it("is never done unless it was turned on", async () => {
    await start(true);
    const res = await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("turned off");
    expect(asked).toEqual([]);
    expect(fake.calls.filter((c) => c.includes("manager"))).toEqual([]);
    expect(await list()).toMatchObject({ on: false, items: [], manager: { found: false } });
  });

  it("from Civitai: Manager is handed a one-time address, the bytes are counted, and the file ends up in its folder", async () => {
    await start(true);
    await on();
    expect(await list()).toMatchObject({ on: true, manager: { found: true, version: "V0.0.0-fake" } });
    const d = (await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42 })).json();
    expect(d).toMatchObject({ file: "soft_light-v2.safetensors", folder: "loras", title: "Soft Light · v2", total: FILE.length, status: "starting" });
    await done(d.id);
    expect((await list()).items[0]).toMatchObject({ status: "done", bytes: FILE.length, total: FILE.length });
    // saved under the name that was missing, in the folder ComfyUI keeps LoRAs in
    expect(fake.installed).toEqual([{ folder: "loras", file: "soft_light-v2.safetensors", bytes: FILE.length }]);
    // the key went to Civitai, with the version lookup and with the file; never to ComfyUI
    expect(asked.map((a) => [a.url, a.auth])).toEqual([["/api/v1/model-versions/42", "Bearer k-123"], ["/files/soft", "Bearer k-123"]]);
    // what the browser is told holds neither the one-time address nor the key
    expect((await get(t.app, "/api/downloads")).body).not.toMatch(/k-123|fetch\/|files\/soft/);
  });

  it("from the address a workflow gives, into a sub-folder when the file is named with one", async () => {
    await start(true);
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "wan\\high_noise.safetensors", folder: "diffusion_models", url: `${siteUrl}/files/plain.safetensors` })).json();
    await done(d.id);
    expect(fake.installed).toEqual([{ folder: "diffusion_models", file: "wan\\high_noise.safetensors", bytes: FILE.length }]);
    expect((await list()).items[0]).toMatchObject({ status: "done", title: "high_noise.safetensors" });
  });

  it("only over https outside the tests and the demo, wherever CIVITAI_URL points", async () => {
    await start(true);
    await on();
    delete process.env.AFFLATUS_PRETEND_SITES;
    try {
      const res = await post(t.app, "/api/downloads", { file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("only https URLs are downloaded");
      expect(asked).toEqual([]);
    } finally {
      process.env.AFFLATUS_PRETEND_SITES = "1";
    }
  });

  it("the one-time address works once, and only with its token", async () => {
    await start("refuses");
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    expect((await fetch(`${self}/api/downloads/fetch/${d.id}?t=wrong`)).status).toBe(404);
    expect((await fetch(`${self}/api/downloads/fetch/nope?t=x`)).status).toBe(404);
    // nobody came for it: it is given up, with what to check
    await done(d.id);
    expect((await list()).items[0]).toMatchObject({ status: "error", error: expect.stringContaining("did not start the download") });
  });

  it("says so when the site sends a sign-in page instead of the file, and when there is no Manager", async () => {
    await start(true);
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "b.safetensors", folder: "loras", url: `${siteUrl}/files/login` })).json();
    await done(d.id);
    expect((await list()).items[0]).toMatchObject({ status: "error", error: expect.stringContaining("refused the download") });
    expect(fake.installed).toEqual([]);
    await t.close();
    await fake.close();

    await start(false);
    await on();
    const none = (await post(t.app, "/api/downloads", { file: "c.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    expect(none).toMatchObject({ status: "error", error: expect.stringContaining("has no ComfyUI-Manager") });
    expect(await list()).toMatchObject({ manager: { found: false } });
  });

  it("can be stopped while it runs: nothing reaches ComfyUI, and it can be started again", async () => {
    await start(true);
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/slow.safetensors` })).json();
    await until(async () => (await list()).items[0].bytes > 0);
    expect((await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` })).statusCode).toBe(200);
    expect((await list()).items[0]).toMatchObject({ status: "stopped" });
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.installed).toEqual([]);
    // the same file can be asked for again, and a finished line can be taken off the list
    const again = (await post(t.app, "/api/downloads", { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    expect(again.id).not.toBe(d.id);
    await done(again.id);
    expect(fake.installed).toEqual([{ folder: "loras", file: "slow.safetensors", bytes: FILE.length }]);
    await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` });
    expect((await list()).items.map((x: { id: string }) => x.id)).toEqual([again.id]);
    expect((await t.app.inject({ method: "DELETE", url: "/api/downloads/nope" })).statusCode).toBe(404);
  });

  it("is never done while lookups are off either: with lookups off Afflatus contacts neither Civitai nor Hugging Face", async () => {
    await start(true);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: true } });
    const res = await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Search Hugging Face and Civitai");
    expect((await post(t.app, "/api/downloads/resolve", { link: "https://civitai.com/models/9" })).statusCode).toBe(400);
    expect(asked).toEqual([]);
  });

  it("fetches from the internet only: an address inside the network is refused before anything is asked of ComfyUI", async () => {
    await start(true);
    await on();
    for (const url of ["http://10.1.2.3/x.safetensors", "http://192.168.0.9:8080/x.safetensors", "http://169.254.169.254/latest/x.safetensors", "http://router/x.safetensors"]) {
      const res = await post(t.app, "/api/downloads", { file: "x.safetensors", folder: "loras", url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("inside your own network");
    }
    expect(fake.calls.filter((c) => c.includes("manager/queue"))).toEqual([]);
  });

  it("refuses what is not a model file or not a folder", async () => {
    await start(true);
    await on();
    const bad = async (body: Record<string, unknown>) => (await post(t.app, "/api/downloads", { url: `${siteUrl}/files/plain.safetensors`, ...body })).statusCode;
    expect(await bad({ file: "run.exe", folder: "loras" })).toBe(400);
    expect(await bad({ file: "a.safetensors", folder: "../outside" })).toBe(400);
    expect(await bad({ file: "..\\..\\a.safetensors", folder: "loras" })).toBe(400);
    expect(fake.calls.filter((c) => c.includes("install_model"))).toEqual([]);
  });
});

describe("a workflow whose model file is missing", () => {
  it("is reported with the folder the file belongs in, so that it can be fetched there", async () => {
    await start(true);
    const found = (await post(t.app, "/api/workflows/inspect", wan)).json();
    const id = (await post(t.app, "/api/workflows", { title: "Wan", model: "Wan 2.2", source: "wan.json", graph: wan, bindings: found.suggested })).json().id as string;
    fake.catalog.UNETLoader!.input.required!.unet_name = [["some-other-model.safetensors"]];
    const status = (await post(t.app, "/api/setup/rescan")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(status.missing).toEqual([{ file: "wan2.2_i2v_14B.safetensors", folder: "diffusion_models" }]);
  });
});

describe("a model from a link", () => {
  const resolve = (link: string) => post(t.app, "/api/downloads/resolve", { link });

  it("says what the link leads to: its versions, its files with their sizes, and the folder it most likely goes in", async () => {
    await start(true);
    expect((await resolve("https://civitai.red/models/9/some-h3?modelVersionId=50")).statusCode).toBe(400);
    expect(asked).toEqual([]);
    await on();

    const found = (await resolve("https://civitai.red/models/9/some-h3?modelVersionId=50")).json();
    expect(found).toMatchObject({
      source: "civitai", title: "Some H3 · v3", about: "Checkpoint · MiniMax H3", page: "https://civitai.com/models/9?modelVersionId=50",
      version: 50, versions: [{ id: 50, name: "v3" }, { id: 49, name: "v2" }],
      // Civitai calls it a checkpoint; a model of this family is the diffusion model alone
      folder: "diffusion_models", folders: ["checkpoints", "loras"], have: {},
    });
    expect(found.why).toMatch(/diffusion model alone/);
    expect(found.files).toEqual([{ name: "SomeH3_v3_int4.safetensors", bytes: 102400, note: "int4" }, { name: "SomeH3_v3_int8.safetensors", bytes: FILE.length, note: "int8" }]);
    // the page alone: its newest version; another version by its number
    expect((await resolve("https://civitai.com/models/9")).json()).toMatchObject({ version: 50 });
    expect((await resolve("https://civitai.com/models/9?modelVersionId=49")).json().files[0].name).toBe("SomeH3_v2_int4.safetensors");
    expect((await resolve("https://civitai.com/model-versions/50")).json()).toMatchObject({ version: 50, versions: [{ id: 50 }, { id: 49 }] });

    // a file on Hugging Face: its own address, and the folder its place there names
    expect((await resolve("https://huggingface.co/Comfy-Org/Krea-2/blob/main/loras/krea2_style_reference.safetensors")).json()).toMatchObject({
      source: "huggingface", title: "krea2_style_reference.safetensors", about: "Comfy-Org/Krea-2", folder: "loras",
      url: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/loras/krea2_style_reference.safetensors",
      files: [{ name: "krea2_style_reference.safetensors", bytes: 0, note: "" }],
    });
    for (const not of ["https://civitai.com/images/123", "https://huggingface.co/Comfy-Org/Krea-2", "https://example.com/a-page", "not an address"]) {
      expect((await resolve(not)).statusCode, not).toBe(400);
    }
  });

  it("fetches the file that was picked, under the name asked for, and remembers its page", async () => {
    await start(true);
    await on();
    const found = (await resolve("https://civitai.com/models/9")).json();
    const d = (await post(t.app, "/api/downloads", {
      file: "My_H3.safetensors", folder: "checkpoints", civitai: found.version, pick: "SomeH3_v3_int8.safetensors", page: { url: found.page, title: found.title },
    })).json();
    expect(d).toMatchObject({ file: "My_H3.safetensors", folder: "checkpoints", title: "Some H3 · v3", total: FILE.length });
    await done(d.id);
    expect(fake.installed).toEqual([{ folder: "checkpoints", file: "My_H3.safetensors", bytes: FILE.length }]);
    // the int8 file, not the int4 one
    expect(asked.map((a) => a.url).filter((u) => u.startsWith("/files/"))).toEqual(["/files/big8"]);
    expect((await get(t.app, "/api/models/checkpoints/pages")).json().items).toEqual({ "my_h3.safetensors": { url: "https://civitai.com/models/9?modelVersionId=50", title: "Some H3 · v3" } });
    // once there, the link says so
    expect((await resolve("https://civitai.com/models/9")).json().have).toEqual({});
    const none = await post(t.app, "/api/downloads", { file: "x.safetensors", folder: "checkpoints", civitai: 50, pick: "no_such_file.safetensors" });
    expect(none.statusCode).toBe(404);
  });
});
