import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { POD_GONE } from "../src/queueModel";
import { POD_IMAGES } from "../src/runpod";
import { readSettings } from "../src/settings";
import { CHECKPOINT, complete, costToday, get, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * What the 0.8.1 re-check found on real pods (card #150): RunPod refusing a stopped pod's Start (no GPU free on its host),
 * which Deploy on its volume answers through the one deploy path and its caps; a job pinned to a pod that went, which waits
 * and never falls to this PC; a Model set's file whose address every pod's fetch knows.
 */

const KEY = "rpa_test_key_0123456789";
const NO_GPU_ON_HOST = "There are not enough free GPUs on the host machine to start this pod.";
let home: FakeComfy;
let stoppedComfy: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];

beforeEach(async () => {
  home = await makeFake();
  home.models.loras = [];
  stoppedComfy = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50,
    volumes: [{ id: "vol-ro", name: "zz-test models", size: 15, dataCenter: "EU-RO-1" }],
    pods: [{ name: "zz-test-stopped", rate: 0.45, gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 0, containerGb: 40, comfy: stoppedComfy, volumeId: "vol-ro", image: POD_IMAGES.afflatus() }],
    spawn: async () => {
      const c = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
      spawned.push(c);
      return c;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, stoppedComfy, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
});

/** The stopped pod added as a machine (idle 3 min, then stop), read once from RunPod: its machine id. */
async function added(): Promise<string> {
  const id = (await post(t.app, "/api/runpod/add", { pod: runpod.pods[0]!.id })).json().id as string;
  const machines = (await get(t.app, "/api/settings")).json().machines as Array<{ id: string; rented?: Record<string, unknown> }>;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: machines.map((m) => (m.id === id ? { ...m, rented: { ...m.rented, idleMinutes: 3 } } : m)) } });
  await t.services.rented.poll();
  return id;
}

/** RunPod refuses the pod's Start as it did every time on the re-check. */
const refuseStart = () => {
  runpod.failAction[runpod.pods[0]!.id] = 400;
  runpod.failDetail = NO_GPU_ON_HOST;
};

const status = async (id: string) => (await t.db.selectFrom("jobs").select(["status", "pin_machine"]).where("id", "=", id).executeTakeFirstOrThrow());

