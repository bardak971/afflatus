import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { migrate, openSqlite } from "../src/db";
import { readSettings, seedNewInstall, writeSettings } from "../src/settings";
import { complete, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Where you render (card #20, the owner 2026-10-20): a new install starts with no ComfyUI expected, every family on, the
 * first launch to show and caps on rented GPUs; with no machine, nothing is offline and the forms offer what a pod would;
 * a job that lacks only a family's official file on the user's own ComfyUI waits there for its Download, never fetched unasked.
 */

const SDXL_BASE = "sd_xl_base_1.0.safetensors";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
const RECIPE = "sdxl.text-to-picture";

let t: TestApp | undefined;
let fake: FakeComfy | undefined;
afterEach(async () => {
  await t?.close();
  await fake?.close().catch(() => {});
  t = undefined;
  fake = undefined;
  delete process.env.AFFLATUS_PROBE_URLS;
});

describe("a new install's settings", () => {
  it("has no machine, every family on, the first launch pending and caps of $5 a day, $25 a month", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    await seedNewInstall(db);
    const s = await readSettings(db);
    expect(s.machines).toEqual([]);
    expect(s).toMatchObject({ allFamilies: true, firstLaunch: "pending", rentCaps: { day: 5, month: 25 } });
    // its first ComfyUI added by its address alone becomes the first machine
    const added = await writeSettings(db, { comfyUrl: "http://127.0.0.1:8000" });
    expect(added.machines.map((m) => [m.id, m.url])).toEqual([["m1", "http://127.0.0.1:8000"]]);
    // every machine removed: none left, the address kept for the next one
    const none = await writeSettings(db, { machines: [] });
    expect(none.machines).toEqual([]);
    expect(none.comfyUrl).toBe("http://127.0.0.1:8000");
    await db.destroy();
  });

  it("an install from before keeps its ComfyUI, its families' rule, and no first launch", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    const s = await readSettings(db);
    expect(s.machines.map((m) => m.id)).toEqual(["m1"]);
    expect(s).toMatchObject({ allFamilies: false, firstLaunch: "done", rentCaps: { day: 0, month: 0 } });
    await db.destroy();
  });

  it("is seeded by the start on a database made just then, not on one that was there", async () => {
    const { start } = await import("../src/start");
    const dir = mkdtempSync(join(tmpdir(), "afflatus-new-"));
    const quiet = { log() {}, warn() {}, error() {} };
    const port = await freePort();
    const started = await start({ host: "127.0.0.1", port, dataDir: dir, databaseUrl: "" }, { log: quiet as never });
    try {
      const s = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
      expect(s).toMatchObject({ machines: [], firstLaunch: "pending", allFamilies: true });
    } finally {
      await started.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("with no machine at all", () => {
  it("offers what a pod would: the families' official files, the forms ready, nothing offline", async () => {
    t = await makeApp();
    await writeSettings(t.db, { machines: [] });
    const setup = (await t.app.inject({ method: "GET", url: "/api/setup" })).json();
    expect(setup.comfy).toMatchObject({ online: false, planned: true });
    const sdxl = setup.recipes.find((r: { id: string }) => r.id === RECIPE);
    expect(sdxl.ready).toBe(true);
    // listOptions names each list once: the checkpoint input's list holds the official checkpoint
    const lists = setup.lists as string[][];
    const checkpoints = lists[sdxl.options.checkpoint];
    expect(checkpoints).toContain(SDXL_BASE);
    // only SDXL's own: the folder's other families' files (SCAIL-2's SAM 3, LTX's checkpoint) are not SDXL checkpoints
    expect(checkpoints!.every((f) => f === SDXL_BASE)).toBe(true);
    const queue = (await t.app.inject({ method: "GET", url: "/api/queue" })).json();
    expect(queue.online).toBe(true);
    // nothing to download into, said without an error
    const downloads = await t.app.inject({ method: "GET", url: "/api/downloads" });
    expect(downloads.statusCode).toBe(200);
    expect(downloads.json()).toMatchObject({ via: "none", items: [] });
  });

  it("a job waits for a machine, never failing for want of one", async () => {
    t = await makeApp();
    await writeSettings(t.db, { machines: [] });
    await t.services.queue.start();
    const id = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "a lighthouse at noon", checkpoint: SDXL_BASE } })).json().ids[0] as string;
    await new Promise((r) => setTimeout(r, 300));
    const row = await t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "queued", error: null });
  });
});

describe("a family's official file missing on the user's own ComfyUI", () => {
  it("holds the job there with the file to download, and runs it once the file is in", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["illustrious.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
    const id = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "a lighthouse at noon", checkpoint: SDXL_BASE } })).json().ids[0] as string;
    const waiting = async () => (await t!.app.inject({ method: "GET", url: "/api/queue" })).json().waiting.find((w: { id: string }) => w.id === id);
    await until(async () => Boolean((await waiting())?.fetch?.m1));
    expect((await waiting()).fetch.m1.files).toEqual([expect.objectContaining({ file: SDXL_BASE, folder: "checkpoints", url: expect.stringContaining("huggingface.co") })]);
    expect(fake.prompts.size).toBe(0);
    // the file put in (a download ended: its folders read again), the job goes
    fake.models.checkpoints!.push(SDXL_BASE);
    // its loader offers it too, as ComfyUI's node list does once the file is there
    const spec = fake.catalog.CheckpointLoaderSimple!.input.required!.ckpt_name as unknown[];
    const list = Array.isArray(spec[0]) ? (spec[0] as string[]) : (spec[1] as { options: string[] }).options;
    list.push(SDXL_BASE);
    await post(t.app, "/api/setup/rescan");
    await until(() => fake!.prompts.size === 1);
    complete(fake, [...fake.prompts.keys()][0]!);
    await until(async () => (await t!.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
  });

  it("is downloaded on a press even with downloads and lookups off: the press is the consent", async () => {
    t = await makeApp();
    const settings = await readSettings(t.db);
    expect(settings).toMatchObject({ downloadModels: false, civitaiLookups: false });
    const url = t.services.registry.family("sdxl")!.slots.find((s) => s.get?.file === SDXL_BASE)!.get!.url;
    const official = await post(t.app, "/api/downloads", { file: SDXL_BASE, folder: "checkpoints", url });
    expect(official.json().error ?? "").not.toMatch(/turned off/);
    const other = await post(t.app, "/api/downloads", { file: "x.safetensors", folder: "checkpoints", url: "https://example.com/x.safetensors" });
    expect(other.json().error).toMatch(/turned off/);
  });
});

describe("finding a ComfyUI without saving it", () => {
  it("probes an address, and finds the first usual one that answers", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: {} });
    t = await makeApp();
    const probed = (await post(t.app, "/api/setup/probe", { url: `${fake.url}/` })).json();
    expect(probed).toMatchObject({ url: fake.url, online: true, version: expect.any(String) });
    process.env.AFFLATUS_PROBE_URLS = `http://127.0.0.1:9,${fake.url}`;
    const found = (await t.app.inject({ method: "GET", url: "/api/setup/find" })).json();
    expect(found.found).toMatchObject({ url: fake.url, online: true });
    process.env.AFFLATUS_PROBE_URLS = "http://127.0.0.1:9";
    expect((await t.app.inject({ method: "GET", url: "/api/setup/find" })).json().found).toBeNull();
    // nothing was saved
    expect((await readSettings(t.db)).machines.map((m) => m.url)).not.toContain(fake.url);
  });
});
