import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { imageParts, imagePublic } from "../src/podImage";
import { POD_IMAGES } from "../src/runpod";
import { readSettings } from "../src/settings";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Deploy a GPU (rented.ts deploy) against a pretend RunPod: what is free, a pod made on the user's click only, locked from
 * its first second by a token kept as a RunPod secret, only ComfyUI's port open, added as a machine, and nothing left
 * behind when RunPod refuses.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    volumes: [{ id: "vol-ro", name: "afflatus-models", size: 100, dataCenter: "EU-RO-1" }, { id: "vol-se", name: "far-away", size: 50, dataCenter: "EU-SE-1" }],
    spawn: async () => {
      const c = Object.assign(await makeFake(), { packVersion: "0.13.0" });
      spawned.push(c);
      return c;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  // the registries are not asked from a test: every image is there, unless a test says otherwise
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
  await Promise.all([home, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
});

const ASK = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 };
const deploy = (change: Record<string, unknown> = {}) => post(t.app, "/api/runpod/deploy", { ...ASK, ...change });
const creates = () => runpod.calls.filter((c) => c === "POST /v2/pods").length;

describe("what can be deployed", () => {
  it("lists the GPUs of each cloud with their price and where they are free, and the volumes; nothing without a key", async () => {
    const gpus = (await get(t.app, "/api/runpod/gpus?cloud=SECURE")).json().gpus as Array<{ name: string; price: number; availability: string }>;
    expect(gpus.find((g) => g.name === "A40")).toMatchObject({ price: 0.44, availability: "HIGH" });
    expect(gpus.find((g) => g.name === "RTX 4090")).toMatchObject({ availability: "NONE" });
    // the L4 and the H100 are not on Community Cloud
    const community = (await get(t.app, "/api/runpod/gpus?cloud=COMMUNITY")).json().gpus as Array<{ name: string; price: number }>;
    expect(community.map((g) => g.name)).not.toContain("L4");
    expect(community.find((g) => g.name === "A40")?.price).toBe(0.35);
    expect((await get(t.app, "/api/runpod/volumes")).json().volumes).toHaveLength(2);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: "" } });
    expect((await get(t.app, "/api/runpod/gpus")).statusCode).toBe(409);
  });
});

