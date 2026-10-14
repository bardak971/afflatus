import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { Comfy } from "../src/comfy";
import { NO_DIRECT } from "../src/downloads";
import { PodFiles } from "../src/podFiles";
import { estimateFiles, measuredRange, recordMeasure, MEASURED_FROM } from "../src/podMeasures";
import { localCopy, podSource } from "../src/podSources";
import { writeSettings } from "../src/settings";
import { makeApp, referenceCatalog, until, type TestApp } from "./helpers";

/** A file on a pretend site, served from any byte asked for. */
const FILE = Buffer.alloc(200_000, 3);
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
    if (req.url?.startsWith("/signed/")) {
      const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
      const body = FILE.subarray(from);
      res.writeHead(from ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length, ...(from ? { "content-range": `bytes ${from}-${FILE.length - 1}/${FILE.length}` } : {}) });
      return res.end(body);
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
    comfyOf: async () => comfy, cloudOf: async () => "SECURE", alive: () => true,
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

  it("keep each one's speed, a fast one too (done before the next look), from its start to all of it on the pod", async () => {
    files.measuredFrom = 1;
    files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }, { file: "mine.safetensors", folder: "loras" }], { tier: "need" });
    await settle("pod", "a.safetensors");
    await settle("pod", "mine.safetensors");
    const kept = await t.services.db.selectFrom("pod_measures").select(["kind", "cloud", "bytes"]).orderBy("kind").execute();
    expect(kept).toEqual([{ kind: "upload", cloud: "SECURE", bytes: 150_000 }, { kind: "url", cloud: "SECURE", bytes: FILE.length }]);
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

  it("fail when no site is known and this computer has no copy", async () => {
    files.want("pod", [{ file: "nowhere.safetensors", folder: "loras" }], { tier: "need", job: "j1" });
    await settle("pod", "nowhere.safetensors");
    expect(files.jobState("pod", "j1")).toMatchObject({ state: "failed", error: expect.stringContaining("no site is known") });
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
    // the needed one first in the list
    expect(files.view("pod").map((f) => f.file)).toEqual(["now.safetensors", "later.safetensors"]);
    // the pass under way when it was asked for: the file ahead did not start while a needed one waits to
    await files.tick();
    expect(files.view("pod").find((f) => f.file === "later.safetensors")?.state).toBe("next");
    await settle("pod", "later.safetensors");
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

  it("are stopped and forgotten with the pod", async () => {
    files.want("pod", [{ file: "a.safetensors", folder: "loras", url: `${siteUrl}/files/a.safetensors` }], { tier: "need" });
    files.forget("pod");
    expect(files.view("pod")).toEqual([]);
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

  it("is never a path out of the model folder", async () => {
    expect(await localCopy(home, "loras", "../../x.safetensors")).toBeNull();
  });
});

describe("what pods were measured at", () => {
  it("says nothing of a source never measured, and a range from slow to fast once it was", async () => {
    const db = t.services.db;
    expect(await measuredRange(db, "hf", "SECURE")).toBeNull();
    expect(await estimateFiles(db, [{ bytes: 2 ** 30, kind: "hf" }], "SECURE", 0.6)).toBeNull();
    // too small a file says more of the site's answer than its speed: not kept
    await recordMeasure(db, { kind: "hf", cloud: "SECURE", bytes: 1000, ms: 10 });
    expect(await measuredRange(db, "hf", "SECURE")).toBeNull();
    for (const mbps of [50, 100, 200]) await recordMeasure(db, { kind: "hf", cloud: "SECURE", bytes: MEASURED_FROM * 10, ms: ((MEASURED_FROM * 10) / (mbps * 2 ** 20)) * 1000 });
    const range = (await measuredRange(db, "hf", "SECURE"))!;
    expect(range.count).toBe(3);
    expect(range.low / 2 ** 20).toBeCloseTo(50, 0);
    expect(range.high / 2 ** 20).toBeCloseTo(200, 0);
    // 10 GB at 50 to 200 MB/s, at $0.60 an hour
    const est = (await estimateFiles(db, [{ bytes: 10 * 2 ** 30, kind: "hf" }], "SECURE", 0.6))!;
    expect(est.fastMs / 1000).toBeCloseTo(51.2, 0);
    expect(est.slowMs / 1000).toBeCloseTo(204.8, 0);
    expect(est.highUsd).toBeCloseTo((204.8 / 3600) * 0.6, 4);
    // the other cloud has none of its own: the speeds of any cloud
    expect((await measuredRange(db, "hf", "COMMUNITY"))!.count).toBe(3);
    // a source of the files never measured: nothing said at all
    expect(await estimateFiles(db, [{ bytes: 2 ** 30, kind: "hf" }, { bytes: 2 ** 30, kind: "civitai" }], "SECURE", 0.6)).toBeNull();
  });

  it("leaves out the most extreme of each end once there are five", async () => {
    const db = t.services.db;
    for (const ms of [1000, 50_000, 60_000, 70_000, 900_000]) await recordMeasure(db, { kind: "boot", cloud: null, bytes: 0, ms });
    expect(await measuredRange(db, "boot", null)).toMatchObject({ low: 50_000, high: 70_000, count: 5 });
  });
});
