import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodesOfPack, type Family } from "@afflatus/core";
import { startFakeComfy, type FakeComfy, type FakeInit } from "@afflatus/comfy/testing";
import { civitaiVersion } from "../src/civitai";
import { Comfy } from "../src/comfy";
import { NO_DIRECT, signedLink } from "../src/downloads";
import { DOWNLOADS_DISABLED } from "../src/modelDownload";
import { PodFiles } from "../src/podFiles";
import { estimateFiles, GUESSED, measuredRange, recordMeasure, MEASURED_FROM } from "../src/podMeasures";
import { forgetHuggingFace } from "../src/huggingface";
import { localCopy, measureKind, podSource, USUAL_COPIES } from "../src/podSources";
import { writeSettings } from "../src/settings";
import { families } from "@afflatus/recipes";
import { makeApp, referenceCatalog, until, type TestApp } from "./helpers";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex").toUpperCase();
/** A file on a pretend site, served from any byte asked for. */
const FILE = Buffer.alloc(200_000, 3);
/** The Civitai version whose downloads its creator disabled (card #206), and this computer's mine.safetensors' hash. */
const CLOSED = 164898;
/** A Civitai version in Early Access: its download refused with a 403 in Civitai's own words, for a while only. */
const PAID = 164899;
const MINE_SHA = sha(Buffer.alloc(150_000, 9));
let site: Server;
let siteUrl: string;
let pod: FakeComfy;
let t: TestApp;
let disk: string;
let home: string;
let files: PodFiles;

beforeEach(async () => {
  site = createServer((req, res) => {
    if (req.url?.startsWith("/signed/slow")) {
      // a first part, then nothing more: a download that stays under way
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": FILE.length });
      res.write(FILE.subarray(0, 1000));
      return;
    }
    if (req.url === "/api/v1/model-versions/77") {
      // a pretend Civitai version, its file's hash listed as Civitai lists it (capitals)
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: 77, files: [{ name: "c.safetensors", sizeKB: FILE.length / 1024, downloadUrl: `${siteUrl}/files/c.safetensors`, hashes: { SHA256: sha(FILE) } }] }));
    }
    if (req.url?.startsWith("/signed/")) {
      const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
      const body = FILE.subarray(from);
      res.writeHead(from ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length, ...(from ? { "content-range": `bytes ${from}-${FILE.length - 1}/${FILE.length}` } : {}) });
      return res.end(body);
    }
    // a Civitai version whose creator disabled downloads (card #206): its file listed, its download refused with a 401
    // whatever the key, in Civitai's own words
    if (req.url === `/api/v1/model-versions/${CLOSED}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: CLOSED, name: "v1", model: { name: "Mine" }, files: [{ name: "mine.safetensors", sizeKB: 150_000 / 1024, primary: true, downloadUrl: `${siteUrl}/api/download/models/${CLOSED}`, hashes: { SHA256: MINE_SHA } }] }));
    }
    if (req.url === `/api/v1/model-versions/${PAID}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: PAID, name: "v1", model: { name: "Mine" }, files: [{ name: "mine.safetensors", sizeKB: 150_000 / 1024, primary: true, downloadUrl: `${siteUrl}/api/download/models/${PAID}`, hashes: { SHA256: MINE_SHA } }] }));
    }
    if (req.url?.startsWith(`/api/download/models/${PAID}`)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Early Access", message: "This version is in Early Access: unlock it with Buzz" }));
    }
    if (req.url?.startsWith(`/api/download/models/${CLOSED}`)) {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "Unauthorized", message: "The creator of this asset has disabled downloads on this file" }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  process.env.CIVITAI_URL = siteUrl;
  disk = mkdtempSync(join(tmpdir(), "afflatus-pod-"));
  for (const f of ["loras", "checkpoints"]) mkdirSync(join(disk, f));
  // the pod: a ComfyUI on another machine, with the node pack that takes uploads
  pod = await startFakeComfy({ catalog: referenceCatalog(), models: { loras: [] }, folderPaths: { loras: [join(disk, "loras")], checkpoints: [join(disk, "checkpoints")] }, hideFolderPaths: true });
  pod.packVersion = "0.14.0";
  // this computer's ComfyUI folder, with a LoRA only it has
  home = mkdtempSync(join(tmpdir(), "afflatus-home-"));
  mkdirSync(join(home, "models", "loras"), { recursive: true });
  writeFileSync(join(home, "models", "loras", "mine.safetensors"), Buffer.alloc(150_000, 9));
  t = await makeApp();
  await writeSettings(t.services.db, { downloadModels: true, civitaiLookups: true, comfyDir: home });
  t.services.downloads.packEveryMs = 10;
  t.services.downloads.listedEveryMs = 10;
  // the site's own signed link for any of its addresses (signedLink asks the site): here the address itself, signed
  t.services.downloads.signer = async (source) => (source.includes("/nolink/") ? null : `${source.replace("/files/", "/signed/")}?sig=1`);
  const comfy = new Comfy(pod.url, t.services.registry);
  files = new PodFiles({
    db: t.services.db, downloads: t.services.downloads,
    comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
    lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
    settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
  });
  files.uploadBackoffMs = 10;
});

afterEach(async () => {
  delete process.env.CIVITAI_URL;
  await t.close();
  await pod.close().catch(() => {});
  // the slow file's connections are left open by the site: closed, or the close waits for them
  site.closeAllConnections();
  await new Promise((r) => site.close(r));
});

const settle = (machine: string, file: string) =>
  until(async () => {
    await files.tick();
    const v = files.view(machine).find((f) => f.file === file);
    return v?.state === "ready" || v?.state === "failed";
  });