describe("a deploy", () => {
  it("makes a pod of Afflatus's image, only ComfyUI's port open, its token a secret; adds it as a machine, locked once up", async () => {
    const res = await deploy();
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;
    const pod = runpod.pods[0]!;
    // the freest data center of the A40
    expect(pod).toMatchObject({ gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", ports: ["8188/http"], image: POD_IMAGES.afflatus(), diskGb: 120 });
    const secret = /^\{\{ RUNPOD_SECRET_(afflatus-[a-f0-9]{8}) \}\}$/.exec(pod.env.AFFLATUS_TOKEN ?? "")?.[1];
    expect(secret).toBeTruthy();
    expect(pod.env.AFFLATUS_WATCHDOG_MINUTES).toBe("15");
    const s = await readSettings(t.db);
    const machine = s.machines.find((m) => m.id === id)!;
    expect(runpod.secrets[secret!]).toBe(machine.token);
    expect(machine).toMatchObject({ name: "A40", rented: { pod: pod.id, idleDo: "terminate", idleMinutes: 10, secret, deployed: true } });
    expect(s.lastDeploy).toEqual(ASK);
    expect((await get(t.app, "/api/settings")).json().lastDeploy).toEqual(ASK);
    // up: its ComfyUI locked from its first second with the machine's token
    await until(() => pod.status === "RUNNING");
    expect(pod.comfy.lock).toEqual({ token: machine.token, local: false, fixed: true });
    // a second one gets a name of its own
    await deploy();
    expect((await readSettings(t.db)).machines.map((m) => m.name)).toContain("A40 2");
  });

  it("tries the next data center when the GPU was just taken in the freest, and leaves nothing behind when it is taken everywhere", async () => {
    runpod.noCapacity.add("NVIDIA A40@EU-RO-1");
    expect((await deploy()).statusCode).toBe(200);
    expect(runpod.pods[0]!.dataCenterId).toBe("US-TX-3");
    runpod.noCapacity.add("NVIDIA A40");
    const before = Object.keys(runpod.secrets).length;
    const res = await deploy();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/^No A40 free any more/);
    expect(runpod.pods).toHaveLength(1);
    expect(Object.keys(runpod.secrets)).toHaveLength(before);
  });

  it("with a network volume: mounted, in its data center only", async () => {
    expect((await deploy({ volume: "vol-ro" })).statusCode).toBe(200);
    expect(runpod.pods[0]).toMatchObject({ volumeId: "vol-ro", dataCenterId: "EU-RO-1" });
    // no A40 where that volume is
    const res = await deploy({ volume: "vol-se" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/No A40 free in EU-SE-1, where the volume "far-away" is/);
    expect((await deploy({ volume: "vol-gone" })).statusCode).toBe(409);
  });

  it("is refused at a spending cap without asking RunPod to make anything, and RunPod's balance refusal is said", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values({ id: "s1", machine_id: "rp-x", pod: "x", rate: 1, started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), ended_at: new Date().toISOString(), seen_at: null }).execute();
    const capped = await deploy();
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toMatch(/spending cap/);
    expect(creates()).toBe(0);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0, month: 0 } } });
    runpod.failCreate = 402;
    const poor = await deploy();
    expect(poor.statusCode).toBe(409);
    expect(poor.json().error).toMatch(/balance is too low/);
    expect(runpod.secrets).toEqual({});
  });

  it("terminated, its secret goes with it", async () => {
    const id = (await deploy()).json().id as string;
    expect(Object.keys(runpod.secrets)).toHaveLength(1);
    expect((await post(t.app, `/api/machines/${id}/stop`, { how: "terminate" })).statusCode).toBe(200);
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    expect(runpod.secrets).toEqual({});
  });

  it("a read that sees its pod come up does not start the next read by itself", async () => {
    await deploy();
    await until(() => runpod.pods[0]!.status === "RUNNING");
    await t.services.rented.poll();
    const reads = () => runpod.calls.filter((c) => c === "GET /v2/pods").length;
    const before = reads();
    await new Promise((r) => setTimeout(r, 300));
    expect(reads()).toBe(before);
  });

  it("an answer cut short after RunPod made the pod: found by its name and kept as a machine, its secret kept", async () => {
    runpod.createThenFail = 504;
    const res = await deploy();
    expect(res.statusCode).toBe(200);
    const machine = (await readSettings(t.db)).machines.find((m) => m.id === res.json().id)!;
    expect(machine.rented?.pod).toBe(runpod.pods[0]!.id);
    expect(runpod.secrets[machine.rented!.secret]).toBe(machine.token);
  });

  it("an image that never pulls: terminated 20 min after the deploy, said on its card, its secret gone", async () => {
    runpod.bootMs = 10_000_000;
    const id = (await deploy()).json().id as string;
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("PROVISIONING");
    const real = Date.now;
    t.services.rented.now = () => real() + 19 * 60_000;
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("PROVISIONING");
    t.services.rented.now = () => real() + 21 * 60_000;
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    // a failure stays said on its card, the machine kept until removed
    expect((await t.services.queue.status()).machines.find((m) => m.id === id)?.rented?.stoppedBy).toBe("boot");
    expect(runpod.secrets).toEqual({});
  });

  it("is not idle before its ComfyUI first answered, however long its first boot takes", async () => {
    await deploy();
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    // up on RunPod's side, its ComfyUI not yet (node packs, models)
    pod.comfy.down = true;
    await t.services.rented.poll();
    const real = Date.now;
    t.services.rented.now = () => real() + 15 * 60_000;
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
  });

  it("a pod gone from RunPod is said once, not at every read", async () => {
    await deploy();
    await t.services.rented.poll();
    runpod.pods[0]!.status = "TERMINATED";
    await t.services.rented.poll();
    let setups = 0;
    const count = () => void setups++;
    t.services.queue.events.on("setup", count);
    await t.services.rented.poll();
    await t.services.rented.poll();
    t.services.queue.events.off("setup", count);
    expect(setups).toBe(0);
  });

  it("two deploys at once: the second is refused, one pod made", async () => {
    const [a, b] = await Promise.all([deploy(), deploy()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(runpod.pods).toHaveLength(1);
  });

  it("is refused before anything is made when its image cannot be pulled, and the dialog is told", async () => {
    t.services.rented.imageCheck = async (image) => image !== POD_IMAGES.afflatus();
    expect((await get(t.app, "/api/runpod/images")).json()).toEqual({ afflatus: false, runpod: true });
    const res = await deploy();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/The Afflatus image is not published yet/);
    expect(creates()).toBe(0);
    expect(runpod.secrets).toEqual({});
    expect((await deploy({ template: "runpod" })).statusCode).toBe(200);
  });

  it("counts from its deploy while it provisions: a pod slow to come up reaches a cap too", async () => {
    runpod.bootMs = 10_000_000;
    await deploy();
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).toBe("PROVISIONING");
    expect(await t.db.selectFrom("rent_sessions").selectAll().execute()).toHaveLength(1);
  });

  it("a GPU that does not work on its host: terminated at once, said on its card, its secret gone", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    // the Afflatus image's GPU check failed: broken.py answers on 8188 in ComfyUI's place
    pod.comfy.podBroken = "RuntimeError: CUDA unknown error";
    await t.services.rented.poll();
    expect(pod.status).toBe("TERMINATED");
    const row = (await t.services.queue.status()).machines.find((m) => m.id === id);
    expect(row?.rented).toMatchObject({ stoppedBy: "gpu", status: "GONE" });
    expect(row?.rented?.error).toMatch(/its GPU did not work on that host \(RuntimeError: CUDA unknown error\)/);
    expect(runpod.secrets).toEqual({});
  });

  it("its first start is said as a step, not an error, until it drags", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    pod.comfy.down = true;
    await t.services.rented.poll();
    const real = Date.now;
    t.services.rented.now = () => real() + 5 * 60_000;
    let row = (await t.services.queue.status()).machines.find((m) => m.id === id)!;
    expect(row.rented).toMatchObject({ booting: true, error: null });
    t.services.rented.now = () => real() + 13 * 60_000;
    await t.services.rented.poll();
    row = (await t.services.queue.status()).machines.find((m) => m.id === id)!;
    expect(row.rented?.error).toMatch(/^Its first start is taking long/);
  });

  it("RunPod's ComfyUI image when asked for", async () => {
    await deploy({ template: "runpod" });
    expect(runpod.pods[0]!.image).toBe(POD_IMAGES.runpod());
  });
});

