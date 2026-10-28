import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { unlistOptions } from "@afflatus/core";
import { keepListing } from "../src/rentedVolumes";
import { readSettings, updateSettings } from "../src/settings";
import { CHECKPOINT, complete, costToday, get, job, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Where model files are across the machines (filePlaces.ts, card #139): a file only a pod lists is said as the pod's, a
 * stopped pod's volume and the set it was deployed with are offered, a job that picks one waits for that pod (its row
 * offering Start, which the spending caps refuse as on the Rented GPUs page), never sent to this PC; with no pod left, a
 * file no machine has is refused as the job is queued.
 */

const KEY = "rpa_test_key_0123456789";
const POD_ONLY = "zz-test-pod-only.safetensors";
const SET_LORA = "zz-test-set-lora.safetensors";
const VOLUME_LORA = "zz-test-volume-lora.safetensors";
let home: FakeComfy;
let podComfy: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

beforeEach(async () => {
  home = await makeFake();
  // a ComfyUI lists its LoRA folder, empty or not (one not listed is not held against a job)
  home.models.loras = [];
  podComfy = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT, POD_ONLY], loras: [], upscale_models: [] } });
  runpod = await startFakeRunpod({ key: KEY, bootMs: 50, pods: [{ name: "zz-test-a40", rate: 0.4, gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 50, comfy: podComfy }] });
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
  await Promise.all([home, podComfy, runpod].map((x) => x.close().catch(() => {})));
});

const pod = () => runpod.pods[0]!;
/** The pod added as a machine, stopped (as RunPod lists it), read once from RunPod. */
async function added(): Promise<string> {
  const id = (await post(t.app, "/api/runpod/add", { pod: pod().id })).json().id as string;
  await t.services.rented.poll();
  return id;
}
const setup = async () => unlistOptions((await post(t.app, "/api/setup/rescan", {})).json());
const checkpoints = (s: Awaited<ReturnType<typeof setup>>) => s.recipes.find((r: { id: string }) => r.id === "sdxl.text-to-picture")!.options.checkpoint as string[];

describe("the lists across machines", () => {
  it("says a file only a running pod lists is the pod's, and one on both is on both", async () => {
    const id = await added();
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), pod().status === "RUNNING"));
    await until(async () => checkpoints(await setup()).includes(POD_ONLY));
    const s = await setup();
    const home1 = (await readSettings(t.db)).machines[0]!.id;
    expect(s.places.on.checkpoints[POD_ONLY]).toEqual([id]);
    expect(s.places.on.checkpoints[CHECKPOINT].sort()).toEqual([home1, id].sort());
    expect(s.places.on.checkpoints["other.safetensors"]).toEqual([home1]);
    expect(s.places.down).toEqual({});
    // its header is read on the pod, so that it is grouped by what it is for as this PC's files are
    await until(async () => POD_ONLY in (await get(t.app, "/api/models/checkpoints/info")).json().items);
  });

  it("says nothing of where files are with the user's own machines alone", async () => {
    const s = await setup();
    expect(s.places).toEqual({ offered: {}, down: {} });
  });

  it("offers a stopped pod's volume files and its set's, and says the pod is stopped", async () => {
    const id = await added();
    const set = (await post(t.app, "/api/model-sets", { name: "zz-test Portraits", files: [{ file: SET_LORA, folder: "loras", url: "https://huggingface.co/x/y/resolve/main/zz.safetensors" }] })).json();
    await updateSettings(t.db, (cur) => ({ machines: cur.machines.map((m) => (m.id === id ? { ...m, rented: { ...m.rented!, volume: "vol-1", set: set.id, setFiles: [{ file: SET_LORA, folder: "loras", size: 2_000_000 }] } } : m)) }));
    await keepListing(t.db, "vol-1", [{ key: `comfyui/models/loras/${VOLUME_LORA}`, folder: "loras", name: VOLUME_LORA, bytes: 1_000_000, modified: null, comfy: "loras" }], id, true);
    const s = await setup();
    expect(s.places.down).toEqual({ [id]: "stopped" });
    expect(s.places.offered.loras).toEqual([
      { file: VOLUME_LORA, pod: id, via: "volume", bytes: 1_000_000 },
      { file: SET_LORA, pod: id, via: "set", set: "zz-test Portraits", bytes: 2_000_000 },
    ]);
    // the lists stay the ComfyUIs' own: an offered file is not among them
    expect(checkpoints(s)).not.toContain(POD_ONLY);
  });
});