describe("a rented pod's model files", () => {
  it("come from the site's own link straight onto the pod, and a job waiting for them is told when they are there", async () => {
    files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }], { tier: "need", job: "j1" });
    expect(files.jobState("pod", "j1")?.state).toBe("waiting");
    await settle("pod", "a.safetensors");
    expect(files.view("pod")).toEqual([expect.objectContaining({ file: "a.safetensors", state: "ready", tier: "need", via: "url", bytes: FILE.length, jobs: ["j1"] })]);
    expect(readFileSync(join(disk, "loras", "a.safetensors")).equals(FILE)).toBe(true);
    // the pack fetched the signed link: never a one-time address on Afflatus, which a pod cannot reach
    expect(pod.packFetched).toEqual([`${siteUrl}/signed/a.safetensors?sig=1`]);
    expect(files.jobState("pod", "j1")?.state).toBe("ready");
    expect(files.jobState("pod", "other")).toBeNull();
  });

  it("from Civitai are handed to the pod's node pack with the sha256 Civitai lists, for it to check the file against", async () => {
    const start = vi.spyOn(t.services.downloads, "start");
    files.want("pod", [{ file: "c.safetensors", folder: "loras", civitai: { version: 77 } }], { tier: "need" });
    await settle("pod", "c.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "civitai" });
    expect(start.mock.calls[0]?.[2]).toMatchObject({ file: "c.safetensors", sha256: sha(FILE), directOnly: true });
  });

  // card #93, #81's test pod: a model picked in a form has no address in its job's plan; the deploy's list, read once the pod is
  // up, came after with one, and was not read. The file failed, the job stayed planned there, held by that entry, the pod billed
  it("that failed with no site known come once an address is given, and a job is held only by the files it is sent for now", async () => {
    files.want("pod", [{ file: "nowhere.safetensors", folder: "loras" }, { file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }], { tier: "need", job: "j1" });
    await settle("pod", "nowhere.safetensors");
    await settle("pod", "a.safetensors");
    expect(files.view("pod").find((f) => f.file === "nowhere.safetensors")).toMatchObject({ state: "failed", error: expect.stringContaining("no site is known") });
    expect(files.jobState("pod", "j1")?.state).toBe("failed");
    // the plan sends it only a.safetensors now (nowhere.safetensors on the pod by other means): ready
    expect(files.jobState("pod", "j1", [{ file: "a.safetensors", folder: "loras" }])?.state).toBe("ready");
    // the deploy's list with its address: back in line, and fetched
    files.want("pod", [{ file: "nowhere.safetensors", folder: "loras", url: `${siteUrl}/files/nowhere.safetensors`, size: FILE.length }], { tier: "ahead" });
    expect(files.view("pod").find((f) => f.file === "nowhere.safetensors")?.state).toBe("next");
    await settle("pod", "nowhere.safetensors");
    expect(files.view("pod").find((f) => f.file === "nowhere.safetensors")).toMatchObject({ state: "ready", via: "url", jobs: ["j1"] });
    expect(files.jobState("pod", "j1")?.state).toBe("ready");
    // one left out at the deploy stays out, an address or not
    files.leaveOut("pod", [{ file: "out.safetensors", folder: "loras" }]);
    files.want("pod", [{ file: "out.safetensors", folder: "loras", url: `${siteUrl}/files/out.safetensors` }], { tier: "ahead" });
    expect(files.view("pod").find((f) => f.file === "out.safetensors")).toMatchObject({ state: "failed", error: "left out when the pod was deployed" });
  });

  it("of a gated Hugging Face model are signed with the user's token, sent to Hugging Face alone", async () => {
    const seen: Array<Record<string, string>> = [];
    t.services.downloads.signer = async (source, headers) => {
      seen.push(headers);
      return source.startsWith("https://huggingface.co/") ? `${siteUrl}/signed/gated.safetensors?sig=1` : null;
    };
    const comfy = new Comfy(pod.url, t.services.registry);
    const withToken = new PodFiles({
      db: t.services.db, downloads: t.services.downloads,
      comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true, huggingFaceToken: "hf_test_token_123" }),
    });
    withToken.want("pod", [{ file: "gated.safetensors", folder: "loras", url: "https://huggingface.co/org/gated/resolve/main/gated.safetensors" }], { tier: "need" });
    await until(async () => {
      await withToken.tick();
      return ["ready", "failed"].includes(withToken.view("pod")[0]?.state ?? "");
    });
    expect(withToken.view("pod")[0]?.state).toBe("ready");
    expect(seen).toEqual([{ Authorization: "Bearer hf_test_token_123" }]);
  });

  it("keep each one's speed, a fast one too (done before the next look), from its start to all of it on the pod", async () => {
    files.measuredFrom = 1;
    files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }, { file: "mine.safetensors", folder: "loras" }], { tier: "need" });
    await settle("pod", "a.safetensors");
    await settle("pod", "mine.safetensors");
    const kept = await t.services.db.selectFrom("pod_measures").select(["kind", "cloud", "bytes"]).orderBy("kind").execute();
    expect(kept).toEqual([{ kind: "upload", cloud: "SECURE", bytes: 150_000 }, { kind: "url", cloud: "SECURE", bytes: FILE.length }]);
    // and each file by name on its pod, from when it started to when it was whole: the Costs tab's "Fetching files"
    const fetched = await t.services.db.selectFrom("pod_fetches").selectAll().orderBy("file").execute();
    expect(fetched.map((f) => [f.machine_id, f.file, f.via, Number(f.bytes)])).toEqual([["pod", "a.safetensors", "url", FILE.length], ["pod", "mine.safetensors", "upload", 150_000]]);
    for (const f of fetched) expect(Date.parse(f.ended_at)).toBeGreaterThan(Date.parse(f.started_at));
  });

  it("fail, and their job with them, when the site gives no link of its own: a pod cannot be sent the file through Afflatus", async () => {
    files.want("pod", [{ file: "b.safetensors", folder: "loras", url: `${siteUrl}/nolink/b.safetensors` }], { tier: "need", job: "j1" });
    await settle("pod", "b.safetensors");
    expect(files.jobState("pod", "j1")).toMatchObject({ state: "failed", error: expect.stringContaining(NO_DIRECT) });
    expect(files.failed("pod", "loras", "b.safetensors")).toContain(NO_DIRECT);
    expect(pod.packFetched).toEqual([]);
  });

  it("are sent from this computer when no site is known for them, a piece cut on its way sent again", async () => {
    pod.uploadCut = 1;
    files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
    await settle("pod", "mine.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "upload", bytes: 150_000 });
    expect(readFileSync(join(disk, "loras", "mine.safetensors")).equals(Buffer.alloc(150_000, 9))).toBe(true);
    // the cut piece, then the same piece again from the same byte
    expect(pod.packUploaded.map((p) => p.offset)).toEqual([0, 0]);
  });

  it("are sent again from the start when the pod's ComfyUI restarts mid-upload and forgets it", async () => {
    files.retryMs = 10;
    // the pack keeps an upload in memory: restarted, it answers 404 for it (its stop still goes through)
    const real = globalThis.fetch;
    let forgotten: string | null = null;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const at = /\/afflatus\/upload\/([^?/]+)/.exec(String(input))?.[1];
      if (at && init?.method !== "DELETE" && (forgotten ??= at) === at) return Promise.resolve(new Response("{}", { status: 404 }));
      return real(input, init);
    }) as typeof fetch;
    try {
      files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
      await settle("pod", "mine.safetensors");
    } finally {
      globalThis.fetch = real;
    }
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "upload", bytes: 150_000 });
    expect(files.jobState("pod", "j1")?.state).toBe("ready");
  });

  it("fail when no site is known and this computer has no copy", async () => {
    files.want("pod", [{ file: "nowhere.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
    await settle("pod", "nowhere.safetensors");
    expect(files.jobState("pod", "j1")).toMatchObject({ state: "failed", error: expect.stringContaining("no site is known") });
  });

  it("of a family's own official file come with downloads and lookups off (a new install's default), any other file does not", async () => {
    await writeSettings(t.services.db, { downloadModels: false, civitaiLookups: false });
    const url = `${siteUrl}/files/official.safetensors`;
    const family = { id: "fam", slots: [{ folder: "checkpoints", get: { url, file: "official.safetensors" } }] } as unknown as Family;
    mkdirSync(join(disk, "diffusion_models"));
    pod.folderPaths!.diffusion_models = [join(disk, "diffusion_models")];
    const comfy = new Comfy(pod.url, t.services.registry);
    const off = new PodFiles({
      db: t.services.db, downloads: t.services.downloads,
      comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
      lookup: { db: t.services.db, presets: async () => [], families: () => [family], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: false, civitaiLookups: false }),
    });
    // the same file at its official address in another folder (a shipped preset loading LTX 2.3's checkpoint as a diffusion
    // model): the planner sent it to the pod, whose fetch refused it, the pod billed while it waited
    off.want("pod", [
      { file: "official.safetensors", folder: "checkpoints" }, { file: "other.safetensors", folder: "loras", url: `${siteUrl}/files/other.safetensors` },
      { file: "official.safetensors", folder: "diffusion_models", url },
      // and in a sub-folder as ComfyUI on Windows names it, a model input picked on this PC: refused the same way
      { file: "LTX\\official.safetensors", folder: "loras", url },
    ], { tier: "need" });
    await until(async () => {
      await off.tick();
      return off.view("pod").every((f) => f.state === "ready" || f.state === "failed");
    });
    const state = Object.fromEntries(off.view("pod").map((f) => [`${f.folder}/${f.file}`, f.state]));
    expect(state).toEqual({ "checkpoints/official.safetensors": "ready", "loras/other.safetensors": "failed", "diffusion_models/official.safetensors": "ready", "loras/LTX\\official.safetensors": "ready" });
    expect(readFileSync(join(disk, "checkpoints", "official.safetensors")).equals(FILE)).toBe(true);
    expect(readFileSync(join(disk, "diffusion_models", "official.safetensors")).equals(FILE)).toBe(true);
  });

  it("are ready when the pod has them already, a .gguf one too (listed by the GGUF pack, not in ComfyUI's own list)", async () => {
    // no site known and no copy here: only what the pod lists can make it ready (a volume that holds it)
    pod.models.diffusion_models = [];
    pod.models.unet_gguf = ["zz-test-model-Q5_K_M.gguf"];
    files.want("pod", [{ file: "zz-test-model-Q5_K_M.gguf", folder: "diffusion_models" }], { tier: "need", job: "j1" });
    await settle("pod", "zz-test-model-Q5_K_M.gguf");
    expect(files.jobState("pod", "j1")).toMatchObject({ state: "ready" });
    expect(pod.packFetched).toEqual([]);
  });

  it("are asked again when the pod does not answer for a moment, not failed for good", async () => {
    files.retryMs = 10;
    pod.down = true;
    files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
    await until(async () => (await files.tick(), files.view("pod")[0]?.state === "next"));
    expect(files.jobState("pod", "j1")?.state).toBe("waiting");
    pod.down = false;
    await settle("pod", "mine.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "upload" });
  });

  it("a job waits for are not held behind files ahead: one of those gives its place", async () => {
    for (const n of ["a1", "a2"]) files.want("pod", [{ file: `${n}.safetensors`, folder: "loras", url: `${siteUrl}/files/slow-${n}.safetensors` }], { tier: "ahead" });
    await until(async () => (await files.tick(), files.view("pod").filter((f) => f.state === "fetching").length === 2));
    files.want("pod", [{ file: "now.safetensors", folder: "loras", url: `${siteUrl}/files/now.safetensors` }], { tier: "need", job: "j1" });
    await settle("pod", "now.safetensors");
    expect(files.jobState("pod", "j1")?.state).toBe("ready");
    // one ahead was stopped to make room, and started again once the needed one was done
    expect(t.services.downloads.list().filter((d) => d.status === "stopped")).toHaveLength(1);
    expect(files.view("pod").filter((f) => f.tier === "ahead").every((f) => f.state === "fetching")).toBe(true);
    for (const d of t.services.downloads.list()) t.services.downloads.stop(d.id);
  });

  it("are not sent to a pod whose node pack takes no upload", async () => {
    pod.packVersion = "0.13.1";
    files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need" });
    await settle("pod", "mine.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "failed", error: expect.stringContaining("0.14.0") });
    expect(existsSync(join(disk, "loras", "mine.safetensors"))).toBe(false);
  });

  it("ahead come after every file a job waits for", async () => {
    files.want("pod", [{ file: "later.safetensors", folder: "loras", url: `${siteUrl}/files/later.safetensors` }], { tier: "ahead" });
    files.want("pod", [{ file: "now.safetensors", folder: "loras", url: `${siteUrl}/files/now.safetensors` }], { tier: "need", job: "j1" });
    // the pass under way when it was asked for (taken now: awaited later, under load, it may have ended and a next one
    // would start the file ahead once the needed one is under way, as it should)
    const under = files.tick();
    // the needed one first in the list
    expect(files.view("pod").map((f) => f.file)).toEqual(["now.safetensors", "later.safetensors"]);
    // that pass: the file ahead did not start while a needed one waits to
    await under;
    expect(files.view("pod").find((f) => f.file === "later.safetensors")?.state).toBe("next");
    // both waited for: the one ahead can be done before the one needed (it started later, but a loaded machine may finish it first)
    await settle("pod", "later.safetensors");
    await settle("pod", "now.safetensors");
    expect(files.view("pod").every((f) => f.state === "ready")).toBe(true);
  });

  it("move up when a job needs one asked for ahead", async () => {
    files.want("pod", [{ file: "x.safetensors", folder: "loras", url: `${siteUrl}/files/x.safetensors` }], { tier: "ahead" });
    files.want("pod", [{ file: "x.safetensors", folder: "loras" }], { tier: "need", job: "j2" });
    await settle("pod", "x.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", tier: "need", jobs: ["j2"] });
  });

  it("do not wait behind the downloads of another machine", async () => {
    const other = await startFakeComfy({ catalog: referenceCatalog(), models: { loras: [] }, folderPaths: { loras: [join(disk, "checkpoints")] }, hideFolderPaths: true });
    other.packVersion = "0.14.0";
    try {
      const busy = new Comfy(other.url, t.services.registry);
      for (const n of ["s1", "s2"]) await t.services.downloads.start(busy, "", { file: `${n}.safetensors`, folder: "loras", title: n, source: `${siteUrl}/files/slow-${n}`, total: FILE.length, directOnly: true });
      await until(() => other.packFetched.length === 2);
      files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }], { tier: "need" });
      await settle("pod", "a.safetensors");
      expect(files.view("pod")[0]!.state).toBe("ready");
      for (const d of t.services.downloads.list()) t.services.downloads.stop(d.id);
    } finally {
      await other.close();
    }
  });

  it("hold the pod's idle time while their bytes move, and no more once they stop coming for the stall time", async () => {
    files.stallMs = 400;
    expect(files.moving("pod")).toBe(false);
    files.want("pod", [{ file: "stuck.safetensors", folder: "loras", url: `${siteUrl}/files/slow-stuck.safetensors` }], { tier: "need", job: "j1" });
    await until(async () => (await files.tick(), files.view("pod")[0]?.state === "fetching"));
    // under way: moving from its start, then as its first bytes come
    expect(files.moving("pod")).toBe(true);
    await until(async () => (await files.tick(), files.view("pod")[0]!.bytes > 0));
    expect(files.moving("pod")).toBe(true);
    // then nothing more comes (the site sends its first part only): past the stall time it holds the pod no more
    await new Promise((r) => setTimeout(r, 600));
    await files.tick();
    expect(files.view("pod")[0]!.state).toBe("fetching");
    expect(files.moving("pod")).toBe(false);
    expect(files.moving("other")).toBe(false);
    for (const d of t.services.downloads.list()) t.services.downloads.stop(d.id);
  });

  // the 0.9.0 review (M1): between "fetching" and the download asked for (the pod's ComfyUI reached, a Civitai lookup), the
  // entry had no clock, read as "has brought nothing", and an idle check stopped the pod that was about to work
  it("hold the pod's idle time from the moment one starts, while its source is still being looked up", async () => {
    let reach!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const comfy = new Comfy(pod.url, t.services.registry);
    const slow = new PodFiles({
      db: t.services.db, downloads: t.services.downloads,
      comfyOf: async () => (await reached, comfy), cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
    });
    slow.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }], { tier: "need", job: "j1" });
    await until(async () => (await slow.tick(), slow.view("pod")[0]?.state === "fetching"));
    expect(slow.moving("pod")).toBe(true);
    expect(slow.stalled("pod", "j1", [{ file: "a.safetensors", folder: "loras" }])).toBeNull();
    reach();
    await until(async () => (await slow.tick(), slow.view("pod")[0]?.state === "ready"));
  });

  it("are stopped and forgotten with the pod", async () => {
    files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }], { tier: "need" });
    files.forget("pod");
    expect(files.view("pod")).toEqual([]);
  });
});

