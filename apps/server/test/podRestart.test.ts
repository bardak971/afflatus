import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { h3 } from "@afflatus/recipes";
import { Runpod } from "../src/runpod";
import { readSettings, writeSettings } from "../src/settings";
import { makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A rented pod without a volume whose container restarted (card #336). On 2026-11-06 a pod's environment changed through
 * RunPod's API restarted its container, its disk came back empty, and Krea 2 failed twice "came to its pod, and its ComfyUI
 * did not list it": Afflatus still held the files it had sent there, and fetched nothing. Its restart is seen (RunPod says
 * its start anew), the files gone are fetched again, and the next job runs; a volume's files, still listed, are not.
 */

const KEY = "rpa_test_key_0123456789";
const DASIWA = "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors";
const get_ = (id: string) => h3.slots.find((s) => s.id === id)!.get!;
const TE = get_("clip").file;
const BYTES = Buffer.alloc(300_000, 5);
let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let site: Server;
let siteUrl: string;
let disk: string;
let t: TestApp;

beforeEach(async () => {
  // the site H3's text encoder comes from, from any byte asked for
  site = createServer((req, res) => {
    const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
    const body = BYTES.subarray(from);
    res.writeHead(from ? 206 : 200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  // a site of this machine fetched from, as a pretend Civitai's is (outbound.ts civitaiSites)
  vi.stubEnv("CIVITAI_URL", siteUrl);
  home = await makeFake();
  // the pod's container disk: its text encoders' folder a real one, what the pack fetches lands in it and is listed from it
  disk = mkdtempSync(join(tmpdir(), "afflatus-restart-"));
  mkdirSync(join(disk, "text_encoders"));
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      pod = await startFakeComfy({ catalog: referenceCatalog(), models: { diffusion_models: [DASIWA], text_encoders: [], vae: [get_("videoVae").file, get_("audioVae").file], frame_interpolation: [get_("rife").file], checkpoints: [], loras: [] }, folderPaths: { text_encoders: [join(disk, "text_encoders")] }, hideFolderPaths: true });
      // the node pack that fetches files onto it
      pod.packVersion = "0.50.2";
      return pod;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  t.services.rented.uptimeEveryMs = 0;
  t.services.downloads.packEveryMs = 10;
  t.services.downloads.listedEveryMs = 10;
  t.services.downloads.signer = async (source) => ({ url: source });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
  await writeSettings(t.db, { downloadModels: true, civitaiLookups: true });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, pod].map((x) => x?.close().catch(() => {})));
  site.closeAllConnections();
  await new Promise((r) => site.close(r));
});

async function deployed(): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
  expect(res.statusCode).toBe(200);
  const id = res.json().id as string;
  await until(() => runpod.pods[0]?.status === "RUNNING");
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  return id;
}

const job = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const pinned = async (machine: string) => (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "a red ball rolls", seconds: 5, model: DASIWA, smooth: false }, machine })).json().ids[0] as string;
const onDisk = () => existsSync(join(disk, "text_encoders", TE));

/** The pod session sends H3's text encoder there: fetched by the pod's pack, onto its disk. */
async function sent(id: string): Promise<void> {
  t.services.podFiles.want(id, [{ file: TE, folder: "text_encoders", url: `${siteUrl}/te/${TE}` }], { tier: "ahead" });
  await until(() => t.services.podFiles.fileState(id, "text_encoders", TE)?.state === "ready", 15_000);
  expect(onDisk()).toBe(true);
  expect(pod.packFetched).toHaveLength(1);
}

/**
 * Its container started again, as a real RunPod says it (the #336 pod test): its list keeps its first start and says no
 * uptime; its GraphQL's uptime starts again from now.
 */
async function restarted(): Promise<void> {
  // up ten minutes by its last read
  runpod.pods[0]!.upAt = new Date(Date.now() - 10 * 60_000).toISOString();
  await uptimeRead();
  runpod.pods[0]!.upAt = new Date().toISOString();
  await uptimeRead();
}

/** Its uptime as RunPod's GraphQL says it now, read: asked apart from the follow, its answer taken at the read after. */
async function uptimeRead(): Promise<void> {
  await t.services.rented.poll();
  await new Promise((r) => setTimeout(r, 100));
  await t.services.rented.poll();
}

