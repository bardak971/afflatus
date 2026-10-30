import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy, type FakeInit } from "@afflatus/comfy/testing";
import { wan } from "../../../packages/workflows/test/fixtures";
import { get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";
import { EventEmitter } from "node:events";
import { Downloads, directOk, signedLink } from "../src/downloads";

/** A pretend Civitai (and file host): one model version with one file, 300 000 bytes long, which starts as a safetensors file does. */
const FILE = Buffer.alloc(300_000, 7);
FILE.writeBigUInt64LE(2n, 0);
FILE.write("{}", 8);
let asked: Array<{ url: string; auth?: string; range?: string }>;
/** The slow file's request was given up on by Afflatus (its connection closed). */
let slowDropped: boolean;
const FILE_SHA = createHash("sha256").update(FILE).digest("hex").toUpperCase();
/**
 * A model whose files Civitai names in two ways (card #80, DaSiWa MiniMax H3 on 2026-10-25): its search calls them
 * `…_int4` / `…_int8`, its version page `…_<file id>`. Same ids, sizes and hashes.
 */
const twoNames = (listed: boolean, files: Array<{ id: number; fp: string; sha: string; url: string }> = [
  { id: 3262925, fp: "int4", sha: "A".repeat(64), url: "/files/big4" },
  { id: 3263048, fp: "int8", sha: FILE_SHA, url: "/files/big8" },
]) => ({
  id: 77, name: "Hybrid Turbo v3", baseModel: "MiniMax H3", model: { name: "DaSiWa MiniMax H3", type: "Checkpoint" },
  files: files.map((f) => ({
    id: f.id, name: `DasiwaMinimaxH3_dasiwaHybridTurboV3_${listed ? f.fp : f.id}.safetensors`, type: "Model", sizeKB: FILE.length / 1024,
    metadata: { fp: f.fp, format: "SafeTensor" }, hashes: { SHA256: f.sha }, downloadUrl: `${siteUrl}${f.url}`,
  })),
});
/** The version page as Civitai gives it in the test at hand: a file it no longer lists is left out. */
let versionPage: () => object;

/** The cut file was cut already: it is sent whole from now on. */
let cutOnce: boolean;
let site: Server;
let siteUrl: string;
let fake: FakeComfy;
let t: TestApp;
let self: string;

async function start(manager: boolean | "refuses", more: FakeInit = {}) {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [], loras: ["there.safetensors"] }, manager, ...more });
  t = await makeApp({ comfyUrl: fake.url });
  t.services.downloads.listedEveryMs = 10;
  t.services.downloads.startsWithinMs = 150;
  t.services.downloads.packEveryMs = 20;
  t.services.downloads.backoffMs = 10;
  // the pretend Manager fetches for real: Afflatus has to listen on a port
  await t.app.listen({ host: "127.0.0.1", port: 0 });
  self = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  process.env.PUBLIC_URL = self;
}

beforeEach(async () => {
  asked = [];
  slowDropped = false;
  cutOnce = false;
  versionPage = () => twoNames(false);
  site = createServer((req, res) => {
    asked.push({ url: req.url ?? "", auth: req.headers.authorization, ...(req.headers.range ? { range: req.headers.range } : {}) });
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
    if (req.url?.startsWith("/api/v1/models?")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ items: [{ id: 2877206, name: "DaSiWa MiniMax H3", type: "Checkpoint", modelVersions: [twoNames(true)] }], metadata: {} }));
    }
    if (req.url === "/api/v1/model-versions/77") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(versionPage()));
    }
    if (req.url === "/api/v1/model-versions/50") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(version(50, "v3")));
    }
    if (req.url === "/files/soft" || req.url === "/files/plain.safetensors" || req.url === "/files/big8") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FILE.length });
      return res.end(FILE);
    }
    if (req.url === "/files/cut.safetensors") {
      // cut a little way in the first time; asked again from a byte, sends the rest
      const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
      const body = FILE.subarray(from);
      res.writeHead(from ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length, ...(from ? { "content-range": `bytes ${from}-${FILE.length - 1}/${FILE.length}` } : {}) });
      if (cutOnce) return res.end(body);
      cutOnce = true;
      // the cut a moment after the first part: closed at once, Linux can hand the client the close before the bytes, and
      // the download (rightly) starts over instead of picking up where it stopped
      return res.write(body.subarray(0, 120_000), () => setTimeout(() => res.socket?.end(), 150));
    }
    if (req.url?.startsWith("/files/slow")) {
      // a first part, then nothing more for a long while: a download to stop
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FILE.length });
      res.write(FILE.subarray(0, 50_000));
      res.on("close", () => (slowDropped = true));
      return;
    }
    // a source's own signed links (signedLink): one that has expired, one that serves the file and resumes
    if (req.url?.startsWith("/signed/gone")) {
      res.writeHead(403);
      return res.end();
    }
    if (req.url?.startsWith("/signed/ok")) {
      const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
      const body = FILE.subarray(from);
      res.writeHead(from ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length, ...(from ? { "content-range": `bytes ${from}-${FILE.length - 1}/${FILE.length}` } : {}) });
      return res.end(body);
    }
    // a paid version (card #163): Civitai's 403, said in its body
    if (req.url?.startsWith("/api/download/models/88")) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Early Access", message: "This asset is in Early Access. You can use Buzz access it now!" }));
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

