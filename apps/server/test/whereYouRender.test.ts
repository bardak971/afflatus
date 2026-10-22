import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { migrate, openSqlite } from "../src/db";
import { readSettings, seedNewInstall, updateSettings, writeSettings } from "../src/settings";
import type { QueueOptions } from "../src/queue";
import { complete, FAST, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Where you render (card #20, the owner 2026-10-20): a new install starts with no ComfyUI expected, every family on, the
 * first launch to show and caps on rented GPUs; with no machine, nothing is offline and the forms offer what a pod would;
 * a job that lacks only a family's official file on the user's own ComfyUI waits there for its Download, never fetched unasked.
 */

const SDXL_BASE = "sd_xl_base_1.0.safetensors";

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

  it("drops the old ComfyUI's folder when the address moves to another one, and keeps it for the same one", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    await seedNewInstall(db);
    await writeSettings(db, { comfyUrl: "http://127.0.0.1:8000", comfyDir: "/zz-test/ComfyUI" });
    expect((await writeSettings(db, { comfyUrl: "http://127.0.0.1:8000/" })).comfyDir).toBe("/zz-test/ComfyUI");
    const moved = await writeSettings(db, { comfyUrl: "http://127.0.0.1:8188" });
    expect(moved.comfyDir).toBe("");
    expect(moved.machines[0]!.dir).toBe("");
    await db.destroy();
  });

  it("never keeps a pod's address as the one offered for the user's own ComfyUI once the pod is gone", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    await seedNewInstall(db);
    const pod = "https://zz-test-8188.proxy.runpod.net";
    await updateSettings(db, () => ({ machines: [{ id: "p1", url: pod, rented: { provider: "runpod", pod: "zz-test" } }] }));
    // the pod removed: the list empty, the address the one before it, not the pod's
    const none = await updateSettings(db, () => ({ machines: [] }));
    expect(none.machines).toEqual([]);
    expect(none.comfyUrl).not.toBe(pod);
    await db.destroy();
  });

  it("drops a pod's address kept from before, its pod removed since, when the settings are read", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    await seedNewInstall(db);
    // written so by a version that kept the last machine's address, whatever it was
    await db.deleteFrom("settings").where("key", "=", "comfyUrl").execute();
    await db.insertInto("settings").values({ key: "comfyUrl", value: JSON.stringify("https://zz-test-8188.proxy.runpod.net"), updated_at: new Date().toISOString() }).execute();
    await writeSettings(db, { unloadAfterMinutes: 0 });
    const read = await readSettings(db);
    expect(read.machines).toEqual([]);
    expect(read.comfyUrl).toBe("http://127.0.0.1:8188");
    await db.destroy();
  });

  it("keeps the user's own pod address of an install from before the list of machines, read and after a folder is written", async () => {
    const db = openSqlite(":memory:");
    await migrate(db);
    // 0.3.0 and 0.4.0 stored only `comfyUrl`: a RunPod address there is a pod of the user's own, typed in by hand
    const pod = "https://zz-test-8188.proxy.runpod.net";
    await db.insertInto("settings").values({ key: "comfyUrl", value: JSON.stringify(pod), updated_at: new Date().toISOString() }).execute();
    const read = await readSettings(db);
    expect(read.comfyUrl).toBe(pod);
    expect(read.machines.map((m) => [m.id, m.url, m.rented])).toEqual([["m1", pod, undefined]]);
    // what the folder found at the first answer writes (services.ts comfyFolder) keeps the address
    const written = await writeSettings(db, { comfyDir: "/zz-test/ComfyUI" });
    expect(written.machines.map((m) => m.url)).toEqual([pod]);
    expect((await readSettings(db)).comfyUrl).toBe(pod);
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
    // port 0: the system gives the server a free port as it listens, read back from it; a port found free first and bound
    // after could be taken in between by a test running beside this one
    const started = await start({ host: "127.0.0.1", port: 0, dataDir: dir, databaseUrl: "" }, { log: quiet as never });
    try {
      const { port } = started.app.server.address() as AddressInfo;
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
    // the queue's pass over the line, begun by the enqueue, is waited for to its end: a fixed wait could look before it
    // ran on a loaded machine, and the check would pass without testing anything
    await t.services.queue.idle();
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

  it("notices a file put in by hand, its machine's folders read again while the job waits", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["illustrious.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    // a minute in use: a twentieth of a second here
    (t.services.queue as unknown as { opts: QueueOptions }).opts = { ...FAST, filesRetryMs: 50 };
    await t.services.queue.start();
    const id = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "a lighthouse at noon", checkpoint: SDXL_BASE } })).json().ids[0] as string;
    const waiting = async () => (await t!.app.inject({ method: "GET", url: "/api/queue" })).json().waiting.find((w: { id: string }) => w.id === id);
    await until(async () => Boolean((await waiting())?.fetch?.m1));
    // put in by hand: nothing tells Afflatus, no rescan is pressed
    fake.models.checkpoints!.push(SDXL_BASE);
    const spec = fake.catalog.CheckpointLoaderSimple!.input.required!.ckpt_name as unknown[];
    const list = Array.isArray(spec[0]) ? (spec[0] as string[]) : (spec[1] as { options: string[] }).options;
    list.push(SDXL_BASE);
    await until(() => fake!.prompts.size === 1);
  });

  it("lists only the awaited files' folders while the job waits, ComfyUI's node list read again once one is there", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["illustrious.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    (t.services.queue as unknown as { opts: QueueOptions }).opts = { ...FAST, filesRetryMs: 50 };
    await t.services.queue.start();
    const comfy = await t.services.comfy();
    const catalogs = vi.spyOn(comfy.client, "catalog");
    const id = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "a lighthouse at noon", checkpoint: SDXL_BASE } })).json().ids[0] as string;
    const waiting = async () => (await t!.app.inject({ method: "GET", url: "/api/queue" })).json().waiting.find((w: { id: string }) => w.id === id);
    await until(async () => Boolean((await waiting())?.fetch?.m1));
    const before = catalogs.mock.calls.length;
    // many "minutes" waiting: the node list is not read again for any of them
    await new Promise((r) => setTimeout(r, 600));
    expect(catalogs.mock.calls.length).toBe(before);
    fake.models.checkpoints!.push(SDXL_BASE);
    const spec = fake.catalog.CheckpointLoaderSimple!.input.required!.ckpt_name as unknown[];
    const list = Array.isArray(spec[0]) ? (spec[0] as string[]) : (spec[1] as { options: string[] }).options;
    list.push(SDXL_BASE);
    await until(() => fake!.prompts.size === 1);
    expect(catalogs.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not hold a job on a lone ComfyUI for a file only its workflow's author gives an address for, downloads off", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["illustrious.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    // the address an imported workflow's author gives for its checkpoint (Recipe.files), not a family's official file
    const recipe = t.services.registry.recipe(RECIPE)! as { files?: unknown };
    const files = recipe.files;
    recipe.files = [{ classType: "CheckpointLoaderSimple", input: "ckpt_name", file: "zz-test-authors.safetensors", url: "https://example.com/zz-test-authors.safetensors" }];
    try {
      await t.services.queue.start();
      const id = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "a lighthouse at noon", checkpoint: "zz-test-authors.safetensors" } })).json().ids[0] as string;
      // it goes to ComfyUI, which says what it lacks, as a lone ComfyUI always did: no wait with no Download
      await until(async () => fake!.prompts.size === 1 || (await t!.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "failed");
      const waiting = (await t.app.inject({ method: "GET", url: "/api/queue" })).json().waiting.find((w: { id: string }) => w.id === id);
      expect(waiting?.fetch?.m1).toBeUndefined();
    } finally {
      recipe.files = files;
    }
  });

  it("holds that job for its Download once downloads and lookups are on", async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["illustrious.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
    await writeSettings(t.db, { downloadModels: true, civitaiLookups: true });
    const recipe = t.services.registry.recipe(RECIPE)! as { files?: unknown };
    const files = recipe.files;
    recipe.files = [{ classType: "CheckpointLoaderSimple", input: "ckpt_name", file: "zz-test-authors.safetensors", url: "https://example.com/zz-test-authors.safetensors" }];
    try {
      await t.services.queue.start();
      const id = (await post(t.app, "/api/jobs", { recipe: RECIPE, input: { prompt: "a lighthouse at noon", checkpoint: "zz-test-authors.safetensors" } })).json().ids[0] as string;
      const waiting = async () => (await t!.app.inject({ method: "GET", url: "/api/queue" })).json().waiting.find((w: { id: string }) => w.id === id);
      await until(async () => Boolean((await waiting())?.fetch?.m1));
      expect((await waiting()).fetch.m1.files).toEqual([expect.objectContaining({ file: "zz-test-authors.safetensors", url: "https://example.com/zz-test-authors.safetensors" })]);
      expect(fake.prompts.size).toBe(0);
    } finally {
      recipe.files = files;
    }
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

describe("the user's ComfyUI on this machine, added by its address", () => {
  it("has its base folder found on ComfyUI Desktop or with --base-directory (no main.py beside custom_nodes)", async () => {
    const { mkdirSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "afflatus-comfy-base-"));
    try {
      mkdirSync(join(dir, "custom_nodes"));
      mkdirSync(join(dir, "models", "checkpoints"), { recursive: true });
      fake = await startFakeComfy({ catalog: referenceCatalog(), models: {}, folderPaths: { checkpoints: [join(dir, "models", "checkpoints")], custom_nodes: [join(dir, "custom_nodes")] } });
      t = await makeApp();
      await writeSettings(t.db, { machines: [] });
      expect((await post(t.app, "/api/setup/probe", { url: fake.url })).json()).toMatchObject({ dir, local: true });
      const saved = (await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } })).json();
      expect(saved.comfyDir).toBe(dir);
      expect(existsSync(join(dir, "custom_nodes", "afflatus-nodes"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not take a custom_nodes folder's parent that is neither ComfyUI's folder nor a base folder", async () => {
    const { mkdirSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "afflatus-comfy-odd-"));
    try {
      mkdirSync(join(dir, "custom_nodes"));
      fake = await startFakeComfy({ catalog: referenceCatalog(), models: {}, folderPaths: { custom_nodes: [join(dir, "custom_nodes")] } });
      t = await makeApp();
      expect((await post(t.app, "/api/setup/probe", { url: fake.url })).json()).toMatchObject({ dir: null, local: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has its folder looked for again when it first answers, when it did not say it as its address was saved", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "afflatus-comfy-later-"));
    try {
      mkdirSync(join(dir, "custom_nodes"));
      writeFileSync(join(dir, "main.py"), "");
      fake = await startFakeComfy({ catalog: referenceCatalog(), models: {}, folderPaths: { custom_nodes: [join(dir, "custom_nodes")] }, hideFolderPaths: true });
      t = await makeApp();
      await writeSettings(t.db, { machines: [] });
      // added while it says nothing of its folders (off, as far as that goes): no folder, but said to be on this PC
      const saved = (await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } })).json();
      expect(saved.comfyDir).toBe("");
      expect(saved.machines[0]).toMatchObject({ url: fake.url, local: true });
      expect((await t.app.inject({ method: "GET", url: "/api/settings" })).json().machines[0].local).toBe(true);
      // it answers (a page reads its load): its folder found then, and the node pack written in
      fake.hideFolderPaths = false;
      (await t.services.comfy()).monitor.ensure();
      await until(async () => (await readSettings(t!.db)).comfyDir === dir);
      await until(() => existsSync(join(dir, "custom_nodes", "afflatus-nodes")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a folder emptied by hand empty, at every start, until its address changes", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "afflatus-comfy-emptied-"));
    const pack = join(dir, "custom_nodes", "afflatus-nodes");
    try {
      mkdirSync(join(dir, "custom_nodes"));
      writeFileSync(join(dir, "main.py"), "");
      fake = await startFakeComfy({ catalog: referenceCatalog(), models: {}, folderPaths: { custom_nodes: [join(dir, "custom_nodes")] } });
      t = await makeApp();
      await writeSettings(t.db, { machines: [] });
      expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } })).json().comfyDir).toBe(dir);
      // emptied in Settings › ComfyUI: not looked for again, at a start (its first answer) or a save of the list
      expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyDir: "" } })).json().comfyDir).toBe("");
      rmSync(pack, { recursive: true, force: true });
      expect(await t.services.comfyFolder()).toBeNull();
      const listed = (await t.app.inject({ method: "GET", url: "/api/settings" })).json().machines;
      expect(listed[0]).not.toHaveProperty("dirCleared");
      expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ ...listed[0], name: "zz-test" }] } })).json().comfyDir).toBe("");
      expect(existsSync(pack)).toBe(false);
      // the same emptied from its machine card is remembered too
      await writeSettings(t.db, { comfyDir: dir });
      const card = (await t.app.inject({ method: "GET", url: "/api/settings" })).json().machines[0];
      expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: [{ ...card, dir: "" }] } })).json().comfyDir).toBe("");
      expect(await t.services.comfyFolder()).toBeNull();
      // another address: looked for there
      const other = fake.url.replace("127.0.0.1", "localhost");
      expect((await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: other } })).json().comfyDir).toBe(dir);
      expect(existsSync(pack)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not said to be on this PC for a host name that only starts with 127.", async () => {
    t = await makeApp();
    await writeSettings(t.db, { machines: [] });
    const saved = (await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: "http://127.example.net:8188" } })).json();
    expect(saved.machines[0].local).toBe(false);
  });

  it("has its folder found from what it says, and Afflatus's node pack written in", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "afflatus-comfy-"));
    try {
      mkdirSync(join(dir, "custom_nodes"));
      mkdirSync(join(dir, "models", "checkpoints"), { recursive: true });
      writeFileSync(join(dir, "main.py"), "");
      fake = await startFakeComfy({ catalog: referenceCatalog(), models: {}, folderPaths: { checkpoints: [join(dir, "models", "checkpoints")], custom_nodes: [join(dir, "custom_nodes")] } });
      t = await makeApp();
      await writeSettings(t.db, { machines: [] });
      // the first launch's probe says it too, for its words
      expect((await post(t.app, "/api/setup/probe", { url: fake.url })).json().dir).toBe(dir);
      const saved = (await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } })).json();
      expect(saved.comfyDir).toBe(dir);
      expect(existsSync(join(dir, "custom_nodes", "afflatus-nodes"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