describe("a rented pod's container restarted (card #336)", () => {
  it("without a volume, its disk empty: the restart is seen, the file it was sent is fetched again, and the next job runs instead of failing", async () => {
    const id = await deployed();
    await sent(id);
    const recheck = vi.spyOn(t.services.podFiles, "recheck");
    // its disk came back empty
    rmSync(join(disk, "text_encoders", TE));
    await restarted();
    expect(recheck).toHaveBeenCalledWith(id, true, expect.any(Number));
    const a = await pinned(id);
    await until(() => pod.prompts.size === 1, 20_000);
    expect(onDisk()).toBe(true);
    expect(pod.packFetched).toHaveLength(2);
    expect(await job(a)).toMatchObject({ status: "running", error: null });
    // its card says it, and the file's row: the row turns ready a moment after the job is sent (a loaded CI saw "fetching")
    const rowOf = async () => (await t.app.inject({ method: "GET", url: "/api/queue" })).json().machines.find((m: { id: string }) => m.id === id);
    await until(async () => (await rowOf()).rented.files.find((f: { file: string }) => f.file === TE)?.state === "ready", 10_000, 50);
    const row = await rowOf();
    expect(row.rented.again).toMatchObject({ lost: 1, files: 1, restart: true });
    expect(row.rented.files.find((f: { file: string }) => f.file === TE)).toMatchObject({ state: "ready", again: "restart" });
  }, 40_000);

  it("on a network volume, its file still there: nothing is fetched, and the job runs", async () => {
    const id = await deployed();
    await sent(id);
    await restarted();
    await until(() => t.services.podFiles.againOf(id) !== null, 10_000);
    expect(t.services.podFiles.againOf(id)).toMatchObject({ lost: 0, restart: true });
    const a = await pinned(id);
    await until(() => pod.prompts.size === 1, 20_000);
    expect(pod.packFetched).toHaveLength(1);
    expect(await job(a)).toMatchObject({ status: "running", error: null });
  }, 40_000);

  it("stopped and started again: a new container, not one restarted, and nothing said or read again for it (P2)", async () => {
    const id = await deployed();
    runpod.pods[0]!.upAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await uptimeRead();
    const recheck = vi.spyOn(t.services.podFiles, "recheck");
    expect((await post(t.app, `/api/machines/${id}/stop`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "EXITED"));
    await t.services.rented.poll();
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING" && Boolean(runpod.pods[0].upAt)), 15_000);
    for (let i = 0; i < 3; i++) await uptimeRead();
    expect(recheck.mock.calls.filter(([m, container]) => m === id && container)).toEqual([]);
  }, 40_000);

  it("stopped and started again before any read saw it stopped: still a new container, not one restarted (P2)", async () => {
    // the 0.10.1 pod test: Stop at 19:29:17, Start 6 s later, before the follow read the pod EXITED; its uptime from the
    // run before (about 5 min) stood, the new run's 18 s was lower, and its log said "its container restarted"
    const id = await deployed();
    runpod.pods[0]!.upAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await uptimeRead();
    const recheck = vi.spyOn(t.services.podFiles, "recheck");
    expect((await post(t.app, `/api/machines/${id}/stop`, {})).statusCode).toBe(200);
    await until(() => runpod.pods[0]?.status === "EXITED");
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]?.status === "RUNNING" && Boolean(runpod.pods[0].upAt)), 15_000);
    for (let i = 0; i < 3; i++) await uptimeRead();
    expect(recheck.mock.calls.filter(([m, container]) => m === id && container)).toEqual([]);
  }, 40_000);

  it("RunPod's GraphQL hanging holds no read of the pods: their caps and idle times are not held behind it (P4)", async () => {
    await deployed();
    // the read its boot asked, answered
    await uptimeRead();
    const hang = vi.spyOn(Runpod.prototype, "uptime").mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 3000)));
    const from = Date.now();
    await t.services.rented.poll();
    expect(hang).toHaveBeenCalled();
    expect(Date.now() - from).toBeLessThan(1500);
    hang.mockRestore();
  }, 20_000);

  it("its restart not seen (RunPod said nothing): the job's submit finds the file gone, has it fetched again, and runs, no attempt spent", async () => {
    const id = await deployed();
    await sent(id);
    rmSync(join(disk, "text_encoders", TE));
    const a = await pinned(id);
    await until(() => pod.prompts.size === 1, 30_000);
    expect(pod.packFetched).toHaveLength(2);
    expect(await job(a)).toMatchObject({ status: "running", error: null, attempts: 1 });
  }, 60_000);
});