describe("a Start RunPod refuses for want of a GPU on its host", () => {
  it("is marked for Deploy on its volume, which deploys its GPU on its volume and moves the job pinned to it there", async () => {
    const stopped = await added();
    await t.services.queue.start();
    const jobId = (await post(t.app, "/api/jobs", { ...job(), machine: stopped })).json().ids[0] as string;
    refuseStart();
    const res = await post(t.app, `/api/machines/${stopped}/start`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ redeploy: true, error: expect.stringMatching(/^Start refused: .*Deploy a new pod on its volume/) });

    const offer = (await get(t.app, `/api/machines/${stopped}/redeploy`)).json();
    expect(offer).toMatchObject({ name: "zz-test-stopped", was: "A40", gpu: { id: "NVIDIA A40", name: "A40", price: 0.44 }, same: true, volume: { id: "vol-ro", name: "zz-test models" }, dataCenter: "EU-RO-1", idleMinutes: 3, idleDo: "stop", template: "afflatus", cuda: "13.0", cudaChanged: false, refetch: null });
    // nothing made by the offer
    expect(runpod.pods).toHaveLength(1);

    const made = await post(t.app, `/api/machines/${stopped}/redeploy`, { gpu: "NVIDIA A40" });
    expect(made.statusCode).toBe(200);
    const fresh = made.json().id as string;
    expect(runpod.pods).toHaveLength(2);
    expect(runpod.pods[1]).toMatchObject({ gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", volumeId: "vol-ro", image: POD_IMAGES.afflatus() });
    expect((await readSettings(t.db)).machines.find((m) => m.id === fresh)?.rented).toMatchObject({ idleMinutes: 3, idleDo: "stop", volume: "vol-ro" });
    // the stopped pod is left as it was; the job pinned to it waits for the new one, and runs there
    expect(runpod.pods[0]!.status).toBe("EXITED");
    expect((await status(jobId)).pin_machine).toBe(fresh);
    const pod = spawned[0]!;
    await until(async () => (await t.services.rented.poll(), pod.prompts.size === 1), 15_000);
    complete(pod, [...pod.prompts.keys()][0]!);
    await until(async () => (await status(jobId)).status === "done");
    expect(home.prompts.size).toBe(0);
    expect(stoppedComfy.prompts.size).toBe(0);
  });

  it("offers the cheapest GPU free there with as much memory when its own is not, said as another; never one not confirmed", async () => {
    const stopped = await added();
    // the A40 taken in EU-RO-1; an L4 (24 GB) free there, cheaper but smaller: not offered (the catalog copied: it is shared)
    runpod.gpus = runpod.gpus.map((g) =>
      g.id === "NVIDIA A40" ? { ...g, dataCenters: g.dataCenters.map((d) => (d.id === "EU-RO-1" ? { ...d, availability: "NONE" as const } : d)) }
      : g.id === "NVIDIA L4" ? { ...g, dataCenters: [...g.dataCenters, { id: "EU-RO-1", availability: "HIGH" as const }] } : g);
    const offer = (await get(t.app, `/api/machines/${stopped}/redeploy`)).json();
    expect(offer).toMatchObject({ was: "A40", gpu: { name: "RTX 6000 Ada" }, same: false, sized: true });
    // the GPU the user confirmed is not free any more: refused, nothing made
    const res = await post(t.app, `/api/machines/${stopped}/redeploy`, { gpu: "NVIDIA A40" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/RTX 6000 Ada is the one free there now/);
    expect(runpod.pods).toHaveLength(1);
  });

  it("is refused past a spending cap, and nothing is made", async () => {
    const stopped = await added();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values(costToday("s1")).execute();
    const res = await post(t.app, `/api/machines/${stopped}/redeploy`, { gpu: "NVIDIA A40" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/spending cap/);
    expect(runpod.pods).toHaveLength(1);
  });

  it("is not marked for another refusal of RunPod's", async () => {
    const stopped = await added();
    runpod.failAction[runpod.pods[0]!.id] = 400;
    runpod.failDetail = "pod is locked";
    const res = await post(t.app, `/api/machines/${stopped}/start`, {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().redeploy).toBeUndefined();
  });
});

describe("a job pinned to a pod that went", () => {
  it("waits, still pinned, and is never sent to this PC; moved by the user, it runs", async () => {
    const stopped = await added();
    await t.services.queue.start();
    const jobId = (await post(t.app, "/api/jobs", { ...job(), machine: stopped })).json().ids[0] as string;
    expect((await post(t.app, `/api/machines/${stopped}/stop`, { how: "terminate" })).statusCode).toBe(200);
    await until(async () => !(await get(t.app, "/api/queue")).json().machines.some((m: { id: string }) => m.id === stopped));
    t.services.queue.nudge();
    await new Promise((r) => setTimeout(r, 400));
    expect(await status(jobId)).toEqual({ status: "queued", pin_machine: stopped });
    // its row says so, whatever the layout
    expect((await get(t.app, "/api/queue")).json().waiting.find((w: { id: string }) => w.id === jobId)).toMatchObject({ pinned: stopped, pinGone: true });
    expect(home.prompts.size).toBe(0);
    // queued again pinned to it (Again, a form's Render on kept): refused with why
    const again = await post(t.app, "/api/jobs", { ...job(), machine: stopped });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe(POD_GONE);
    // the user moves it to this PC
    const own = (await get(t.app, "/api/queue")).json().machines.find((m: { rented: unknown }) => !m.rented).id as string;
    expect((await post(t.app, `/api/jobs/${jobId}/machine`, { machine: own })).statusCode).toBe(200);
    await until(() => home.prompts.size === 1);
  });
});

describe("a Model set's file", () => {
  it("has its address known to every pod's fetch, not only to that set's deploys", async () => {
    const url = "https://huggingface.co/zz-test/set-model/resolve/main/zz-set-model.safetensors";
    const saved = await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], files: [{ file: "zz-set-model.safetensors", folder: "checkpoints", url, size: 6_500_000_000 }], off: [] });
    expect(saved.statusCode).toBe(200);
    // what a pod fetches it from, whichever pod (the lookup is read again after a moment)
    await until(async () => (await t.services.podFiles.about({ file: "zz-set-model.safetensors", folder: "checkpoints" })).via === "hf", 5_000);
    expect(await t.services.podFiles.about({ file: "zz-set-model.safetensors", folder: "checkpoints" })).toEqual({ via: "hf", size: 6_500_000_000 });
  });
});