// fetching needs downloads on (a new install's default since card #166); with lookups off, a Download pressed still goes
const on = () => t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: true, civitaiLookups: true, civitaiKey: "k-123" } });
// both off, as an install from before 0.8.4 had them unless turned on
const off = () => t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: false, civitaiLookups: false } });
const list = async () => (await get(t.app, "/api/downloads")).json();
const done = (id: string) => until(async () => ["done", "error"].includes((await list()).items.find((d: { id: string }) => d.id === id)?.status));

describe("fetching a missing model file into ComfyUI", () => {
  it("is never done unless it was turned on", async () => {
    await start(true);
    await off();
    const res = await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("turned off");
    expect(asked).toEqual([]);
    expect(fake.calls.filter((c) => c.includes("manager"))).toEqual([]);
    // off, nothing downloads; whether ComfyUI-Manager is there is still said (node packs are installed with it): a pod's
    // Models tab greyed its Install button, its Manager running (2026-10-18). Who would download is said too: a family's
    // official file is downloaded on a press with downloads off (where you render, card #20)
    expect(await list()).toMatchObject({ on: false, items: [], manager: { found: true, version: "V4.2.1" }, via: "manager" });
  });

  it("from Civitai: Manager is handed a one-time address, the bytes are counted, and the file ends up in its folder", async () => {
    await start(true);
    await on();
    expect(await list()).toMatchObject({ on: true, manager: { found: true, version: "V4.2.1" } });
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = (await post(t.app, "/api/downloads", { file: "b.safetensors", folder: "loras", url: `${siteUrl}/files/login` })).json();
    await done(d.id);
    expect((await list()).items[0]).toMatchObject({ status: "error", error: expect.stringContaining("refused the download") });
    // in the server's log too, for when nobody had a page open
    expect(warn.mock.calls.flat().join("\n")).toMatch(/\[downloads\] b\.safetensors .*refused the download/);
    warn.mockRestore();
    expect(fake.installed).toEqual([]);
    await t.close();
    await fake.close();

    await start(false);
    await on();
    const none = (await post(t.app, "/api/downloads", { file: "c.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    expect(none).toMatchObject({ status: "error", error: expect.stringContaining("has no ComfyUI-Manager") });
    expect(await list()).toMatchObject({ manager: { found: false } });
  });

  it("says a paid Civitai version (Early Access) as paid, with its page, although the key is saved (card #163)", async () => {
    await start(true);
    await on();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = (await post(t.app, "/api/downloads", { file: "p.safetensors", folder: "loras", url: `${siteUrl}/api/download/models/88?fileId=1` })).json();
    await done(d.id);
    expect((await list()).items[0]).toMatchObject({ status: "error", error: `This version is paid on Civitai (Early Access): unlock it with Buzz on its page (${siteUrl}/model-versions/88), or pick another version.` });
    warn.mockRestore();
  });

  it("can be stopped while it runs: nothing reaches ComfyUI, and it can be started again", async () => {
    await start(true);
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/slow.safetensors` })).json();
    await until(async () => (await list()).items[0].bytes > 0);
    expect((await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` })).statusCode).toBe(200);
    expect((await list()).items[0]).toMatchObject({ status: "stopped" });
    // stopped all the way: Afflatus has let go of the file's request, and nothing of it went to ComfyUI
    await until(() => slowDropped);
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

  it("tells the queue it runs in that ComfyUI while it does, so a node pack's restart waits for it (services.ts)", async () => {
    // OwnPacks is tested with its own `downloading`; this is the wiring that gives it the real one (review O-12)
    await start(true);
    await on();
    const comfy = await t.services.comfy();
    expect(t.services.queue.downloadingIn(comfy)).toBe(false);
    const d = (await post(t.app, "/api/downloads", { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/slow.safetensors` })).json();
    await until(async () => (await list()).items[0].bytes > 0);
    expect(t.services.queue.downloadingIn(comfy)).toBe(true);
    await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` });
    expect(t.services.queue.downloadingIn(comfy)).toBe(false);
  });

  it("is asked again as it was first asked, once stopped or failed (the bar's Download again)", async () => {
    await start(true);
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/slow.safetensors` })).json();
    // not while it runs
    expect((await post(t.app, `/api/downloads/${d.id}/again`, {})).statusCode).toBe(409);
    await until(async () => (await list()).items[0].bytes > 0);
    await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` });
    expect((await list()).items[0]).toMatchObject({ id: d.id, status: "stopped", again: true });
    const again = (await post(t.app, `/api/downloads/${d.id}/again`, {})).json();
    expect(again.id).not.toBe(d.id);
    // the stopped line is gone, the new one runs under the same name
    expect((await list()).items.map((x: { id: string; file: string }) => [x.id, x.file])).toEqual([[again.id, "slow.safetensors"]]);
    await t.app.inject({ method: "DELETE", url: `/api/downloads/${again.id}` });
    expect((await post(t.app, "/api/downloads/nope/again", {})).statusCode).toBe(404);
  });

  it("of a file Civitai names otherwise on its version page than in its search: found by its hash and id, saved under the name seen", async () => {
    await start(true);
    await on();
    // picked in Find models as Nicolas did: the int8 file of the search's card, Get on this PC (getOnPc's body)
    const card = (await get(t.app, "/api/browse/civitai?q=dasiwa")).json().items[0];
    const f = card.versions[0].files.find((x: { name: string }) => x.name.endsWith("_int8.safetensors"));
    expect(f.source).toEqual({ kind: "civitai", version: 77, pick: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors", fileId: 3263048, sha256: FILE_SHA });
    const { version, pick, fileId, sha256 } = f.source;
    const res = await post(t.app, "/api/downloads", { file: f.name, folder: "diffusion_models", civitai: version, pick, fileId, sha256 });
    expect(res.statusCode).toBe(200);
    await done(res.json().id);
    expect(asked.map((a) => a.url)).toContain("/files/big8");
    expect(asked.map((a) => a.url)).not.toContain("/files/big4");
    // under the name Find models showed: "on this PC" and the forms know it by that one
    expect(fake.installed).toEqual([{ folder: "diffusion_models", file: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors", bytes: FILE.length }]);
  });

  it("of a file its version no longer lists: refused in words that say what to do, with 409", async () => {
    await start(true);
    await on();
    versionPage = () => twoNames(false, [{ id: 3262925, fp: "int4", sha: "A".repeat(64), url: "/files/big4" }]);
    const pick = "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors";
    for (const exact of [{ fileId: 3263048, sha256: FILE_SHA }, { fileId: 3263048 }, {}]) {
      const res = await post(t.app, "/api/downloads", { file: pick, folder: "diffusion_models", civitai: 77, pick, ...exact });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(`Civitai no longer lists ${pick} for this version: open it again in Find models.`);
    }
    // and a ComfyUI that is gone from the settings
    const gone = await post(t.app, "/api/downloads", { file: pick, folder: "diffusion_models", civitai: 77, pick, machine: "nope" });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error).toContain("no longer in Settings › ComfyUI");
    expect(fake.installed).toEqual([]);
  });

  it("goes with lookups off: a Download pressed, or a link pasted, is the user asking, which the switch does not cover (card #166)", async () => {
    await start(true);
    await on();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: false } });
    const d = (await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42 })).json();
    expect(d).toMatchObject({ file: "soft_light-v2.safetensors", status: "starting" });
    await done(d.id);
    expect((await list()).items[0]).toMatchObject({ status: "done" });
    expect((await post(t.app, "/api/downloads/resolve", { link: "https://civitai.com/models/9" })).statusCode).toBe(200);
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

  it("never fetches from ComfyUI's machine: allowed is the pretend Civitai, by its host and its port", async () => {
    await start(true);
    await on();
    // ComfyUI itself, and any other port of its machine: another service, whose answer would be saved as a model
    for (const url of [`${fake.url}/api/comfy/node-pack.zip?x=.safetensors`, `${self}/api/comfy/node-pack.zip`]) {
      const res = await post(t.app, "/api/downloads", { file: "x.safetensors", folder: "loras", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toContain("inside your own network");
    }
    expect(fake.calls.filter((c) => c.includes("manager/queue"))).toEqual([]);
  });

  it("passes the site's own refusal on to ComfyUI as one, so that the pack does not ask again", async () => {
    await start("refuses");
    await on();
    const d = (await post(t.app, "/api/downloads", { file: "gone.safetensors", folder: "loras", url: `${siteUrl}/files/gone.safetensors` })).json();
    const once = await fetch(fake.installAsked.at(-1)!.url);
    expect(once.status).toBe(404);
    expect((await once.json()).error).toBe("The site answered 404.");
    expect((await list()).items.find((x: { id: string }) => x.id === d.id)).toMatchObject({ status: "error", error: "The site answered 404." });
  });

  it("refuses what is not a model file or not a folder", async () => {
    await start(true);
    await on();
    const bad = async (body: Record<string, unknown>) => (await post(t.app, "/api/downloads", { url: `${siteUrl}/files/plain.safetensors`, ...body })).statusCode;
    expect(await bad({ file: "run.exe", folder: "loras" })).toBe(400);
    expect(await bad({ file: "a.safetensors", folder: "../outside" })).toBe(400);
    expect(await bad({ file: "..\\..\\a.safetensors", folder: "loras" })).toBe(400);
    // a folder of code or settings, as the pack refuses it; a control character in a name, refused before any try
    expect(await bad({ file: "a.safetensors", folder: "custom_nodes" })).toBe(400);
    expect(await bad({ file: "a.safetensors", folder: "configs" })).toBe(400);
    expect(await bad({ file: "a\u0000b.safetensors", folder: "loras" })).toBe(400);
    expect(await bad({ file: "sub\u0007/a.safetensors", folder: "loras" })).toBe(400);
    // the page kept for the file becomes a link: a web address only
    expect(await bad({ file: "a.safetensors", folder: "loras", page: { url: "javascript:alert(1)", title: "x" } })).toBe(400);
    expect(await bad({ file: "a.safetensors", folder: "loras", page: { url: "data:text/html,x", title: "x" } })).toBe(400);
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
    await off();
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
    // a name the version does not have, not even the closest: refused, 409 (the route is there, Civitai's answer changed)
    const none = await post(t.app, "/api/downloads", { file: "x.safetensors", folder: "checkpoints", civitai: 50, pick: "no_such_file.safetensors" });
    expect(none.statusCode).toBe(409);
  });
});

describe("who downloads", () => {
  let disk = "";
  beforeEach(() => {
    disk = mkdtempSync(join(tmpdir(), "afflatus-models-"));
    for (const f of ["loras", "checkpoints"]) mkdirSync(join(disk, f));
  });
  afterEach(() => rmSync(disk, { recursive: true, force: true }));
  const paths = () => ({ loras: [join(disk, "nowhere"), join(disk, "loras")], checkpoints: [join(disk, "checkpoints")] });
  const item = async (id: string) => (await list()).items.find((d: { id: string }) => d.id === id);

  it("is Afflatus itself when it can write ComfyUI's model folder: picked up after a cut, the file whole, no Manager", async () => {
    await start(true, { folderPaths: paths() });
    await on();
    expect((await list()).via).toBe("afflatus");
    const d = (await post(t.app, "/api/downloads", { file: "wan\\cut.safetensors", folder: "loras", url: `${siteUrl}/files/cut.safetensors` })).json();
    expect(d).toMatchObject({ via: "afflatus", into: expect.stringMatching(/loras[\\/]wan$/) });
    await done(d.id);
    expect(await item(d.id)).toMatchObject({ status: "done", bytes: FILE.length, total: FILE.length });
    expect(readFileSync(join(disk, "loras", "wan", "cut.safetensors")).equals(FILE)).toBe(true);
    expect(readdirSync(join(disk, "loras", "wan"))).toEqual(["cut.safetensors"]);
    // asked again from the byte it had (a little before the cut: fetch lets the last piece it held go)
    expect(asked.filter((a) => a.url === "/files/cut.safetensors").map((a) => a.range)).toEqual([undefined, expect.stringMatching(/^bytes=\d+-$/)]);
    expect(fake.installAsked).toEqual([]);
  });

  it("runs two at a time; the third says what it waits behind, and goes when one is stopped", async () => {
    await start(true, { folderPaths: paths() });
    await on();
    const ids: string[] = [];
    for (const n of ["a", "b", "c"]) ids.push((await post(t.app, "/api/downloads", { file: `${n}.safetensors`, folder: "loras", url: `${siteUrl}/files/slow-${n}.safetensors` })).json().id);
    await until(async () => (await item(ids[0]!)).bytes > 0 && (await item(ids[1]!)).bytes > 0);
    expect(await item(ids[2]!)).toMatchObject({ status: "starting", waiting: "behind a.safetensors and b.safetensors", bytes: 0 });
    await t.app.inject({ method: "DELETE", url: `/api/downloads/${ids[0]}` });
    await until(async () => (await item(ids[2]!)).bytes > 0);
    // the stopped one left nothing behind, not even its .part
    await until(() => !readdirSync(join(disk, "loras")).includes("a.safetensors.part"));
    for (const id of ids.slice(1)) await t.app.inject({ method: "DELETE", url: `/api/downloads/${id}` });
    await until(() => readdirSync(join(disk, "loras")).length === 0);
  });

  it("lands in ComfyUI's own models/<folder> though another app's folder is listed first, and in the place chosen once chosen (card #59)", async () => {
    const comfy = join(disk, "ComfyUI");
    const a1111 = join(disk, "a1111", "Lora");
    for (const d of [join(comfy, "models", "loras"), join(comfy, "custom_nodes"), a1111]) mkdirSync(d, { recursive: true });
    await start(true, { folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [a1111, join(comfy, "models", "loras")] } });
    await on();
    const first = (await post(t.app, "/api/downloads", { file: "one.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    await done(first.id);
    expect(readFileSync(join(comfy, "models", "loras", "one.safetensors")).equals(FILE)).toBe(true);
    expect((await list()).items.find((d: { id: string }) => d.id === first.id)).toMatchObject({ status: "done", shown: join("models", "loras") });
    // the page is told the places, ComfyUI's own first, and where a download goes
    const places = (await get(t.app, "/api/downloads/places")).json();
    expect(places.folders.loras).toMatchObject({ goes: join("models", "loras"), places: [{ kind: "own", ok: true }, { kind: "other", path: a1111, ok: true }] });
    // only a place ComfyUI lists is kept
    const refused = await t.app.inject({ method: "PUT", url: "/api/downloads/places", payload: { folder: "loras", path: join(disk, "elsewhere") } });
    expect(refused.statusCode).toBe(400);
    expect((await t.app.inject({ method: "PUT", url: "/api/downloads/places", payload: { folder: "loras", path: a1111 } })).statusCode).toBe(200);
    expect((await get(t.app, "/api/downloads/places")).json().folders.loras).toMatchObject({ chosen: a1111, goes: a1111 });
    const second = (await post(t.app, "/api/downloads", { file: "two.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    await done(second.id);
    expect(readFileSync(join(a1111, "two.safetensors")).equals(FILE)).toBe(true);
    // forgotten: ComfyUI's own again
    await t.app.inject({ method: "PUT", url: "/api/downloads/places", payload: { folder: "loras", path: null } });
    expect((await get(t.app, "/api/settings")).json().downloadPlaces).toEqual({});
  });

  it("refuses up front a file the disk has no room for", async () => {
    await start(true, { folderPaths: paths() });
    await on();
    t.services.downloads.free = async () => 1000;
    const res = await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Not enough free space/);
  });

  it("is the node pack on a ComfyUI Afflatus cannot write: it fetches the one-time address, and from where it stopped after a cut", async () => {
    // a ComfyUI that does not say its folders (as on another machine), with a pack that downloads
    await start(true, { folderPaths: paths(), hideFolderPaths: true });
    fake.packVersion = "0.11.0";
    await on();
    expect((await list()).via).toBe("pack");
    const d = (await post(t.app, "/api/downloads", { file: "cut.safetensors", folder: "loras", url: `${siteUrl}/files/cut.safetensors` })).json();
    expect(d.via).toBe("pack");
    await done(d.id);
    expect(await item(d.id)).toMatchObject({ status: "done", bytes: FILE.length });
    expect(readFileSync(join(disk, "nowhere", "cut.safetensors")).equals(FILE)).toBe(true);
    // the relay asked the site for the rest, as the pack asked the relay
    expect(asked.filter((a) => a.url === "/files/cut.safetensors").map((a) => a.range)).toEqual([undefined, expect.stringMatching(/^bytes=\d+-$/)]);
    expect(fake.installAsked).toEqual([]);
  });

  it("is the node pack from the source's own signed link when there is one: nothing passes through Afflatus", async () => {
    await start(true, { folderPaths: paths(), hideFolderPaths: true });
    fake.packVersion = "0.12.0";
    await on();
    const signedFor: Array<{ source: string; headers: Record<string, string> }> = [];
    t.services.downloads.signer = async (source, headers) => {
      signedFor.push({ source, headers });
      return `${siteUrl}/signed/ok?sig=1`;
    };
    const d = (await post(t.app, "/api/downloads", { file: "signed.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    await done(d.id);
    expect(await item(d.id)).toMatchObject({ status: "done", via: "pack" });
    expect(readFileSync(join(disk, "nowhere", "signed.safetensors")).equals(FILE)).toBe(true);
    // the site is Civitai here (CIVITAI_URL): its file is asked with the user's Civitai key, as Civitai's files need (keyFor)
    expect(signedFor).toEqual([{ source: `${siteUrl}/files/plain.safetensors`, headers: { Authorization: "Bearer k-123" } }]);
    // the pack fetched the signed link, never Afflatus's one-time address; Afflatus never fetched the file itself
    expect(fake.packFetched).toEqual([`${siteUrl}/signed/ok?sig=1`]);
    expect(asked.filter((a) => a.url === "/files/plain.safetensors")).toEqual([]);
  });

  it("sends the pack a fresh signed link when the first expires, and it carries on", async () => {
    await start(true, { folderPaths: paths(), hideFolderPaths: true });
    fake.packVersion = "0.12.0";
    await on();
    const links = [`${siteUrl}/signed/gone?sig=1`, `${siteUrl}/signed/ok?sig=2`];
    t.services.downloads.signer = async () => links.shift() ?? null;
    const d = (await post(t.app, "/api/downloads", { file: "renewed.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    await done(d.id);
    expect(await item(d.id)).toMatchObject({ status: "done" });
    expect(fake.packFetched).toEqual([`${siteUrl}/signed/gone?sig=1`, `${siteUrl}/signed/ok?sig=2`]);
  });

  it("is the one-time address with a pack that cannot take a signed link, or when the source gives none", async () => {
    await start(true, { folderPaths: paths(), hideFolderPaths: true });
    fake.packVersion = "0.12.0";
    await on();
    t.services.downloads.signer = async () => null;
    const d = (await post(t.app, "/api/downloads", { file: "relayed.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    await done(d.id);
    expect(fake.packFetched).toEqual([expect.stringMatching(/\/api\/downloads\/fetch\//)]);
  });

  it("is ComfyUI-Manager otherwise: a public Hugging Face address handed to it as it is, anything else through Afflatus", async () => {
    await start("refuses");
    fake.packVersion = "0.10.0";
    await on();
    expect((await list()).via).toBe("manager");
    const hf = "https://huggingface.co/Comfy-Org/x/resolve/main/split_files/loras/a.safetensors";
    const d = (await post(t.app, "/api/downloads", { file: "a.safetensors", folder: "loras", url: hf })).json();
    expect(d).toMatchObject({ via: "manager", status: "downloading", note: expect.stringMatching(/from Hugging Face itself/) });
    expect(fake.installAsked.at(-1)).toMatchObject({ url: hf, filename: "a.safetensors" });
    // it cannot be stopped from here: Manager does not say how
    expect((await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` })).statusCode).toBe(409);
    const relayed = (await post(t.app, "/api/downloads", { file: "b.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    expect(relayed).toMatchObject({ via: "manager", status: "starting" });
    expect(fake.installAsked.at(-1)!.url).toMatch(/\/api\/downloads\/fetch\//);
  });

  it("is told the folder, so Manager writes models/<folder> as the page says, and the page is offered no place it would not keep (card #59)", async () => {
    // ComfyUI on another disk, its folders not writable from here; the A1111 folder listed first, as the owner's ComfyUI lists it
    const comfy = join(disk, "elsewhere", "ComfyUI");
    const a1111 = join(disk, "elsewhere", "a1111", "Lora");
    await start("refuses", { folderPaths: { custom_nodes: [join(comfy, "custom_nodes")], loras: [a1111, join(comfy, "models", "loras")] } });
    fake.packVersion = "0.10.0";
    await on();
    const places = async () => (await get(t.app, "/api/downloads/places")).json().folders.loras;
    expect(await places()).toMatchObject({ fixed: true, goes: join("models", "loras"), places: [{ kind: "own" }, { kind: "other", path: a1111 }] });
    await post(t.app, "/api/downloads", { file: "b.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` });
    expect(fake.installAsked.at(-1)).toMatchObject({ save_path: "loras", filename: "b.safetensors" });
    // a node pack older than PACK_PLACE keeps to ComfyUI's first path whatever was chosen: said, not offered
    fake.packVersion = "0.36.8";
    expect(await places()).toMatchObject({ fixed: true, goes: a1111 });
    // one that takes the chosen place: offered, ComfyUI's own first
    fake.packVersion = "0.36.9";
    const told = await places();
    expect(told).toMatchObject({ goes: join("models", "loras") });
    expect(told.fixed).toBeUndefined();
  });

  it("is not asked of Manager a second time after a restart: handed to it, it is said interrupted, never put back in line", async () => {
    await start("refuses");
    fake.packVersion = "0.10.0";
    await on();
    const file = join(disk, "downloads.json");
    (t.services.downloads as unknown as { stateFile: string }).stateFile = file;
    const d = (await post(t.app, "/api/downloads", { file: "b.safetensors", folder: "loras", url: `${siteUrl}/files/plain.safetensors` })).json();
    expect(d).toMatchObject({ via: "manager", status: "starting" });
    await t.services.downloads.flushed();
    expect(JSON.parse(readFileSync(file, "utf8")).find((k: { id: string }) => k.id === d.id)).not.toHaveProperty("queued");
    // the next run: nothing asked again, the one Manager has said interrupted
    const next = new Downloads(new EventEmitter(), file);
    await next.restored;
    const again = vi.fn(async () => {});
    await next.resume(again);
    expect(again).not.toHaveBeenCalled();
    expect(next.list().find((x) => x.id === d.id)).toMatchObject({ status: "error", error: expect.stringMatching(/Interrupted/) });
    await next.flushed();
  });
});

describe("fetching a model file into one of several ComfyUIs", () => {
  it("says the file coming on the row of the machine it goes to, as a pod's files are said, until it is in", async () => {
    await start(true);
    const second = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [], loras: [] }, manager: true });
    try {
      await on();
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", url: fake.url }, { id: "m2", url: second.url }] } });
      const filesOf = async () => Object.fromEntries(((await get(t.app, "/api/queue")).json().machines as Array<{ id: string; files?: unknown[] }>).map((m) => [m.id, m.files ?? []]));
      // asked for no machine: the first one's
      const d = (await post(t.app, "/api/downloads", { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/slow.safetensors` })).json();
      await until(async () => (await list()).items[0].bytes > 0);
      expect(await filesOf()).toEqual({ m1: [expect.objectContaining({ file: "slow.safetensors", folder: "loras", state: "fetching", tier: "ahead" })], m2: [] });
      await t.app.inject({ method: "DELETE", url: `/api/downloads/${d.id}` });
      expect(await filesOf()).toEqual({ m1: [], m2: [] });
    } finally {
      await second.close().catch(() => {});
    }
  });

  it("goes to the machine asked for, and says so", async () => {
    await start(true);
    const second = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [], loras: [] }, manager: true });
    try {
      await on();
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ id: "m1", url: fake.url }, { id: "m2", name: "Second GPU", url: second.url }] } });
      expect((await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42, machine: "m9" })).statusCode).toBe(409);
      const d = (await post(t.app, "/api/downloads", { file: "soft_light-v2.safetensors", folder: "loras", civitai: 42, machine: "m2" })).json();
      expect(d.machine).toBe("m2");
      await done(d.id);
      expect(second.installed).toEqual([{ folder: "loras", file: "soft_light-v2.safetensors", bytes: FILE.length }]);
      expect(fake.installed).toEqual([]);
    } finally {
      await second.close().catch(() => {});
    }
  });
});


describe("a source's own signed download link", () => {
  // the sites as they answer a download: a redirect to their file servers, read here and not followed into the file
  const site = (answers: Record<string, { status: number; location?: string }>, seen: Array<{ url: string; auth?: string; method?: string }> = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: headers.Authorization, method: init?.method });
      const a = answers[url];
      if (!a) return new Response(null, { status: 404 });
      return new Response(null, { status: a.status, headers: a.location ? { location: a.location } : {} });
    }) as typeof fetch;

  it("is the file server's link Hugging Face redirects to", async () => {
    const seen: Array<{ url: string; auth?: string; method?: string }> = [];
    const hf = "https://huggingface.co/org/m/resolve/main/m.safetensors";
    const cdn = "https://us.aws.cdn.hf.co/xet-bridge-us/abc?X-Xet-Signed-Range=1&Expires=2";
    expect(await signedLink(hf, { Authorization: "Bearer hf_secret_token_1" }, site({ [hf]: { status: 302, location: cdn } }, seen))).toBe(cdn);
    // asked with HEAD, never the file itself
    expect(seen).toEqual([{ url: hf, auth: "Bearer hf_secret_token_1", method: "HEAD" }]);
  });

  it("is the R2 link Civitai redirects to, through a page of theirs, the key only to the host first asked", async () => {
    const seen: Array<{ url: string; auth?: string; method?: string }> = [];
    const api = "https://civitai.com/api/download/models/128713";
    const hop = "https://civitai.com/api/download/models/128713?type=Model&format=SafeTensor";
    const r2 = "https://civitai-delivery-worker-prod.abc.r2.cloudflarestorage.com/53515/model/x.safetensors?X-Amz-Signature=s";
    expect(await signedLink(api, { Authorization: "Bearer civitai_key_12345" }, site({ [api]: { status: 307, location: hop }, [hop]: { status: 307, location: r2 } }, seen))).toBe(r2);
    expect(seen.map((x) => x.url)).toEqual([api, hop]);
  });

  it("is the link on Civitai's own file server under civitai.com (b2.civitai.com), not taken for one of its pages", async () => {
    // as Civitai answered on 2026-10-15: one redirect, to a host under civitai.com that serves the file itself
    const seen: Array<{ url: string; auth?: string; method?: string }> = [];
    const api = "https://civitai.com/api/download/models/1691220";
    const b2 = "https://b2.civitai.com/file/civitai-modelfiles/model/6357/cyberrealisticPony.safetensors?Authorization=signed";
    expect(await signedLink(api, { Authorization: "Bearer civitai_key_12345" }, site({ [api]: { status: 307, location: b2 }, [b2]: { status: 200 } }, seen))).toBe(b2);
    expect(seen.map((x) => x.url)).toEqual([api]);
  });

  it("is none for a redirect anywhere else, one that carries the key, or a source that does not redirect", async () => {
    const api = "https://civitai.com/api/download/models/1";
    expect(await signedLink(api, {}, site({ [api]: { status: 302, location: "https://evil.example/x.safetensors" } }))).toBeNull();
    expect(await signedLink(api, {}, site({ [api]: { status: 302, location: "http://us.aws.cdn.hf.co/x" } }))).toBeNull();
    expect(await signedLink(api, { Authorization: "Bearer civitai_key_12345" }, site({ [api]: { status: 302, location: "https://x.r2.cloudflarestorage.com/f?token=civitai_key_12345" } }))).toBeNull();
    // the file served as it is: only without a key, and only on a download host
    const plain = "https://huggingface.co/org/m/resolve/main/README.md";
    expect(await signedLink(plain, {}, site({ [plain]: { status: 200 } }))).toBe(plain);
    expect(await signedLink(plain, { Authorization: "Bearer hf_secret_token_1" }, site({ [plain]: { status: 200 } }))).toBeNull();
    expect(await signedLink("https://example.com/m.safetensors", {}, site({ "https://example.com/m.safetensors": { status: 200 } }))).toBeNull();
  });

  it("says Civitai's refusal itself (a paid version), asked again in full as a HEAD has no body; a host refusing HEADs only gives none", async () => {
    const paid = `${siteUrl}/api/download/models/88?fileId=1`;
    const seen: string[] = [];
    const answers = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.method ?? "GET");
      return new Response(init?.method === "HEAD" ? null : JSON.stringify({ error: "Early Access", message: "This asset is in Early Access. You can use Buzz access it now!" }), { status: 403, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    // a rented GPU takes only such a link: told the real reason, not "no download link of its own"
    await expect(signedLink(paid, { Authorization: "Bearer civitai_key_12345" }, answers)).rejects.toThrow(/^This version is paid on Civitai \(Early Access\)/);
    expect(seen).toEqual(["HEAD", "GET"]);
    const headOnly = "https://example.com/m.safetensors";
    expect(await signedLink(headOnly, {}, (async (_: unknown, init?: RequestInit) => new Response(null, { status: init?.method === "HEAD" ? 403 : 200 })) as typeof fetch)).toBeNull();
  });

  it("is on the download hosts only", () => {
    expect(directOk("https://cas-bridge.xethub.hf.co/x")).toBe(true);
    expect(directOk("https://huggingface.co.evil.example/x")).toBe(false);
    expect(directOk("https://user:pw@huggingface.co/x")).toBe(false);
  });
});