describe("a deployed pod removed, or left out of a list", () => {
  it("removed from Afflatus while it runs: left on RunPod, its secret kept until the pod is gone, then deleted", async () => {
    const id = (await deploy()).json().id as string;
    const secret = (await readSettings(t.db)).machines.find((m) => m.id === id)!.rented!.secret;
    expect((await post(t.app, `/api/machines/${id}/remove`, {})).statusCode).toBe(200);
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(false);
    await t.services.rented.poll();
    expect(runpod.pods[0]!.status).not.toBe("TERMINATED");
    expect(runpod.secrets[secret]).toBeTruthy();
    // terminated on RunPod's site later: its secret goes at the next read
    runpod.pods[0]!.status = "TERMINATED";
    await t.services.rented.poll();
    expect(runpod.secrets).toEqual({});
    expect((await readSettings(t.db)).leftSecrets).toEqual([]);
  });

  it("a list of machines sent from an older page keeps it, and what only the server knows of it", async () => {
    const before = (await readSettings(t.db)).machines.map(({ token: _token, ...m }) => m);
    const id = (await deploy()).json().id as string;
    // the page's list from before the deploy
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines: before } });
    const kept = (await readSettings(t.db)).machines.find((m) => m.id === id);
    expect(kept?.rented?.deployed).toBe(true);
    // its idle set from the page; its secret and its deploy as the server has them, whatever the page sent
    const machines = (await readSettings(t.db)).machines.map(({ token: _token, ...m }) => (m.id === id ? { ...m, rented: { ...m.rented!, idleMinutes: 30, secret: "afflatus-other", deployedAt: "" } } : m));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines } });
    const after = (await readSettings(t.db)).machines.find((m) => m.id === id)!.rented!;
    expect(after.idleMinutes).toBe(30);
    expect(after.secret).toBe(kept!.rented!.secret);
    expect(after.deployedAt).toBe(kept!.rented!.deployedAt);
  });
});

describe("whether an image can be pulled", () => {
  it("reads Docker Hub and GHCR names, and asks the registry for the manifest", async () => {
    expect(imageParts("runpod/comfyui:1.4.0")).toMatchObject({ registry: "https://registry-1.docker.io", repo: "runpod/comfyui", tag: "1.4.0" });
    expect(imageParts("python")).toMatchObject({ repo: "library/python", tag: "latest" });
    expect(imageParts("ghcr.io/owner/afflatus-pod:0.1.0")).toMatchObject({ registry: "https://ghcr.io", repo: "owner/afflatus-pod", tag: "0.1.0" });
    expect(imageParts("quay.io/x/y:1")).toBeNull();
    const answer = (manifest: number) => (async (url: string | URL | Request) => (String(url).includes("/token") ? new Response(JSON.stringify({ token: "t" }), { status: 200 }) : new Response(null, { status: manifest }))) as typeof fetch;
    expect(await imagePublic("ghcr.io/owner/afflatus-pod:0.1.0", answer(200))).toBe(true);
    expect(await imagePublic("ghcr.io/owner/afflatus-pod:0.1.0", answer(404))).toBe(false);
    expect(await imagePublic("ghcr.io/owner/afflatus-pod:0.1.0", answer(503))).toBeNull();
    expect(await imagePublic("ghcr.io/owner/afflatus-pod:0.1.0", (async () => { throw new Error("offline"); }) as typeof fetch)).toBeNull();
  });
});
