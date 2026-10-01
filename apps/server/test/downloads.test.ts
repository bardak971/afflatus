import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@studai/comfy/testing";
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
  // the pretend Manager fetches for real: studai has to listen on a port
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
    if (req.url === "/files/soft" || req.url === "/files/plain.safetensors") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FILE.length });
      return res.end(FILE);
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

const on = () => t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: true, civitaiKey: "k-123" } });
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
    const status = (await get(t.app, "/api/setup?fresh=1")).json().recipes.find((r: { id: string }) => r.id === id);
    expect(status.missing).toEqual([{ file: "wan2.2_i2v_14B.safetensors", folder: "diffusion_models" }]);
  });
});