describe("a job for a stopped pod's file", () => {
  const holding = async () => {
    const id = await added();
    await updateSettings(t.db, (cur) => ({ machines: cur.machines.map((m) => (m.id === id ? { ...m, rented: { ...m.rented!, volume: "vol-1" } } : m)) }));
    await keepListing(t.db, "vol-1", [{ key: `comfyui/models/loras/${VOLUME_LORA}`, folder: "loras", name: VOLUME_LORA, bytes: 1_000_000, modified: null, comfy: "loras" }], id, true);
    return id;
  };

  it("waits for that pod with Start, and is never sent to this PC", async () => {
    const id = await holding();
    await t.services.queue.start();
    const queued = await post(t.app, "/api/jobs", job({ loras: [{ file: VOLUME_LORA, weight: 0.8 }] }));
    expect(queued.statusCode).toBe(200);
    const jobId = queued.json().ids[0] as string;
    let w: { startPod: string | null; runsOn: string[] | null; lacks: Record<string, { why?: string }> | null } | undefined;
    await until(async () => {
      w = (await get(t.app, "/api/queue")).json().waiting.find((x: { id: string }) => x.id === jobId);
      return Boolean(w?.startPod);
    });
    expect(w!.startPod).toBe(id);
    expect(w!.runsOn).toEqual([]);
    expect(w!.lacks![id]!.why).toBe("the pod is stopped");
    // a few passes later it still waits, this PC sent nothing
    await new Promise((r) => setTimeout(r, 300));
    expect((await t.db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow()).status).toBe("queued");
    expect(home.prompts.size).toBe(0);
  });

  it("is not held for a pod when a machine that runs has its files", async () => {
    await holding();
    await t.services.queue.start();
    const jobId = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => home.prompts.size === 1);
    complete(home, [...home.prompts.keys()][0]!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow()).status === "done");
  });

  it("Start is refused past a spending cap, as on the Rented GPUs page", async () => {
    const id = await holding();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values(costToday("s1")).execute();
    const capped = await post(t.app, `/api/machines/${id}/start`, {});
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toMatch(/spending cap/);
    expect(pod().status).toBe("EXITED");
  });
});

describe("with no pod left", () => {
  it("refuses at queue time a file no machine has, and takes one that is there or has a download", async () => {
    const refused = await post(t.app, "/api/jobs", job({ loras: [{ file: VOLUME_LORA, weight: 0.8 }] }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(new RegExp(`${VOLUME_LORA} is on no machine: your ComfyUI does not list it in models/loras`));
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
    // put in by hand a moment ago: its list is read afresh before refusing
    home.models.loras = [VOLUME_LORA];
    const jobId = (await post(t.app, "/api/jobs", job({ loras: [{ file: VOLUME_LORA, weight: 0.8 }] }))).json().ids[0] as string;
    expect(jobId).toBeTruthy();
    await t.services.queue.start();
    await until(() => home.prompts.size === 1);
    complete(home, [...home.prompts.keys()][0]!);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", jobId).executeTakeFirstOrThrow()).status === "done");
  });

  it("refuses nothing while a pod is in the settings", async () => {
    await added();
    expect((await post(t.app, "/api/jobs", job({ loras: [{ file: "zz-test-nowhere.safetensors", weight: 0.8 }] }))).statusCode).toBe(200);
  });
});
