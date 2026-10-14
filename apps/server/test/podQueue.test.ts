import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings, writeSettings } from "../src/settings";
import { CHECKPOINT, complete, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A deployed pod that lacks a job's model file (queue.ts with podFiles.ts): the job may still go there, its file sent
 * first, when that is where it ends soonest; where this computer is sooner it stays home and the file is sent ahead; a
 * file that cannot be had keeps the job off the pod, and never keeps the pod billed.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
let comfyDir: string;
let podDisk: string;

beforeEach(async () => {
  home = await makeFake();
  podDisk = mkdtempSync(join(tmpdir(), "afflatus-poddisk-"));
  mkdirSync(join(podDisk, "checkpoints"));
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      // a fresh pod: another checkpoint only, the pack that takes uploads, its model folders on a disk of its own
      pod = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: ["other.safetensors"], upscale_models: [] }, folderPaths: { checkpoints: [join(podDisk, "checkpoints")] }, hideFolderPaths: true });
      pod.packVersion = "0.14.0";
      return pod;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  // this computer's ComfyUI folder: it has the job's checkpoint, which no site is known for, so it is sent from here
  comfyDir = mkdtempSync(join(tmpdir(), "afflatus-comfydir-"));
  mkdirSync(join(comfyDir, "models", "checkpoints"), { recursive: true });
  writeFileSync(join(comfyDir, "models", "checkpoints", CHECKPOINT), Buffer.alloc(120_000, 5));
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  t.services.podFiles.uploadBackoffMs = 10;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY, downloadModels: true, civitaiLookups: true } });
  await writeSettings(t.db, { comfyDir });
  await t.services.queue.start();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
  await Promise.all([home, runpod, pod].map((x) => x?.close().catch(() => {})));
});

/** A pod deployed and up, as a machine of Afflatus. */
async function deployed(): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
  const id = res.json().id as string;
  await until(() => runpod.pods[0]?.status === "RUNNING");
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  return id;
}
const row = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const homeId = async () => (await readSettings(t.db)).machines[0]!.id;

describe("a job whose model file a pod lacks", () => {
  it("goes to the pod when that is where it ends soonest: its file is sent first, then it runs there", async () => {
    const id = await deployed();
    // this computer paused: the pod is the only place it can run
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const a = await enqueue();
    await until(() => pod.prompts.size === 1, 15_000);
    expect(pod.packUploaded.length).toBeGreaterThan(0);
    expect(t.services.podFiles.view(id)).toEqual([expect.objectContaining({ file: CHECKPOINT, state: "ready", tier: "need", via: "upload", jobs: [a] })]);
    complete(pod, [...pod.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
    expect((await row(a)).machine_id).toBe(id);
    expect(home.prompts.size).toBe(0);
  });

  it("stays home when home is sooner, and its file is sent to the pod ahead, for later", async () => {
    const id = await deployed();
    const a = await enqueue();
    await until(() => home.prompts.size === 1);
    await until(() => t.services.podFiles.view(id)[0]?.state === "ready", 15_000);
    expect(t.services.podFiles.view(id)[0]).toMatchObject({ file: CHECKPOINT, tier: "ahead", jobs: [] });
    expect(pod.prompts.size).toBe(0);
    complete(home, [...home.prompts.keys()][0]!);
    await until(async () => (await row(a)).status === "done");
    expect((await row(a)).machine_id).toBe(await homeId());
  });

  it("that cannot be had: kept off the pod, and a job pinned there does not keep the pod billed", async () => {
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    // a file no site is known for, and this computer has none either
    const a = await enqueue({ checkpoint: "nowhere.safetensors" });
    home.models.checkpoints = [CHECKPOINT, "other.safetensors", "nowhere.safetensors"];
    await post(t.app, `/api/setup/rescan?machine=${await homeId()}`, {});
    expect((await post(t.app, `/api/jobs/${a}/machine`, { machine: id })).statusCode).toBe(200);
    await until(() => t.services.podFiles.view(id)[0]?.state === "failed", 15_000);
    expect(t.services.podFiles.view(id)[0]!.error).toContain("no site is known");
    await new Promise((r) => setTimeout(r, 100));
    expect(pod.prompts.size).toBe(0);
    // nothing the pod can ever run: no work, so its idle time runs
    expect(await t.services.queue.wants(id)).toBe(false);
    const waiting = (await t.services.queue.status()).waiting.find((w) => w.id === a);
    expect(waiting?.lacks?.[id]?.files).toEqual([{ file: "nowhere.safetensors", folder: "checkpoints" }]);
  });

  it("is no work for a pod the plan sends it away from", async () => {
    const id = await deployed();
    // renders known to take a second (as learned renders would say): this computer's running one ends in a second
    (t.services.queue as unknown as { expected: () => Promise<number> }).expected = async () => 1_000;
    // this computer busy with one job, a second waiting: home is still sooner than the pod with its file to come
    const a = await enqueue();
    await until(() => home.prompts.size === 1);
    // the file the first job's sending ahead put on the pod is taken off it again, and the pod looked at again
    await until(() => t.services.podFiles.view(id)[0]?.state !== "fetching");
    t.services.podFiles.forget(id);
    rmSync(join(podDisk, "checkpoints", CHECKPOINT), { force: true });
    await post(t.app, `/api/setup/rescan?machine=${id}`, {});
    // its file takes ten minutes to reach the pod
    t.services.queue.podFetch!.untilThere = async () => 10 * 60_000;
    const b = await enqueue({ prompt: "a dog" });
    // the plan sends it home (its file would take longer to reach the pod than home takes): the pod has no work
    expect(await t.services.queue.wants(id)).toBe(false);
    for (const p of [...home.prompts.keys()]) complete(home, p);
    await until(async () => (await row(a)).status === "done");
    await until(() => home.prompts.size === 2);
    complete(home, [...home.prompts.keys()][1]!);
    await until(async () => (await row(b)).status === "done");
  });
});