// card #206: Civitai answers a version whose creator disabled downloads with a 401, key or none. Said as "key refused", the
// pod waited, billed, for a file that would never come, with this computer's copy at hand
describe("a rented pod's file its Civitai version refuses", () => {
  const closedRow = async (over: { civitai_version?: number | null; hf_url?: string | null; civitai_closed_at?: string | null; hashed_at?: string; matched_at?: string | null } = {}) => {
    const st = statSync(join(home, "models", "loras", "mine.safetensors"));
    await t.services.db.insertInto("model_hashes").values({ folder: "loras", file: "mine.safetensors", size: st.size, mtime: Math.round(st.mtimeMs), sha256: MINE_SHA, hashed_at: "2026-10-14", civitai_version: CLOSED, hf_url: null, matched_at: "2026-10-14", ...over }).execute();
  };
  const lookup = () => ({ db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home });
  const closedAt = async () => (await t.services.db.selectFrom("model_hashes").select("civitai_closed_at").where("file", "=", "mine.safetensors").executeTakeFirstOrThrow()).civitai_closed_at;
  beforeEach(() => {
    // the real ask for the site's link, of the pretend Civitai: its two 401s
    t.services.downloads.signer = (source, headers) => signedLink(source, headers);
  });

  it("is sent from this computer, said in Civitai's words, and the version is not asked again", async () => {
    await closedRow();
    files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
    await settle("pod", "mine.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ file: "mine.safetensors", state: "ready", via: "upload", bytes: 150_000 });
    expect(readFileSync(join(disk, "loras", "mine.safetensors")).equals(Buffer.alloc(150_000, 9))).toBe(true);
    expect(files.jobState("pod", "j1")?.state).toBe("ready");
    // the refusal as Civitai says it, never a key refused
    const said = t.services.downloads.list().find((d) => d.file === "mine.safetensors");
    expect(said).toMatchObject({ status: "error", error: DOWNLOADS_DISABLED, refused: true });
    // kept: the next deploy sends this computer's copy at once
    const row = await t.services.db.selectFrom("model_hashes").select("civitai_closed_at").where("file", "=", "mine.safetensors").executeTakeFirstOrThrow();
    expect(row.civitai_closed_at).toBeTruthy();
    const l = { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home };
    expect(await podSource(l, { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "upload" });
  });

  it("with no copy here fails at once in Civitai's words, its jobs free to go elsewhere", async () => {
    files.want("pod", [{ file: "theirs.safetensors", folder: "loras", civitai: { version: CLOSED, pick: "mine.safetensors" } }], { tier: "need", job: "j1" });
    await settle("pod", "theirs.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "failed", error: DOWNLOADS_DISABLED });
    expect(files.jobState("pod", "j1")?.state).toBe("failed");
  });

  it("is fetched from a usual file's Hugging Face copy of the same bytes, whatever version its hash was matched to", async () => {
    const l = { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home };
    USUAL_COPIES[MINE_SHA] = "https://huggingface.co/org/repo/resolve/main/mine.safetensors";
    try {
      await closedRow();
      expect(await podSource(l, { file: "mine.safetensors", folder: "loras" }, { live: true })).toEqual({ kind: "url", url: "https://huggingface.co/org/repo/resolve/main/mine.safetensors", sha256: MINE_SHA });
    } finally {
      delete USUAL_COPIES[MINE_SHA];
    }
  });

  // the 0.9.0 review (M3): a close was for good, and every later pod got the file uploaded over the home line
  it("in Early Access is sent from here this time, and its version is not closed: it is asked again once free", async () => {
    await closedRow({ civitai_version: PAID });
    files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
    await settle("pod", "mine.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "upload" });
    expect(t.services.downloads.list().find((d) => d.file === "mine.safetensors")).toMatchObject({ status: "error", refused: true, error: expect.stringContaining("paid on Civitai") });
    expect(await closedAt()).toBeNull();
    expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "civitai", version: PAID });
  });

  it("is asked of its version again once the file is hashed or matched again, or once a download of the version succeeds", async () => {
    // hashed again after the close (other bytes, or the same ones read afresh): the close no longer stands
    await closedRow({ civitai_closed_at: "2026-10-15T00:00:00.000Z", hashed_at: "2026-10-16T00:00:00.000Z" });
    expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "civitai", version: CLOSED });
    await t.services.db.updateTable("model_hashes").set({ hashed_at: "2026-10-14", civitai_closed_at: "2026-10-15T00:00:00.000Z" }).execute();
    expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "upload" });
    // the version gave its file on a pod after all: open again for the next lookup
    await t.services.db.updateTable("model_hashes").set({ civitai_version: 77 }).execute();
    t.services.downloads.signer = async (source) => `${source.replace("/files/", "/signed/")}?sig=1`;
    files.want("pod", [{ file: "c.safetensors", folder: "loras", civitai: { version: 77 } }], { tier: "need" });
    await settle("pod", "c.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "civitai" });
    expect(await closedAt()).toBeNull();
  });

  // the 0.9.0 review (S2): the fallback took any file of the bare name at the folder's top, another LoRA as well as this one
  it("is replaced by this computer's copy only when that copy has the bytes the version lists", async () => {
    const want = () => files.want("pod", [{ file: "wan/mine.safetensors", folder: "loras", civitai: { version: CLOSED, pick: "mine.safetensors" } }], { tier: "need" });
    want();
    await settle("pod", "wan/mine.safetensors");
    // loras/mine.safetensors was never hashed: nothing says it is the version's file
    expect(files.view("pod")[0]).toMatchObject({ state: "failed", error: DOWNLOADS_DISABLED });
    files.forget("pod");
    await closedRow({ civitai_version: null, matched_at: null });
    want();
    await settle("pod", "wan/mine.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "ready", via: "upload" });
  });

  // the 0.9.0 review (S1): a Hugging Face copy was fetched with no check, the repo's main branch free to change under it
  it("is fetched from a Hugging Face copy matched by its hash with that hash handed to the pod's node pack", async () => {
    const start = vi.spyOn(t.services.downloads, "start");
    await closedRow({ civitai_version: null, hf_url: `${siteUrl}/files/mine.safetensors` });
    files.want("pod", [{ file: "mine.safetensors", folder: "loras" }], { tier: "need" });
    await until(async () => (await files.tick(), start.mock.calls.length > 0));
    expect(start.mock.calls[0]?.[2]).toMatchObject({ file: "mine.safetensors", sha256: MINE_SHA });
    for (const d of t.services.downloads.list()) t.services.downloads.stop(d.id);
  });

  it("pins the usual files' copies to a commit, never a branch", () => {
    for (const url of Object.values(USUAL_COPIES)) expect(url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
  });
});

describe("where a pod's file comes from", () => {
  const lookup = (over: Partial<Parameters<typeof podSource>[0]> = {}) => ({ db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home, ...over });

  it("is the address given, a preset's, a family's usual file, the Civitai version it was matched to, its page; else this computer's copy", async () => {
    expect(await podSource(lookup(), { file: "a.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/a.safetensors" })).toEqual({ kind: "url", url: "https://huggingface.co/o/r/resolve/main/a.safetensors" });
    expect(await podSource(lookup({ presets: async () => [{ files: [{ file: "sub/P.safetensors", folder: "loras", civitai: { version: 7, pick: "P.safetensors" } }] }] }), { file: "p.safetensors", folder: "loras" }))
      .toEqual({ kind: "civitai", version: 7, pick: "P.safetensors" });
    const families = () => [{ id: "f", name: "F", summary: "", promptStyle: "tags" as const, slots: [{ id: "m", label: "M", folder: "checkpoints", match: [], hint: "", get: { file: "fam.safetensors", url: "https://huggingface.co/f/resolve/main/fam.safetensors" } }] }];
    expect(await podSource(lookup({ families: families as never }), { file: "fam.safetensors", folder: "checkpoints" })).toEqual({ kind: "url", url: "https://huggingface.co/f/resolve/main/fam.safetensors" });
    await t.services.db.insertInto("model_updates").values({ folder: "loras", name: "matched.safetensors", file: "matched.safetensors", model_id: 1, model_name: "M", version_id: 99, version_name: "v1", latest_id: null, latest_name: null, latest_at: null, latest_file: null, checked_at: "2026-10-14" }).execute();
    expect(await podSource(lookup(), { file: "matched.safetensors", folder: "loras" })).toEqual({ kind: "civitai", version: 99, pick: "matched.safetensors" });
    await t.services.db.insertInto("model_pages").values({ folder: "loras", name: "paged.safetensors", url: "https://civitai.com/models/5?modelVersionId=55", title: "Paged", found_at: "2026-10-14" }).execute();
    expect(await podSource(lookup(), { file: "paged.safetensors", folder: "loras" })).toEqual({ kind: "civitai", version: 55, pick: "paged.safetensors" });
    expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" })).toEqual({ kind: "upload", path: join(home, "models", "loras", "mine.safetensors") });
    expect(await podSource(lookup(), { file: "none.safetensors", folder: "loras" })).toBeNull();
  });

  // card #105: a pod had no site for it (the re-check series put it there by hand)
  it("knows where LTX 2.5's dev transformer is had: its family's Hugging Face address", async () => {
    const file = "ltx-2.5-22b-dev-transformer-comfy-int8-convrot.safetensors";
    expect(await podSource(lookup({ families: () => families }), { file, folder: "diffusion_models" }))
      .toEqual({ kind: "url", url: `https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/${file}` });
  });

  it("reads the presets, a folder's hashes, Civitai matches and pages once for the many files a search or a set asks about", async () => {
    let presets = 0;
    const read: string[] = [];
    const db = t.services.db;
    // the tables read, counted: each file used to read the presets and its folder's every hash and match
    const counted = new Proxy(db, {
      get: (target, key) => (key === "selectFrom" ? (table: string) => (read.push(table), target.selectFrom(table as never)) : Reflect.get(target, key)),
    });
    const l = lookup({ db: counted as typeof db, presets: async () => (presets++, []) });
    const theirs = Array.from({ length: 30 }, (_x, i) => ({ file: `zz-test-${i}.safetensors`, folder: "loras" }));
    const mine = Array.from({ length: 30 }, () => ({ file: "mine.safetensors", folder: "loras" }));
    // all at once, as a search asks; then one after the other, as the queue's plan does, within the moment a read is
    // kept (the clock held: a loaded machine running the whole suite took longer than that moment for the 120 asks)
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await Promise.all([...theirs, ...mine].map((f) => podSource(l, f)));
    for (const f of [...theirs, ...mine]) await podSource(l, f);
    clock.mockRestore();
    expect(presets).toBe(1);
    expect(read.filter((x) => x === "model_hashes")).toHaveLength(1);
    expect(read.filter((x) => x === "model_updates")).toHaveLength(1);
    expect(read.filter((x) => x === "model_pages")).toHaveLength(1);
  });

  describe("on a pretend Civitai whose model has files of the same names as this computer's", () => {
    const MINE = sha(Buffer.alloc(150_000, 9));
    const FP8 = "F".repeat(64);
    /** Whether the site's mine.safetensors is these very bytes (else a stranger's LoRA of the same name). */
    let same = false;
    let searches = 0;
    let versions = 0;
    let at = "";
    let sites: Server;
    beforeEach(async () => {
      same = false;
      searches = 0;
      versions = 0;
      sites = createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        const files = [
          { name: "mine.safetensors", sizeKB: 4, primary: true, downloadUrl: `${at}/files/mine`, hashes: { SHA256: same ? MINE : "A".repeat(64) } },
          { name: "mine_fp8.safetensors", sizeKB: 2, downloadUrl: `${at}/files/fp8`, hashes: { SHA256: FP8 } },
          { name: "theirs.safetensors", sizeKB: 3, downloadUrl: `${at}/files/theirs`, hashes: { SHA256: "B".repeat(64) } },
        ];
        if (req.url?.startsWith("/api/v1/models")) {
          searches++;
          return res.end(JSON.stringify({ items: [{ id: 5, name: "Mine", type: "LORA", modelVersions: [{ id: 56, name: "v2", baseModel: "SDXL", files: files.map(({ hashes: _h, ...f }) => f) }] }] }));
        }
        if (req.url === "/api/v1/model-versions/56") {
          versions++;
          return res.end(JSON.stringify({ id: 56, name: "v2", model: { name: "Mine" }, files }));
        }
        // a pretend Hugging Face that has none of them
        res.end("[]");
      });
      await new Promise<void>((r) => sites.listen(0, "127.0.0.1", r));
      at = `http://127.0.0.1:${(sites.address() as AddressInfo).port}`;
      vi.stubEnv("CIVITAI_URL", at);
      vi.stubEnv("HUGGINGFACE_URL", at);
      forgetHuggingFace();
    });
    afterEach(async () => {
      vi.unstubAllEnvs();
      await new Promise((r) => sites.close(r));
    });
    const hashRow = async (o: { matched?: boolean } = {}) => {
      const st = statSync(join(home, "models", "loras", "mine.safetensors"));
      await t.services.db.insertInto("model_hashes").values({ folder: "loras", file: "mine.safetensors", size: st.size, mtime: Math.round(st.mtimeMs), sha256: MINE, hashed_at: "2026-10-14", civitai_version: o.matched ? 0 : null, hf_url: null, matched_at: o.matched ? new Date().toISOString() : null }).execute();
    };

    it("sends this computer's copy rather than a site's file of the same name; takes that file only with the same hash", async () => {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: false } });
      expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "upload" });
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true } });
      // not hashed yet: nothing proves the site's mine.safetensors is the user's own
      expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "upload" });
      // a file this computer does not have: the site that has one of its name is all there is
      expect(await podSource(lookup(), { file: "theirs.safetensors", folder: "loras" }, { live: true })).toEqual({ kind: "civitai", version: 56, pick: "theirs.safetensors" });
      // hashed, and the site's file of that name is other bytes: still this computer's copy
      await hashRow();
      expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "upload" });
      // the site lists this very hash for it: that file, by its hash, kept as the hash's match for the lists to say
      same = true;
      expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toEqual({ kind: "civitai", version: 56, pick: "mine.safetensors", sha256: MINE });
      expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" })).toEqual({ kind: "civitai", version: 56, pick: "mine.safetensors", sha256: MINE });
    });

    it("asks no site for a file whose hash was matched to nothing", async () => {
      same = true;
      await hashRow({ matched: true });
      expect(await podSource(lookup(), { file: "mine.safetensors", folder: "loras" }, { live: true })).toMatchObject({ kind: "upload" });
      expect(versions).toBe(0);
    });

    it("takes a version's file by its hash, not by the name it has here", async () => {
      expect((await civitaiVersion(56, "renamed_by_me.safetensors", "", { sha256: FP8 }))?.file.name).toBe("mine_fp8.safetensors");
      // by the name only with no hash: the closest name, its main file on a tie
      expect((await civitaiVersion(56, "renamed_by_me.safetensors", ""))?.file.name).toBe("mine.safetensors");
      // a hash none of its files has: none of them
      expect(await civitaiVersion(56, "mine.safetensors", "", { sha256: "C".repeat(64) })).toBeNull();
    });

    it("keeps a lookup that found nothing for a day; the lists ask no site at all", async () => {
      const nothing = { file: "nothing_like_it.safetensors", folder: "loras" };
      expect(await podSource(lookup(), nothing)).toBeNull();
      expect(searches).toBe(0);
      expect(await podSource(lookup(), nothing, { live: true })).toBeNull();
      const asked = searches;
      expect(asked).toBeGreaterThan(0);
      expect(await podSource(lookup(), nothing, { live: true })).toBeNull();
      expect(searches).toBe(asked);
      // the miss is no page to show, and the user's own search asks again
      expect((await t.app.inject({ method: "GET", url: "/api/models/loras/pages" })).json().items).toEqual({});
      await t.app.inject({ method: "POST", url: "/api/models/loras/page", payload: { file: nothing.file } });
      expect(searches).toBeGreaterThan(asked);
    });
  });

  it("says Hugging Face only of an address whose host is Hugging Face's", () => {
    expect(measureKind({ kind: "url", url: "https://huggingface.co/o/r/resolve/main/a.safetensors" })).toBe("hf");
    expect(measureKind({ kind: "url", url: "https://cdn-lfs.hf.co/x" })).toBe("hf");
    expect(measureKind({ kind: "url", url: "https://127.0.0.1:8188?.hf.co/" })).toBe("url");
    expect(measureKind({ kind: "url", url: "https://huggingface.co.example.com/x" })).toBe("url");
    expect(measureKind({ kind: "url", url: "http://huggingface.co/x" })).toBe("url");
  });

  it("is never a path out of the model folder", async () => {
    expect(await localCopy(home, "loras", "../../x.safetensors")).toBeNull();
  });
});

