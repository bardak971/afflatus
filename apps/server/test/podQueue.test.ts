import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings, writeSettings } from "../src/settings";
import { CHECKPOINT, complete, get, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

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
async function deployed(more: Record<string, unknown> = {}): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, ...more });
  expect(res.statusCode).toBe(200);
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
    // the pod's row lists what it got
    expect((await t.services.queue.status()).machines.find((m) => m.id === id)?.rented).toMatchObject({ files: [expect.objectContaining({ file: CHECKPOINT, state: "ready" })] });
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
    expect(waiting?.lacks?.[id]?.failed).toContain("no site is known");
  });

  it("waiting for another job to end is no work for a pod: it does not keep it billed", async () => {
    const id = await deployed();
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    // a job that waits for another (a clip after the one it continues) whose own start is not possible now
    const first = await enqueue({ checkpoint: "nowhere.safetensors" });
    const second = await enqueue();
    await t.db.updateTable("jobs").set({ depends_on: first }).where("id", "=", second).execute();
    await t.db.updateTable("jobs").set({ pin_machine: await homeId() }).where("id", "=", first).execute();
    expect(await t.services.queue.wants(id)).toBe(false);
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
    // its row says the pod could take it, once sent its file, and how long that takes
    const waitingB = (await t.services.queue.status()).waiting.find((w) => w.id === b);
    expect(waitingB).toMatchObject({ machine: await homeId(), fetch: { [id]: { files: [{ file: CHECKPOINT, folder: "checkpoints" }], ms: 10 * 60_000 } } });
    for (const p of [...home.prompts.keys()]) complete(home, p);
    await until(async () => (await row(a)).status === "done");
    await until(() => home.prompts.size === 2);
    complete(home, [...home.prompts.keys()][1]!);
    await until(async () => (await row(b)).status === "done");
  });
});

describe("a deploy's files", () => {
  it("are the waiting jobs' (each once, with how many use it) and the picked set's, with what earlier deploys measured", async () => {
    await post(t.app, "/api/queue/pause", {});
    await enqueue();
    await enqueue({ prompt: "a dog" });
    const set = (await post(t.app, "/api/model-sets", { name: "LoRAs", files: [{ file: "style.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/style.safetensors", size: 300 }] })).json();
    const view = (await get(t.app, `/api/runpod/deploy/models?cloud=SECURE&set=${set.id}`)).json();
    expect(view.jobs.count).toBe(2);
    expect(view.jobs.files).toEqual([expect.objectContaining({ file: CHECKPOINT, folder: "checkpoints", via: "upload", size: 120_000, jobs: 2, first: true })]);
    expect(view.set).toEqual([expect.objectContaining({ file: "style.safetensors", via: "hf", size: 300, off: false })]);
    // nothing measured yet: the page says time and price are not known
    expect(view.speeds).toEqual({ hf: null, civitai: null, url: null, upload: null });
    expect(view.boot).toBeNull();
  });

  it("are handed to the pod at its first answer, the ones left out never fetched, and its boot time kept", async () => {
    const id = await deployed({ files: [{ file: "style.safetensors", folder: "checkpoints" }], leaveOut: [{ file: CHECKPOINT, folder: "checkpoints" }] });
    expect(t.services.podFiles.view(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "style.safetensors", tier: "ahead" }),
      expect.objectContaining({ file: CHECKPOINT, state: "failed", error: "left out when the pod was deployed" }),
    ]));
    // handed once: its record keeps them no more, and the next deploy starts with none
    const settings = await readSettings(t.db);
    expect(settings.machines.find((m) => m.id === id)?.rented).toMatchObject({ files: [], leaveOut: [] });
    expect(settings.lastDeploy).toMatchObject({ files: [], leaveOut: [], accept: [] });
    expect((await t.db.selectFrom("pod_measures").select(["kind", "cloud"]).execute())).toEqual([{ kind: "boot", cloud: "SECURE" }]);
    // a job that uses the file left out stays home
    await post(t.app, "/api/queue/pause", { machine: await homeId() });
    const a = await enqueue();
    await new Promise((r) => setTimeout(r, 200));
    expect(pod.prompts.size).toBe(0);
    expect((await t.services.queue.status()).waiting.find((w) => w.id === a)?.lacks?.[id]).toBeTruthy();
  });

  it("of a preset under a licence are refused until it is accepted in the dialog", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "H3", presets: ["shipped:minimax-h3"] })).json();
    const files = (await get(t.app, `/api/runpod/deploy/models?set=${set.id}`)).json().set.map(({ file, folder }: { file: string; folder: string }) => ({ file, folder }));
    const ask = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: set.id, files };
    const refused = await post(t.app, "/api/runpod/deploy", ask);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/accept it first/);
    expect(runpod.pods).toHaveLength(0);
    expect((await post(t.app, "/api/runpod/deploy", { ...ask, accept: ["shipped:minimax-h3"] })).statusCode).toBe(200);
    expect((await readSettings(t.db)).acceptedPresets).toContain("shipped:minimax-h3");
  });

  it("of a licensed preset are under its licence whichever way they were picked (added by hand, from no set)", async () => {
    const view = (await get(t.app, "/api/runpod/deploy/models")).json();
    // the dialog is told which files each licence covers
    const h3 = view.licences.find((l: { id: string }) => l.id === "shipped:minimax-h3");
    expect(h3.keys).toContain("diffusion_models|minimax_h3_fl2va_pruned_int8_convrot.safetensors");
    const ask = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, files: [{ file: "minimax_h3_fl2va_pruned_int8_convrot.safetensors", folder: "diffusion_models" }] };
    expect((await post(t.app, "/api/runpod/deploy", ask)).json().error).toMatch(/accept it first/);
    expect(runpod.pods).toHaveLength(0);
  });

  it("of the remembered set come again with Deploy again", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "LoRAs", files: [{ file: "style.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/style.safetensors" }] })).json();
    const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15, set: set.id, again: true });
    expect(res.statusCode).toBe(200);
    const machine = (await readSettings(t.db)).machines.find((m) => m.id === res.json().id);
    expect(machine?.rented?.files).toEqual([{ file: "style.safetensors", folder: "loras", url: "https://huggingface.co/o/r/resolve/main/style.safetensors" }]);
  });
});