describe("what pods were measured at", () => {
  it("guesses a source never measured, said as a guess, and a range from slow to fast once it was", async () => {
    const db = t.services.db;
    expect(await measuredRange(db, "hf", "SECURE")).toBeNull();
    // 1 GB at the guess for Hugging Face, said as one
    expect(await estimateFiles(db, [{ bytes: 2 ** 30, kind: "hf" }], "SECURE", 0.6)).toMatchObject({ guessed: true, fastMs: (2 ** 30 / GUESSED.hf.high) * 1000, slowMs: (2 ** 30 / GUESSED.hf.low) * 1000 });
    // too small a file says more of the site's answer than its speed: not kept
    await recordMeasure(db, { kind: "hf", cloud: "SECURE", bytes: 1000, ms: 10 });
    expect(await measuredRange(db, "hf", "SECURE")).toBeNull();
    for (const mbps of [50, 100, 200]) await recordMeasure(db, { kind: "hf", cloud: "SECURE", bytes: MEASURED_FROM * 10, ms: ((MEASURED_FROM * 10) / (mbps * 2 ** 20)) * 1000 });
    const range = (await measuredRange(db, "hf", "SECURE"))!;
    expect(range.count).toBe(3);
    expect(range.low / 2 ** 20).toBeCloseTo(50, 0);
    expect(range.high / 2 ** 20).toBeCloseTo(200, 0);
    // 10 GB at 50 to 200 MB/s, at $0.60 an hour
    const est = await estimateFiles(db, [{ bytes: 10 * 2 ** 30, kind: "hf" }], "SECURE", 0.6);
    expect(est.guessed).toBe(false);
    expect(est.fastMs / 1000).toBeCloseTo(51.2, 0);
    expect(est.slowMs / 1000).toBeCloseTo(204.8, 0);
    expect(est.highUsd).toBeCloseTo((204.8 / 3600) * 0.6, 4);
    // the other cloud has none of its own: the speeds of any cloud
    expect((await measuredRange(db, "hf", "COMMUNITY"))!.count).toBe(3);
    // a source of the files never measured: its share guessed, the measured one's kept, the whole said as a guess (it said
    // nothing at all for the whole set before)
    const both = await estimateFiles(db, [{ bytes: 10 * 2 ** 30, kind: "hf" }, { bytes: 2 ** 30, kind: "civitai" }], "SECURE", 0.6);
    expect(both.guessed).toBe(true);
    expect(both.slowMs).toBeCloseTo(est.slowMs + (2 ** 30 / GUESSED.civitai.low) * 1000, 0);
  });

  it("leaves out the most extreme of each end once there are five", async () => {
    const db = t.services.db;
    for (const ms of [1000, 50_000, 60_000, 70_000, 900_000]) await recordMeasure(db, { kind: "boot", cloud: null, bytes: 0, ms });
    expect(await measuredRange(db, "boot", null)).toMatchObject({ low: 50_000, high: 70_000, count: 5 });
  });
});

describe("a rented pod's node packs", () => {
  /** A pod with ComfyUI-Manager, and the pod files of it; `busy` says whether a job runs there. */
  /** `nodes`: the node types ComfyUI has once restarted (the packs' own, when they loaded). */
  async function withManager(fail: string[] = [], late: Record<string, number> = {}, nodes = ["DetailerForEach", "FaceDetailer", "LyingSigmaSampler"], broken: FakeInit["packsBroken"] = {}) {
    // a pod without these packs (none of Impact's nodes: one there would be an older copy of it): their nodes come only
    // with a restart that loads them
    const gone = [...nodesOfPack("comfyui-impact-pack"), "LyingSigmaSampler"];
    const catalog = Object.fromEntries(Object.entries(referenceCatalog()).filter(([n]) => !gone.includes(n)));
    const pm = await startFakeComfy({ catalog, models: { loras: [] }, manager: true, packsFail: fail, packsLate: late, packsBroken: broken, afterReboot: Object.fromEntries(nodes.map((n) => [n, { input: { required: {} }, output: [], output_name: [], name: n, category: "x" }])) as never });
    pm.packVersion = "0.14.0";
    const comfy = new Comfy(pm.url, t.services.registry);
    let busy = false;
    const pf = new PodFiles({
      db: t.services.db, downloads: t.services.downloads, comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => busy,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
    });
    pf.packRetryMs = 10;
    return { pm, pf, setBusy: (b: boolean) => (busy = b) };
  }

  it("are installed through its Manager, then ComfyUI restarted, never under a render; the job waits until then", async () => {
    const { pm, pf, setBusy } = await withManager();
    try {
      setBusy(true);
      pf.wantPacks("pod", ["comfyui-impact-pack"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "installed"));
      expect(pm.packs.map((p) => p.id)).toEqual(["comfyui-impact-pack"]);
      // a render runs there: no restart yet, the job still waits
      for (let i = 0; i < 3; i++) await pf.tick();
      expect(pm.reboots).toBe(0);
      expect(pf.jobState("pod", "j1")?.state).toBe("waiting");
      setBusy(false);
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "ready"));
      expect(pm.reboots).toBe(1);
      expect(pf.jobState("pod", "j1")?.state).toBe("ready");
    } finally {
      await pm.close();
    }
  });

  it("that a Manager just started cannot find yet are asked again, and come", async () => {
    const { pm, pf } = await withManager([], { "comfyui-detail-daemon": 2 });
    try {
      pf.wantPacks("pod", ["comfyui-detail-daemon"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "ready"));
      expect(pm.packs.map((p) => p.id)).toEqual(["comfyui-detail-daemon"]);
      expect(pm.reboots).toBe(1);
    } finally {
      await pm.close();
    }
  });

  it("that ComfyUI did not load after its restart fail: never ready with their nodes missing", async () => {
    const { pm, pf } = await withManager([], {}, []);
    try {
      pf.wantPacks("pod", ["comfyui-impact-pack"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "failed"));
      expect(pf.packsView("pod")[0]!.error).toMatch(/did not load it/);
      expect(pf.jobState("pod", "j1")?.state).toBe("failed");
      expect(pf.holding("pod")).toBe(false);
      // what cannot come there, with why: its jobs are built without what it brings (queue.ts podPackFacts)
      expect([...pf.failingPacks("pod").keys()]).toEqual(["comfyui-impact-pack"]);
      expect(pf.failingPacks("pod").get("comfyui-impact-pack")).toMatch(/did not load it/);
    } finally {
      await pm.close();
    }
  });

  it("asked for a job alone are kept while ComfyUI restarts for them: the planner, which cannot judge the pod then, does not strand it held (review 0.6.0, N-15)", async () => {
    const { pm, pf } = await withManager();
    try {
      pf.wantPacks("pod", ["comfyui-impact-pack"], "j1");
      await until(async () => (await pf.tick(), pm.reboots === 1));
      expect(pf.holding("pod")).toBe(true);
      // the pod down for its restart: unjudged, the plan sends j1 nowhere, and its packs would be dropped
      pf.dropUnsought("pod", () => false);
      expect(pf.packsView("pod").map((p) => p.name)).toEqual(["comfyui-impact-pack"]);
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "ready"), 15_000);
      expect(pf.holding("pod")).toBe(false);
      // and the next job's pack comes as usual
      pf.wantPacks("pod", ["comfyui-detail-daemon"], "j2");
      await until(async () => (await pf.tick(), pf.packsView("pod").find((p) => p.name === "comfyui-detail-daemon")?.state === "ready"), 15_000);
      expect(pm.reboots).toBe(2);
      expect(pf.holding("pod")).toBe(false);
    } finally {
      await pm.close();
    }
  }, 40_000);

  it("that Manager does not install fail, their job with them", async () => {
    const { pm, pf } = await withManager(["ComfyUI-GGUF"]);
    try {
      pf.wantPacks("pod", ["ComfyUI-GGUF"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "failed"));
      expect(pf.jobState("pod", "j1")).toMatchObject({ state: "failed", error: expect.stringContaining("ComfyUI-GGUF") });
      expect(pf.failedPacks("pod", ["ComfyUI-GGUF"])).toContain("ComfyUI-GGUF");
      expect(pm.reboots).toBe(0);
    } finally {
      await pm.close();
    }
  });

  /**
   * What the real Manager prints into ComfyUI's log when Impact Pack's sam2 requirement fails under the pod image's
   * constraints (card #45), as ComfyUI keeps the writes: pip's stderr comes as "[!]", a space, then its line.
   */
  const SAM2_FAILS = [
    "Install: pip packages\n",
    "\n## ComfyUI-Manager: EXECUTE => ['/usr/bin/python3', '-m', 'pip', 'install', 'segment-anything']\n",
    "Requirement already satisfied: segment-anything in /usr/local/lib/python3.12/site-packages\n",
    "\n## ComfyUI-Manager: EXECUTE => ['/usr/bin/python3', '-m', 'pip', 'install', 'git+https://github.com/facebookresearch/sam2']\n",
    "Collecting git+https://github.com/facebookresearch/sam2\n",
    "[!]", " ", "ERROR: Cannot install torch>=2.5.1 because these package versions have conflicting dependencies.\n",
    "[!]", " ", "The conflict is caused by:\n",
    "[!]", " ", "    The user requested torch>=2.5.1\n",
    "[!]", " ", "    The user requested (constraint) torch==2.10.0+cu130\n",
    "[!]", " ", "ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/\n",
    "install script failed: comfyui-impact-pack\n",
    "\n## ComfyUI-Manager: EXECUTE => ['/usr/bin/python3', '-m', 'pip', 'install', 'scikit-image']\n",
    "Requirement already satisfied: scikit-image in /usr/local/lib/python3.12/site-packages\n",
  ];

  it("whose install script failed and that ComfyUI does not load fail with Manager's words and pip's, on the job and its row (card #47)", async () => {
    const { pm, pf } = await withManager([], {}, undefined, { "comfyui-impact-pack": { result: "Failed to execute install script: comfyui-impact-pack@8.28.3", printed: SAM2_FAILS } });
    try {
      pf.wantPacks("pod", ["comfyui-impact-pack"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "failed"));
      const error = pf.packsView("pod")[0]!.error!;
      expect(error).toMatch(/^ComfyUI-Manager: Failed to execute install script: comfyui-impact-pack@8\.28\.3 \(pip install git\+https:\/\/github\.com\/facebookresearch\/sam2: ERROR: Cannot install torch>=2\.5\.1/);
      expect(error).toContain("The user requested (constraint) torch==2.10.0+cu130");
      expect(error).toContain("ERROR: ResolutionImpossible");
      // not the requirements that went fine before and after it, nor our own generic words
      expect(error).not.toMatch(/segment-anything|scikit-image|did not install it|did not load it/);
      // Manager put it on the disk all the same: ComfyUI was restarted for it, and lacks its nodes
      expect(pm.reboots).toBe(1);
      expect(error).toMatch(/after ComfyUI's restart it lacks \w+/);
      expect(pf.jobState("pod", "j1")).toMatchObject({ state: "failed", error: `the node pack comfyui-impact-pack: ${error}` });
      expect(pf.failingPacks("pod").get("comfyui-impact-pack")).toBe(error);
    } finally {
      await pm.close();
    }
  });

  it("whose install script failed but that ComfyUI loads all the same are ready: its job runs (as controlnet_aux 1.1.6 on the pod image)", async () => {
    const { pm, pf } = await withManager([], {}, undefined, { "comfyui-impact-pack": { result: "Failed to execute install script: comfyui-impact-pack@8.28.3", printed: SAM2_FAILS, loads: true } });
    try {
      pf.wantPacks("pod", ["comfyui-impact-pack"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "ready"));
      expect(pm.reboots).toBe(1);
      expect(pf.jobState("pod", "j1")?.state).toBe("ready");
    } finally {
      await pm.close();
    }
  });

  it("that Manager's security level refuses say Manager's own line from ComfyUI's log, not a guess", async () => {
    const security = "ERROR: To use this action, security_level must be `normal or below`, and network_mode must be set to `personal_cloud`. Please contact the administrator.";
    const { pm, pf } = await withManager([], {}, undefined, { "comfyui-detail-daemon": { result: "failed", printed: [`${security}\nReference: https://github.com/ltdrdata/ComfyUI-Manager#security-policy\n`] } });
    try {
      pf.wantPacks("pod", ["comfyui-detail-daemon"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "failed"));
      expect(pf.packsView("pod")[0]!.error).toBe(`ComfyUI-Manager: ${security}`);
      expect(pm.reboots).toBe(0);
    } finally {
      await pm.close();
    }
  });

  it("that Manager refuses otherwise say its words as it answered them", async () => {
    const { pm, pf } = await withManager([], {}, undefined, { "comfyui-detail-daemon": { result: "not available node: comfyui-detail-daemon@1.1.3" } });
    try {
      pf.wantPacks("pod", ["comfyui-detail-daemon"], "j1");
      await until(async () => (await pf.tick(), pf.packsView("pod")[0]?.state === "failed"));
      expect(pf.jobState("pod", "j1")?.error).toBe("the node pack comfyui-detail-daemon: ComfyUI-Manager: not available node: comfyui-detail-daemon@1.1.3");
      expect(pm.reboots).toBe(0);
    } finally {
      await pm.close();
    }
  });
});

describe("a rented pod's disk", () => {
  const GB2 = 2 * 2 ** 30;
  /** The pod's files, with its pack saying its disk (0.19.0) and Make room as given. */
  function withDisk(makesRoom: boolean, onVolume = false, volumeBytes?: number) {
    pod.packVersion = "0.19.0";
    const comfy = new Comfy(pod.url, t.services.registry);
    const made = new PodFiles({
      db: t.services.db, downloads: t.services.downloads,
      comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
      makesRoom: async () => makesRoom,
      onVolume: async () => onVolume,
      ...(volumeBytes ? { volumeBytes: async () => volumeBytes } : {}),
    });
    made.diskFreshMs = 0;
    return made;
  }
  const settleOn = (on: PodFiles, file: string) =>
    until(async () => {
      await on.tick();
      const v = on.view("pod").find((f) => f.file === file);
      return v === undefined || v.state === "ready" || v.state === "failed";
    });

  it("fails a file that does not fit at once, said as a full disk, when the pod does not make room", async () => {
    const on = withDisk(false);
    pod.diskFree = GB2 + 100_000;
    on.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors`, size: FILE.length }], { tier: "need", job: "j1" });
    await settleOn(on, "a.safetensors");
    const v = on.view("pod")[0]!;
    expect(v.state).toBe("failed");
    expect(v.error).toMatch(/^the pod's disk is full: .* \(Make room is off\)$/);
    expect(pod.packFetched).toEqual([]);
    expect(on.diskOf("pod")).toMatchObject({ free: GB2 + 100_000 });
  });

  it("says a pod's network volume full, and fetches the file once room is made on the volume (its Files)", async () => {
    const on = withDisk(false, true);
    pod.diskFree = GB2 + 100_000;
    on.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors`, size: FILE.length }], { tier: "need", job: "j1" });
    await settleOn(on, "a.safetensors");
    expect(on.view("pod")[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/^its volume is full: /) });
    // files deleted from the volume through S3: room again, and the file that found none goes back in line
    pod.diskFree = 50 * GB2;
    on.freed("pod", [{ folder: "loras", file: "old.safetensors" }]);
    await settleOn(on, "a.safetensors");
    expect(on.view("pod")[0]?.state).toBe("ready");
  });

  it("deletes what it fetched and no job needs, the longest unused first, to make room for a file a job needs", async () => {
    const on = withDisk(true);
    on.want("pod", [{ file: "old.safetensors", folder: "loras", url: `${siteUrl}/files/old.safetensors` }], { tier: "need", job: "gone-job" });
    await settleOn(on, "old.safetensors");
    expect(on.view("pod")[0]?.state).toBe("ready");
    // a file the pod had before it (its image's, its volume's) is never deleted
    writeFileSync(join(disk, "loras", "theirs.safetensors"), Buffer.alloc(300_000, 1));
    pod.diskFree = GB2 + 100_000;
    on.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors`, size: FILE.length }], { tier: "need", job: "j2" });
    await settleOn(on, "a.safetensors");
    expect(pod.removed).toEqual(["loras/old.safetensors"]);
    expect(existsSync(join(disk, "loras", "theirs.safetensors"))).toBe(true);
    expect(on.view("pod").map((f) => [f.file, f.state])).toEqual([["a.safetensors", "ready"]]);
  });

  it("keeps a file a waiting job needs, and then says the disk is full", async () => {
    const on = withDisk(true);
    await t.services.db.insertInto("jobs").values({ id: "waits", owner_id: "local", recipe_id: "x", label: "zz-test", inputs: "{}", status: "queued", warm: 0, look: null, priority: 10, depends_on: null, attempts: 0, resume: null, error: null, generation_id: null, clip_id: null, draft_id: null, folder_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as never).execute();
    on.want("pod", [{ file: "old.safetensors", folder: "loras", url: `${siteUrl}/files/old.safetensors` }], { tier: "need", job: "waits" });
    await settleOn(on, "old.safetensors");
    pod.diskFree = GB2 + 100_000;
    on.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors`, size: FILE.length }], { tier: "need", job: "j2" });
    await settleOn(on, "a.safetensors");
    expect(pod.removed).toEqual([]);
    expect(on.view("pod").find((f) => f.file === "a.safetensors")?.error).toMatch(/nothing it fetched can be deleted/);
  });

  it("fails a file its older pack refuses for want of room, never asked again as a passing failure", async () => {
    // a pack before 0.19.0 says no disk; it still refuses a file larger than its room (507) when told the size
    pod.diskFree = 100_000;
    files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors`, size: FILE.length }], { tier: "need", job: "j1" });
    await settle("pod", "a.safetensors");
    expect(files.view("pod")[0]).toMatchObject({ state: "failed", error: expect.stringMatching(/^the pod.s disk is full/) });
  });

  it("tells the queue a job's files do not fit, beside what it could delete", async () => {
    const on = withDisk(false);
    pod.diskFree = GB2 + 100_000;
    await on.tick();
    expect(await on.short("pod", [{ file: "a.safetensors", folder: "loras", size: FILE.length }])).toBeNull();
    on.want("pod", [{ file: "x.safetensors", folder: "loras", url: `${siteUrl}/files/x.safetensors` }], { tier: "need" });
    await until(async () => (await on.short("pod", [{ file: "a.safetensors", folder: "loras", size: FILE.length }])) !== null);
    expect(await on.short("pod", [{ file: "a.safetensors", folder: "loras", size: FILE.length }])).toMatch(/^its disk is short: .* \(Make room is off\)$/);
  });

  it("says a network volume's own size and what its models hold, not RunPod's shared storage (card #149)", async () => {
    const VOLUME = 15 * 2 ** 30;
    const on = withDisk(false, true, VOLUME);
    pod.packVersion = "0.21.0";
    writeFileSync(join(disk, "loras", "held.safetensors"), FILE);
    // the pack reads the volume's disk as the whole of RunPod's storage there: 2 PB
    pod.diskFree = 1.6e15;
    pod.diskTotal = 2.2e15;
    await on.tick();
    void on.short("pod", []);
    await until(() => on.diskOf("pod") !== null);
    expect(on.diskOf("pod")).toMatchObject({ total: VOLUME, free: VOLUME - FILE.length });
    // a reading within the volume's size is the pack's own, as it was
    const within = withDisk(false, true, VOLUME);
    pod.diskFree = 10 * 2 ** 30;
    pod.diskTotal = VOLUME;
    void within.short("pod", []);
    await until(() => within.diskOf("pod") !== null);
    expect(within.diskOf("pod")).toMatchObject({ total: VOLUME, free: 10 * 2 ** 30 });
  });
});

describe("a pod missing from one RunPod read", () => {
  /** A pod's files over a pretend download list: its deploy's set coming, a file left out at the deploy. */
  const podOf = (state: { alive: boolean; gone: boolean }) => {
    const stopped: string[] = [];
    const downloads = { start: async () => ({ id: "d1", total: 0 }), stop: (id: string) => (stopped.push(id), true), get: () => ({ status: "downloading", bytes: 10, total: 100 }) };
    const pf = new PodFiles({
      db: t.services.db, downloads: downloads as never,
      comfyOf: async () => ({ client: { models: async () => [] } }) as never,
      cloudOf: async () => null,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => "" },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
      alive: () => state.alive, gone: () => state.gone, busy: () => false,
    });
    pf.leaveOut("pod1", [{ file: "big.safetensors", folder: "checkpoints" }]);
    pf.want("pod1", [{ file: "set.safetensors", folder: "loras", url: "https://huggingface.co/a/b/resolve/main/set.safetensors" }], { tier: "ahead" });
    return { pf, stopped };
  };

  it("keeps what it was getting, and what was left out at its deploy", async () => {
    const state = { alive: true, gone: false };
    const { pf, stopped } = podOf(state);
    await until(async () => (await pf.tick(), pf.view("pod1").some((f) => f.state === "fetching")));
    state.alive = false;
    await pf.tick();
    state.alive = true;
    await pf.tick();
    expect(pf.view("pod1").map((f) => `${f.file}:${f.state}`).sort()).toEqual(["big.safetensors:failed", "set.safetensors:fetching"]);
    expect(pf.failed("pod1", "checkpoints", "big.safetensors")).toMatch(/left out/);
    expect(stopped).toEqual([]);
  });

  it("forgets them once it is down for good", async () => {
    const state = { alive: true, gone: false };
    const { pf, stopped } = podOf(state);
    await until(async () => (await pf.tick(), pf.view("pod1").some((f) => f.state === "fetching")));
    Object.assign(state, { alive: false, gone: true });
    await pf.tick();
    expect(pf.view("pod1")).toEqual([]);
    expect(stopped).toEqual(["d1"]);
  });
});

describe("files the queue's plan sent a pod", () => {
  it("are dropped once none of their jobs may run there; what the user asked for stays", () => {
    const at = (file: string) => ({ file, folder: "loras", url: `${siteUrl}/files/${file}` });
    files.want("pod", [at("planned.safetensors")], { tier: "ahead", sentFor: "j1" });
    files.want("pod", [at("shared.safetensors")], { tier: "ahead", sentFor: "j1" });
    files.want("pod", [at("shared.safetensors")], { tier: "need", job: "j2", sentFor: "j2" });
    files.want("pod", [at("ticked.safetensors")], { tier: "ahead" });
    // j1 pinned elsewhere, or gone: its own file goes, the one j2 still needs stays, the user's stays
    files.dropUnsought("pod", (job) => job === "j2");
    expect(files.view("pod").map((f) => f.file).sort()).toEqual(["shared.safetensors", "ticked.safetensors"]);
    // a file the user asked for too is never dropped, whoever else it was sent for
    files.want("pod", [at("both.safetensors")], { tier: "ahead", sentFor: "j3" });
    files.want("pod", [at("both.safetensors")], { tier: "ahead" });
    files.dropUnsought("pod", () => false);
    expect(files.view("pod").map((f) => f.file).sort()).toEqual(["both.safetensors", "ticked.safetensors"]);
  });
});

describe("node packs asked for a job that may no longer run on the pod", () => {
  it("are dropped before they install, so the pod's ComfyUI is not restarted for them", () => {
    files.wantPacks("pod", ["comfyui-videohelpersuite"], "j1");
    files.wantPacks("pod", ["ComfyUI-DaSiWa-Nodes"], "j2");
    files.dropUnsought("pod", (job) => job === "j2");
    expect(files.packsView("pod").map((p) => p.name)).toEqual(["ComfyUI-DaSiWa-Nodes"]);
    expect(files.holdsFor("pod", "j2")).toBe(false);
  });
});

describe("a pod's file asked again after a failure that passes", () => {
  it("is asked quietly while tries are left (no red banner per try), and out loud on its last", async () => {
    const asked: Array<{ quietPassing?: boolean }> = [];
    // every try ends as a pod whose node pack has its line full would make it: a failure that passes
    const downloads = {
      start: async (_c: unknown, _s: string, want: { quietPassing?: boolean }) => (asked.push(want), { id: `d${asked.length}`, total: 0 }),
      stop: () => true,
      get: () => ({ status: "error", error: "The Afflatus node pack refused the download (429: 2 downloads are under way already)", bytes: 0, total: 0 }),
    };
    const pf = new PodFiles({
      db: t.services.db, downloads: downloads as never,
      comfyOf: async () => ({ client: { models: async () => [] } }) as never,
      cloudOf: async () => null,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => "" },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
      alive: () => true, gone: () => false, busy: () => false,
    });
    pf.retryMs = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      pf.want("pod1", [{ file: "swap.safetensors", folder: "loras", url: "https://huggingface.co/a/b/resolve/main/swap.safetensors" }], { tier: "need", job: "j1" });
      await until(async () => (await pf.tick(), pf.view("pod1")[0]?.state === "failed"), 5_000);
      expect(asked.length).toBeGreaterThan(1);
      expect(asked.slice(0, -1).every((w) => w.quietPassing === true)).toBe(true);
      expect(asked.at(-1)!.quietPassing).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a pod's file waiting its turn at the node pack", () => {
  it("counts its fetch time from when the pack takes it, not from the wait for its line (a 429 waited out)", async () => {
    // the pack's line full for a while, then the file taken and whole at once
    let takenAt = Infinity;
    const downloads = {
      start: async () => ({ id: "d1", total: 1000 }),
      stop: () => true,
      get: () => (Date.now() < takenAt ? { status: "starting", waiting: "the node pack's downloads at once are under way: waiting for one to end", bytes: 0, total: 1000 } : { status: "done", bytes: 1000, total: 1000 }),
    };
    const comfy = new Comfy(pod.url, t.services.registry);
    const pf = new PodFiles({
      db: t.services.db, downloads: downloads as never,
      comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
    });
    pf.want("pod", [{ file: "late.safetensors", folder: "loras", url: `${siteUrl}/files/late.safetensors` }], { tier: "need" });
    await pf.tick();
    const waitFrom = Date.now();
    await until(async () => (await pf.tick(), Date.now() - waitFrom >= 1500));
    takenAt = Date.now();
    // taken, and whole a moment later
    await new Promise((r) => setTimeout(r, 50));
    await until(async () => (await pf.tick(), Boolean(await t.services.db.selectFrom("pod_fetches").select("file").executeTakeFirst())));
    const fetched = await t.services.db.selectFrom("pod_fetches").selectAll().executeTakeFirstOrThrow();
    // from about when it was taken: the 1.5 s waited for the line are not in it
    expect(Date.parse(fetched.ended_at) - Date.parse(fetched.started_at)).toBeLessThan(1000);
  }, 15_000);
});

describe("the pod's files read again as its files land or fail", () => {
  it("once for the files that land together, at once for the one that lets a job start, never for a failure; the pictures sent stay", async () => {
    const comfy = new Comfy(pod.url, t.services.registry);
    comfy.uploaded.set("input/zz-test", { at: Date.now(), name: Promise.resolve("zz-test.png") });
    const told: boolean[] = [];
    const pf = new PodFiles({
      db: t.services.db, downloads: t.services.downloads,
      comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true, busy: () => false,
      lookup: { db: t.services.db, presets: async () => [], families: () => [], comfyDir: async () => home },
      settings: async () => ({ civitaiKey: "", downloadModels: true, civitaiLookups: true }),
      // as services.ts does: the files read again when they changed
      settled: (_m, changed) => {
        told.push(changed);
        if (changed) comfy.forgetFiles();
      },
    });
    pf.landingsMs = 300;
    const ready = (file: string) => until(async () => (await pf.tick(), pf.view("pod").find((f) => f.file === file)?.state === "ready"));
    // a file fetched ahead (no job waits for it) and the first of a job's two (its other one still coming): gathered
    pf.want("pod", [{ file: "ahead.safetensors", folder: "loras", url: `${siteUrl}/files/ahead.safetensors` }], { tier: "ahead" });
    pf.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }, { file: "slow.safetensors", folder: "loras", url: `${siteUrl}/files/slow.safetensors` }], { tier: "need", job: "j1" });
    await ready("ahead.safetensors");
    await ready("a.safetensors");
    expect(told).toEqual([]);
    await until(() => told.length === 1, 5_000);
    expect(told).toEqual([true]);
    // a job's last file: at once
    pf.want("pod", [{ file: "c.safetensors", folder: "loras", url: `${siteUrl}/files/c.safetensors` }], { tier: "need", job: "j2" });
    await ready("c.safetensors");
    expect(told).toEqual([true, true]);
    // a file that fails (its source gives no link a pod can take): the queue looks again, the files are not read
    pf.want("pod", [{ file: "d.safetensors", folder: "loras", url: `${siteUrl}/nolink/d.safetensors` }], { tier: "need", job: "j3" });
    await until(async () => (await pf.tick(), pf.view("pod").find((f) => f.file === "d.safetensors")?.state === "failed"));
    expect(told).toEqual([true, true, false]);
    // a deploy's file, no job's, with nothing else coming: at once, the jobs waiting may need it
    pf.forget("pod");
    told.length = 0;
    pf.want("pod", [{ file: "deployed.safetensors", folder: "loras", url: `${siteUrl}/files/deployed.safetensors` }], { tier: "ahead" });
    await ready("deployed.safetensors");
    expect(told).toEqual([true]);
    // what was sent to that ComfyUI is still known there: a landing does not send each window's photo again
    expect(comfy.uploaded.has("input/zz-test")).toBe(true);
    pf.forget("pod");
  });
});
