import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { imageParts, imagePublic } from "../src/podImage";
import { runwayNeed } from "../src/rented";
import { POD_IMAGES } from "../src/runpod";
import { readSettings } from "../src/settings";
import { costToday, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

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
    expect(pod).toMatchObject({ gpu: "NVIDIA A40", dataCenterId: "EU-RO-1", ports: ["8188/http"], image: POD_IMAGES.afflatus(), diskGb: 0, containerGb: 120 });
    const secret = /^\{\{ RUNPOD_SECRET_(afflatus-[a-f0-9]{8}) \}\}$/.exec(pod.env.AFFLATUS_TOKEN ?? "")?.[1];
    expect(secret).toBeTruthy();
    expect(pod.env.AFFLATUS_WATCHDOG_MINUTES).toBe("15");
    const s = await readSettings(t.db);
    const machine = s.machines.find((m) => m.id === id)!;
    expect(runpod.secrets[secret!]).toBe(machine.token);
    expect(machine).toMatchObject({ name: "A40", rented: { pod: pod.id, idleDo: "terminate", idleMinutes: 10, secret, deployed: true, makeRoom: true } });
    expect(s.lastDeploy).toEqual({ ...ASK, set: "", files: [], leaveOut: [], accept: [], again: false, makeRoom: true });
    expect((await get(t.app, "/api/settings")).json().lastDeploy).toEqual({ ...ASK, set: "", files: [], leaveOut: [], accept: [], again: false, makeRoom: true });
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

  it("one pod at a time on a volume: another deploy on it is refused while it runs, said by whom; free again once it stops", async () => {
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    const volumes = () => get(t.app, "/api/runpod/volumes").then((r) => r.json().volumes as Array<{ id: string; usedBy: { name: string; status: string } | null; mountedOn: unknown[]; perMonth: number }>);
    expect((await volumes()).find((v) => v.id === "vol-ro")).toMatchObject({ usedBy: { name: "A40" }, perMonth: 7 });
    expect((await volumes()).find((v) => v.id === "vol-se")?.usedBy).toBeNull();
    const again = await deploy({ volume: "vol-ro", idleDo: "stop" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/The volume "afflatus-models" is in use by A40/);
    expect(creates()).toBe(1);
    // stopped: mounted still (it cannot be deleted), but free for another pod
    const machine = (await readSettings(t.db)).machines.find((m) => m.rented)!;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await post(t.app, `/api/machines/${machine.id}/stop`, { how: "stop" });
    await until(async () => runpod.pods[0]!.status === "EXITED");
    const after = (await volumes()).find((v) => v.id === "vol-ro")!;
    expect(after.usedBy).toBeNull();
    expect(after.mountedOn).toHaveLength(1);
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
  });

  it("a pod RunPod does not list yet holds its volume: two deploys in a row never take one", async () => {
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    runpod.failList = null;
    // RunPod's list a moment behind: the pod just made is not in it
    const made = runpod.pods.splice(0, 1);
    const again = await deploy({ volume: "vol-ro", idleDo: "stop" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/in use by A40 \(starting\)/);
    runpod.pods.push(...made);
  });

  it("keeps what a volume holds as its pod listed it, and says per Model set what is there, once no pod runs on it", async () => {
    const set = await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], off: [], files: [
      { file: "illustrious.safetensors", folder: "checkpoints", size: 6_000_000_000 },
      { file: "zz-test-missing.safetensors", folder: "loras", size: 200_000_000 },
    ] });
    expect(set.statusCode).toBe(200);
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    type Seen = { id: string; holds: { count: number; seenBy: string } | null; usedAt: string | null; sets: Array<{ name: string; missing: { count: number; bytes: number } }> };
    const ro = async () => ((await get(t.app, "/api/runpod/volumes")).json().volumes as Seen[]).find((v) => v.id === "vol-ro")!;
    // nothing known before its pod answers
    expect((await ro()).holds).toBeNull();
    await until(async () => (await t.services.rented.poll(), (await ro()).holds !== null));
    const seen = await ro();
    expect(seen.holds).toMatchObject({ count: 2, seenBy: "A40" });
    expect(seen.usedAt).not.toBeNull();
    expect(seen.sets).toEqual([{ id: expect.any(String), name: "zz-test set", missing: { count: 1, bytes: 200_000_000, unknown: 0 } }]);
    // the pod gone: what the volume holds stays, as last seen
    runpod.pods.splice(0);
    const after = (await get(t.app, "/api/runpod/volumes")).json().volumes as Seen[];
    expect(after.find((v) => v.id === "vol-ro")?.holds?.count).toBe(2);
    expect(after.find((v) => v.id === "vol-se")?.holds).toBeNull();
  });

  it("says what storage costs, with no pod at all: the volumes' bill this month, the pods' disks within it, a month as it stands", async () => {
    const day = new Date();
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).toISOString();
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    runpod.volumeBill = [{ networkVolumeId: "vol-ro", startTime: start, endTime: end, totalAmount: 0.23 }];
    runpod.bill = [{ podId: "gone-pod", startTime: start, endTime: end, totalAmount: 0.5, diskAmount: 0.02 }];
    const spending = (await get(t.app, "/api/rented/spending")).json().spending;
    // a key and no machine: storage still bills, so it is read
    expect(spending.storage).toMatchObject({ volumesMonth: 0.23, disksMonth: 0.02, volumes: 2, stoppedDisks: 0 });
    // 150 GB of volumes at $0.07
    expect(spending.storage.perMonth).toBeCloseTo(10.5, 5);
    // storage is never counted against the caps: the month is the pods' bill alone
    expect(spending.month).toBeCloseTo(0.5, 5);
  });

  it("plans a volume: the data centers with GPUs in stock (the user's pods there first), the size the sets want", async () => {
    await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], off: [], files: [{ file: "zz-test.safetensors", folder: "loras", size: 30_000_000_000 }] });
    expect((await deploy()).statusCode).toBe(200);
    const plan = (await get(t.app, "/api/runpod/volumes/plan")).json();
    // the A40 deployed in EU-RO-1: that place first; the RTX 4090 is in stock nowhere
    expect(plan.places[0]).toMatchObject({ dataCenter: "EU-RO-1", pods: 1, gpus: [{ name: "A40", price: 0.44 }, { name: "RTX 6000 Ada", price: 0.77 }] });
    expect(plan.places.flatMap((p: { gpus: Array<{ name: string }> }) => p.gpus.map((g) => g.name))).not.toContain("RTX 4090");
    // 30 GB and a quarter more, in tens
    expect(plan).toMatchObject({ sizeGb: 40, sets: [{ name: "zz-test set", bytes: 30_000_000_000 }] });
  });

  it("fills a volume from a set: the cheapest GPU there, no render given to it, terminated once its files are in", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { downloadModels: true } });
    const set = (await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], off: [], files: [
      { file: "illustrious.safetensors", folder: "checkpoints", url: "https://huggingface.co/zz-test/x/resolve/main/illustrious.safetensors", size: 6_000_000_000 },
    ] })).json().id as string;
    const plan = (await get(t.app, `/api/runpod/volumes/vol-ro/fill?set=${set}`)).json();
    // never seen: all of the set is missing; the A40 is the cheapest in stock in EU-RO-1
    expect(plan).toMatchObject({ gpu: { name: "A40", price: 0.44 }, missing: { count: 1, bytes: 6_000_000_000 } });
    const res = await post(t.app, "/api/runpod/volumes/vol-ro/fill", { set });
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;
    expect(runpod.pods[0]).toMatchObject({ gpu: "NVIDIA A40", volumeId: "vol-ro", dataCenterId: "EU-RO-1" });
    const s = await readSettings(t.db);
    expect(s.machines.find((m) => m.id === id)?.rented).toMatchObject({ fill: true, volume: "vol-ro", files: [{ file: "illustrious.safetensors", folder: "checkpoints" }] });
    // not the user's deploy: the next one does not start from it
    expect(s.lastDeploy).toBeNull();
    // no render goes to it, though nothing else can take one
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    const queued = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    expect(await t.services.queue.wants(id)).toBe(false);
    // up, its file there already: the volume listed, the pod terminated, the machine gone
    await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.some((m) => m.id === id)), 15_000);
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    expect((await t.db.selectFrom("jobs").select("status").where("id", "=", queued).executeTakeFirstOrThrow()).status).toBe("queued");
    const ro = ((await get(t.app, "/api/runpod/volumes")).json().volumes as Array<{ id: string; holds: { count: number } | null; sets: Array<{ missing: { count: number } }> }>).find((v) => v.id === "vol-ro")!;
    expect(ro.holds?.count).toBe(2);
    expect(ro.sets[0]?.missing.count).toBe(0);
    expect((ro as unknown as { lastFill: { failed: unknown[] } }).lastFill.failed).toEqual([]);
  });

  it("a fill whose files fail ends all the same (nothing left to fetch), and the volume's row says which failed", async () => {
    const set = (await post(t.app, "/api/model-sets", { name: "zz-test nowhere", presets: [], off: [], files: [{ file: "zz-test-nowhere.safetensors", folder: "loras", size: 1000 }] })).json().id as string;
    const id = (await post(t.app, "/api/runpod/volumes/vol-ro/fill", { set })).json().id as string;
    await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.some((m) => m.id === id)), 15_000);
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    const ro = ((await get(t.app, "/api/runpod/volumes")).json().volumes as Array<{ id: string; lastFill: { failed: Array<{ file: string }> } | null }>).find((v) => v.id === "vol-ro")!;
    expect(ro.lastFill?.failed.map((f) => f.file)).toEqual(["zz-test-nowhere.safetensors"]);
  });

  it("flags a volume no pod ran on for the days set (counted from when Afflatus first saw one never used); 0: never", async () => {
    type V = { id: string; unused: boolean };
    const unused = async () => ((await get(t.app, "/api/runpod/volumes")).json().volumes as V[]).filter((v) => v.unused).map((v) => v.id);
    // first seen now: not flagged yet
    expect(await unused()).toEqual([]);
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await t.db.updateTable("volume_files").set({ noticed_at: eightDaysAgo }).where("volume_id", "=", "vol-se").execute();
    expect(await unused()).toEqual(["vol-se"]);
    // used 8 days ago: flagged too; a pod on it now: not
    await t.db.updateTable("volume_files").set({ used_at: eightDaysAgo }).where("volume_id", "=", "vol-ro").execute();
    await t.db.updateTable("volume_files").set({ noticed_at: eightDaysAgo }).where("volume_id", "=", "vol-ro").execute();
    expect((await unused()).sort()).toEqual(["vol-ro", "vol-se"]);
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    expect(await unused()).toEqual(["vol-se"]);
    // said with the spending, for the Settings tab's flag
    const storage = (await get(t.app, "/api/rented/spending")).json().spending.storage;
    expect(storage.unused).toEqual([{ id: "vol-se", name: "far-away", perMonth: 3.5, usedAt: null }]);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { volumeUnusedDays: 0 } });
    expect(await unused()).toEqual([]);
  });

  it("makes, grows and deletes a volume; never smaller, never one a pod is mounted on", async () => {
    const made = await post(t.app, "/api/runpod/volumes", { name: "zz-test volume", size: 20, dataCenter: "EU-RO-1" });
    expect(made.statusCode).toBe(200);
    const id = made.json().volume.id as string;
    expect(runpod.volumes.find((v) => v.id === id)).toMatchObject({ name: "zz-test volume", size: 20, dataCenter: "EU-RO-1" });
    expect((await post(t.app, "/api/runpod/volumes", { name: "too small", size: 5, dataCenter: "EU-RO-1" })).statusCode).toBe(400);
    const grow = (size: number) => t.app.inject({ method: "PATCH", url: `/api/runpod/volumes/${id}`, payload: { size } });
    expect((await grow(30)).statusCode).toBe(200);
    expect(runpod.volumes.find((v) => v.id === id)?.size).toBe(30);
    expect((await grow(25)).statusCode).toBe(400);
    // a pod on it, even stopped, keeps it from being deleted
    expect((await deploy({ volume: id, idleDo: "stop" })).statusCode).toBe(200);
    const del = () => t.app.inject({ method: "DELETE", url: `/api/runpod/volumes/${id}` });
    const refused = await del();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/mounted on A40/);
    // terminated on RunPod's side (its machine up and answering first: no longer a deploy under way)
    await until(async () => (await t.services.rented.poll(), (await readSettings(t.db)).machines.find((m) => m.rented)?.rented?.deployedAt === ""));
    runpod.pods.splice(0);
    expect((await del()).statusCode).toBe(200);
    expect(runpod.volumes.find((v) => v.id === id)).toBeUndefined();
    expect((await del()).statusCode).toBe(404);
  });

  it("is refused at a spending cap without asking RunPod to make anything, and RunPod's balance refusal is said", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    // $2 spent in the last ten minutes (within today, whatever the hour)
    await t.db.insertInto("rent_sessions").values(costToday("s1")).execute();
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
    // up on RunPod's side, its ComfyUI not yet (node packs, models)
    runpod.comfyStaysDown = true;
    await deploy();
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    const real = Date.now;
    t.services.rented.now = () => real() + 15 * 60_000;
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
  });

  it("a pod gone from RunPod is said once, not at every read", async () => {
    // one that never came up: its machine stays, said gone (one that came up goes from Afflatus: see below)
    runpod.comfyStaysDown = true;
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
    // neither build of the Afflatus image published
    t.services.rented.imageCheck = async (image) => !image.startsWith(POD_IMAGES.afflatus());
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
    runpod.comfyStaysDown = true;
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
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

  it("asks no registry on the internet in the demo and the tests (AFFLATUS_PRETEND_SITES): not known", async () => {
    vi.stubEnv("AFFLATUS_PRETEND_SITES", "1");
    const asked = vi.spyOn(globalThis, "fetch");
    try {
      expect(await imagePublic("runpod/comfyui:1.4.0")).toBeNull();
      expect(asked).not.toHaveBeenCalled();
    } finally {
      asked.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

describe("what the rented GPUs cost: RunPod's bill as the truth", () => {
  const spending = async () => (await get(t.app, "/api/rented/spending")).json().spending as { today: number; month: number; billed: boolean; runwayMs: number | null; spendPerHr: number | null };
  const hourAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("a pod RunPod has billed in full costs what RunPod billed, higher or lower than Afflatus's count", async () => {
    // a run of another pod that ended 7 hours ago: Afflatus counted $0.50, RunPod billed $0.62
    await t.db.insertInto("rent_sessions").values({ id: "old", machine_id: "rp-old", pod: "old", rate: 0.5, started_at: hourAgo(8), ended_at: hourAgo(7), seen_at: null }).execute();
    runpod.bill = [{ podId: "old", startTime: hourAgo(8), endTime: hourAgo(7), totalAmount: 0.62 }];
    await deploy();
    const s = await spending();
    expect(s.billed).toBe(true);
    expect(s.month).toBeGreaterThanOrEqual(0.62);
    expect(s.month).toBeLessThan(0.63);
  });

  it("a pod that runs counts the higher of RunPod's bill so far and Afflatus's count, from its deploy", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployed).toBe(true);
    // RunPod has billed more than Afflatus has counted so far: its figure
    runpod.bill = [{ podId: pod.id, startTime: hourAgo(1), endTime: new Date().toISOString(), totalAmount: 0.3 }];
    t.services.rented.now = (() => { const real = Date.now; return () => real() + 6 * 60_000; })();
    expect((await spending()).month).toBeGreaterThanOrEqual(0.3);
    // RunPod's bill not readable: Afflatus's count alone, said so
    runpod.bill = null;
    t.services.rented.now = (() => { const real = Date.now; return () => real() + 12 * 60_000; })();
    const s = await spending();
    expect(s.billed).toBe(false);
    expect(s.month).toBeGreaterThan(0);
  });

  it("a deployed pod's run starts at its deploy", async () => {
    runpod.bootMs = 400;
    const before = Date.now();
    await deploy();
    await until(() => runpod.pods[0]!.status === "RUNNING");
    await t.services.rented.poll();
    const run = (await t.db.selectFrom("rent_sessions").selectAll().execute())[0]!;
    expect(Date.parse(run.started_at) - before).toBeLessThan(300);
    // its GPU and its idle kept with it, and its ComfyUI's first answer: where its boot ended (the Costs tab)
    expect(run).toMatchObject({ gpu: runpod.pods[0]!.gpu, idle_minutes: 10 });
    await until(async () => Boolean((await t.db.selectFrom("rent_sessions").select("up_at").executeTakeFirstOrThrow()).up_at) || (await t.services.rented.poll(), false));
    const up = (await t.db.selectFrom("rent_sessions").select(["up_at", "started_at"]).executeTakeFirstOrThrow());
    expect(Date.parse(up.up_at!)).toBeGreaterThanOrEqual(Date.parse(up.started_at));
  });

  it("says how long the balance lasts at what the account spends now, and holds back a job longer than that", async () => {
    await deploy();
    await until(() => runpod.pods[0]!.status === "RUNNING");
    runpod.balance = 0.0733; // ten minutes at $0.44/h
    t.services.rented.now = (() => { const real = Date.now; return () => real() + 61_000; })();
    const s = await spending();
    // the A40, its 120 GB container disk while it runs, and the account's volumes, as RunPod says it
    expect(s.spendPerHr).toBeCloseTo(0.44 + (120 * 0.1) / 730 + runpod.volumes.reduce((n, v) => n + v.size * 0.07, 0) / 730, 9);
    expect(s.runwayMs).toBeGreaterThan(8 * 60_000);
    expect(s.runwayMs).toBeLessThan(10 * 60_000);
    // a 5-minute render does not fit in what is left, with its margin; nothing known of a job's length: not held back
    expect(t.services.rented.fitsBalance(5 * 60_000).ok).toBe(false);
    expect(t.services.rented.fitsBalance(null).ok).toBe(true);
  });
});

describe("a render longer than the balance lasts", () => {
  it("is not sent to a rented pod: it waits, and its row says why", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    // ten minutes of balance at what the pod costs; home paused, so that the pod is the only machine that could take it
    runpod.balance = 0.0733;
    t.services.rented.now = (() => { const real = Date.now; return () => real() + 61_000; })();
    await get(t.app, "/api/rented/spending");
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    // a render known to take half an hour (its forecast, as learned renders would give it)
    (t.services.queue as unknown as { expected: () => Promise<number> }).expected = async () => 30 * 60_000;
    const queued = (await post(t.app, "/api/jobs", job())).json();
    await new Promise((r) => setTimeout(r, 300));
    expect(t.services.queue.runningOn(id)).toBe(false);
    const row = (await t.services.queue.status()).waiting.find((w) => w.id === queued.ids[0]);
    // a pod with no render of its own: its forecast weighed half again (a new pod's came out at half its truth)
    expect(row?.lacks?.[id]?.balance?.needMs).toBe(45 * 60_000);
  });

  it("with no forecast at all is weighed at half an hour: nothing like it rendered yet, it went whatever the balance", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    runpod.balance = 0.0733;
    t.services.rented.now = (() => { const real = Date.now; return () => real() + 61_000; })();
    await get(t.app, "/api/rented/spending");
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    (t.services.queue as unknown as { expected: () => Promise<number | null> }).expected = async () => null;
    const queued = (await post(t.app, "/api/jobs", job())).json();
    await new Promise((r) => setTimeout(r, 300));
    expect(t.services.queue.runningOn(id)).toBe(false);
    const row = (await t.services.queue.status()).waiting.find((w) => w.id === queued.ids[0]);
    expect(row?.lacks?.[id]?.balance?.needMs).toBe(30 * 60_000);
    // its files still to come on top, sure or not
    expect(runwayNeed({ renderMs: null, fetchMs: 4 * 60_000, sure: true })).toBe(34 * 60_000);
  });

  it("a new pod's forecast is weighed half again, its files still to come on top; as it is once the pod rendered the recipe 3 times", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    const rented = t.services.rented;
    // the review's case: a 2000 Ada told 9.8 min from another machine's renders, 21.5 min true, on a 21 min runway
    const fits = (need: number) => rented.fitsBalance.call({ runwayMs: () => 21 * 60_000 } as unknown as typeof rented, need).ok;
    expect(fits(9.8 * 60_000)).toBe(true);
    expect(fits(await rented.balanceNeed(id, "sdxl.text-to-picture", 9.8 * 60_000, 0))).toBe(false);
    expect(await rented.balanceNeed(id, "sdxl.text-to-picture", 10 * 60_000, 4 * 60_000)).toBe(19 * 60_000);
    // a file with no source to come from counts nothing: the job never starts there for it, whatever the balance
    expect(await rented.balanceNeed(id, "sdxl.text-to-picture", 10 * 60_000, Infinity)).toBe(15 * 60_000);
    const at = new Date().toISOString();
    await t.db.insertInto("render_stats").values(["a", "b", "c"].map((x) => ({
      id: `zz-${x}`, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "sdxl", model_file: "sdxl", time_key: "", kind: "image" as const, width: 1024, height: 1024,
      duration_ms: null, steps: 20, status: "done" as const, whole: 1, cold: 0, waited_ms: 0, total_ms: 10_000, load_ms: 0, sample_ms: 10_000, refine_ms: 0, finish_ms: 0, step_ms: 500,
      expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null, work: 1024 * 1024, machine_id: id, gpu: null, created_at: at,
    }))).execute();
    (rented as unknown as { sureKept: unknown }).sureKept = null;
    expect(await rented.balanceNeed(id, "sdxl.text-to-picture", 10 * 60_000, 4 * 60_000)).toBe(14 * 60_000);
    // another recipe there is still new to it
    expect(await rented.balanceNeed(id, "wan.i2v", 10 * 60_000, 0)).toBe(15 * 60_000);
  });

  it("a pod whose GPU's pace is learned has its forecast weighed as it is", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    const at = new Date().toISOString();
    const row = (n: string, machine: string, gpu: string, stepMs: number) => ({
      id: `zz-${n}`, owner_id: "local", recipe_id: "sdxl.text-to-picture", family: "sdxl", model: "sdxl", model_file: "sdxl", time_key: "k", kind: "image" as const, width: 1024, height: 1024,
      duration_ms: null, steps: 20, status: "done" as const, whole: 1, cold: 0, waited_ms: 0, total_ms: stepMs * 20, load_ms: 0, sample_ms: stepMs * 20, refine_ms: 0, finish_ms: 0, step_ms: stepMs,
      expected_ms: null, vram_peak: null, heat_peak: null, asset_id: null, work: 1024 * 1024, machine_id: machine, gpu, created_at: at,
    });
    // an earlier pod of the same GPU, compared with the home card on the same settings three times each
    await t.db.insertInto("render_stats").values([0, 1, 2].flatMap((i) => [row(`h${i}`, "m1", "NVIDIA GeForce RTX 4070 Ti", 500), row(`p${i}`, "rp-old", pod.gpu, 300)])).execute();
    expect(await t.services.rented.balanceNeed(id, "sdxl.text-to-picture", 10 * 60_000, 0)).toBe(10 * 60_000);
  });
});

describe("a deployed pod the user stopped", () => {
  it("stays stopped across a restart of Afflatus: never taken for one its watchdog stopped, never terminated for it", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
    expect((await post(t.app, `/api/machines/${id}/stop`, { how: "stop" })).statusCode).toBe(200);
    await until(async () => (await t.services.rented.poll(), pod.status === "EXITED"));
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.userStopped).toBe(true);
    // Afflatus restarted: what it knew in memory of the pod is gone
    (t.services.rented as unknown as { seen: Map<string, unknown> }).seen.clear();
    await t.services.rented.poll();
    await t.services.rented.poll();
    expect(pod.status).toBe("EXITED");
    expect(runpod.calls.filter((c) => c.endsWith("action terminate"))).toEqual([]);
    // started again: no longer the user's stop
    await post(t.app, `/api/machines/${id}/start`, {});
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.userStopped).toBe(false);
  });
});

describe("a deployed pod gone from RunPod", () => {
  it("that came up once: taken out of Afflatus at the second read that misses it, never at the first", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
    // terminated by its watchdog while Afflatus was away
    pod.status = "TERMINATED";
    await t.services.rented.poll();
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(true);
    await t.services.rented.poll();
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(false);
    expect(runpod.secrets).toEqual({});
  });

  it("that never came up: kept, so that its card says why", async () => {
    runpod.comfyStaysDown = true;
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    pod.status = "TERMINATED";
    await t.services.rented.poll();
    await t.services.rented.poll();
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(true);
  });
});

describe("the image's build and the watchdog's end", () => {
  it("CUDA 13 where the GPU's hosts offer it, 12.8 where not", async () => {
    await deploy();
    expect(runpod.pods[0]!.image).toBe(POD_IMAGES.afflatus());
    runpod.gpus = runpod.gpus.map((g) => (g.id === "NVIDIA L4" ? { ...g, cuda13: false } : g));
    await deploy({ gpu: "NVIDIA L4" });
    expect(runpod.pods[1]!.image).toBe(`${POD_IMAGES.afflatus()}-cu128`);
  });

  it("a pod without a volume: its watchdog terminates it; found stopped while Afflatus was away, Afflatus terminates what is left", async () => {
    const id = (await deploy()).json().id as string;
    const pod = runpod.pods[0]!;
    expect(pod.env.AFFLATUS_WATCHDOG_ACTION).toBe("terminate");
    await until(() => pod.status === "RUNNING");
    await t.services.rented.poll();
    // its watchdog stopped it (an older pack, or RunPod's own stop)
    pod.status = "EXITED";
    pod.diskGb = 0;
    await t.services.rented.poll();
    expect(pod.status).toBe("TERMINATED");
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(false);
    expect(runpod.secrets).toEqual({});
  });

  it("with a volume, its watchdog stops it as its idle does", async () => {
    await deploy({ volume: "vol-ro", idleDo: "stop" });
    expect(runpod.pods[0]!.env.AFFLATUS_WATCHDOG_ACTION).toBe("stop");
  });
});

describe("a fill of a volume always ends, and never says all in when it is not", () => {
  type Left = { left: number; total: number; bytes: number; waiting: string[]; failed: Array<{ file: string; error: string }> };
  const real = Date.now;
  const waiting = (bytes = 0): Left => ({ left: 1, total: 1, bytes, waiting: ["zz-test.safetensors"], failed: [] });
  const nothing: Left = { left: 0, total: 0, bytes: 0, waiting: [], failed: [] };

  /** A fill deployed and up (its first answer seen), its files as the test says: what podFiles would say of them. */
  async function upFill(left: () => Left) {
    const set = (await post(t.app, "/api/model-sets", { name: "zz-test set", presets: [], off: [], files: [
      { file: "zz-test.safetensors", folder: "checkpoints", url: "https://huggingface.co/zz-test/x/resolve/main/zz-test.safetensors", size: 6_000_000_000 },
    ] })).json().id as string;
    const rented = t.services.rented;
    const handed: string[] = [];
    rented.onUp = (machine) => handed.push(machine);
    rented.filesLeft = () => left();
    const id = (await post(t.app, "/api/runpod/volumes/vol-ro/fill", { set })).json().id as string;
    await until(async () => (await rented.poll(), (await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt === ""));
    return { id, handed, rented };
  }
  const lastFill = async () => ((await get(t.app, "/api/runpod/volumes")).json().volumes as Array<{ id: string; lastFill: { failed: Array<{ file: string; error: string }>; interrupted?: string } | null }>).find((v) => v.id === "vol-ro")!.lastFill;
  const gone = async (id: string) => !(await readSettings(t.db)).machines.some((m) => m.id === id);

  it("its ComfyUI gone silent: terminated at its idle time, noted cut short with the files not in", async () => {
    const { id, handed, rented } = await upFill(() => waiting());
    expect(handed).toEqual([id]);
    // what it was handed is kept until it ends (handed again after a restart)
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.files).toHaveLength(1);
    runpod.pods[0]!.comfy.down = true;
    rented.now = () => real() + 4 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    rented.now = () => real() + 6 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    expect(await gone(id)).toBe(true);
    expect(await lastFill()).toMatchObject({ interrupted: "its ComfyUI stopped answering", failed: [{ file: "zz-test.safetensors", error: expect.stringMatching(/not fetched/) }] });
  });

  it("its files stuck while its ComfyUI answers: cut short after 30 min of nothing", async () => {
    const { id, rented } = await upFill(() => waiting());
    rented.now = () => real() + 29 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    rented.now = () => real() + 31 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    expect(await gone(id)).toBe(true);
    expect((await lastFill())?.interrupted).toBe("nothing came for 30 min");
  });

  it("moving, but past its time (2 h and its bytes at 10 MB/s): cut short", async () => {
    let bytes = 0;
    const { id, rented } = await upFill(() => waiting((bytes += 1000)));
    // 6 GB: 2 h 10 min
    rented.now = () => real() + 129 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    rented.now = () => real() + 131 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    expect(await gone(id)).toBe(true);
    expect((await lastFill())?.interrupted).toMatch(/still not done after 13\d min/);
  });

  it("after a restart of Afflatus: handed again and carried on; an empty view is never read as all in", async () => {
    let given = true;
    const { id, handed, rented } = await upFill(() => (given ? waiting() : nothing));
    // restarted: podFiles has nothing of the pod, Rented reads it afresh
    given = false;
    (rented as unknown as { seen: Map<string, unknown> }).seen.clear();
    rented.onUp = (machine) => {
      handed.push(machine);
      given = true;
    };
    await rented.poll();
    expect(handed).toEqual([id, id]);
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    // what it was handed lost again, and handing it brings nothing into view: still not done
    given = false;
    rented.onUp = () => {};
    await rented.poll();
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("RUNNING");
    expect(await lastFill()).toBeNull();
  });

  it("at a spending cap: terminated, never left stopped on its volume, and noted cut short", async () => {
    let bytes = 0;
    const { id, rented } = await upFill(() => waiting((bytes += 1000)));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    await t.db.insertInto("rent_sessions").values(costToday("s1", real())).execute();
    await until(async () => (await rented.poll(), runpod.pods[0]!.status === "TERMINATED"));
    expect(await gone(id)).toBe(true);
    expect((await lastFill())?.interrupted).toBe("a spending cap was reached");
  });
});

describe("a volume's pods, one at a time", () => {
  const real = Date.now;
  type V = { id: string; usedBy: { name: string } | null; mountedOn: unknown[] };
  const ro = async () => ((await get(t.app, "/api/runpod/volumes")).json().volumes as V[]).find((v) => v.id === "vol-ro")!;

  it("Start of a stopped pod whose volume another pod now runs on is refused, said by whom", async () => {
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    const first = (await readSettings(t.db)).machines.find((m) => m.rented)!;
    await until(async () => (await t.services.rented.poll(), runpod.pods[0]!.status === "RUNNING"));
    await post(t.app, `/api/machines/${first.id}/stop`, { how: "stop" });
    await until(async () => runpod.pods[0]!.status === "EXITED");
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    const refused = await post(t.app, `/api/machines/${first.id}/start`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/The volume "afflatus-models" is in use by A40 2/);
    expect(runpod.pods[0]!.status).toBe("EXITED");
    // the other one terminated: Start goes
    const second = (await readSettings(t.db)).machines.find((m) => m.rented && m.id !== first.id)!;
    expect((await post(t.app, `/api/machines/${second.id}/stop`, { how: "terminate" })).statusCode).toBe(200);
    expect((await post(t.app, `/api/machines/${first.id}/start`)).statusCode).toBe(200);
  });

  it("a deploy that never came up, or that RunPod stopped listing, no longer holds its volume", async () => {
    runpod.bootMs = 10_000_000;
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    const rented = t.services.rented;
    rented.now = () => real() + 21 * 60_000;
    await rented.poll();
    expect(runpod.pods[0]!.status).toBe("TERMINATED");
    // its card still says why
    expect((await t.services.queue.status()).machines.find((m) => m.rented)?.rented?.stoppedBy).toBe("boot");
    expect(await ro()).toMatchObject({ usedBy: null, mountedOn: [] });
    // made, then gone from RunPod's list before it ever came up: starting on it until its boot limit, free after
    expect((await deploy({ volume: "vol-ro", idleDo: "stop" })).statusCode).toBe(200);
    runpod.pods.splice(runpod.pods.findIndex((p) => p.status !== "TERMINATED"), 1);
    await rented.poll();
    expect((await ro()).usedBy).toMatchObject({ name: "A40 2" });
    rented.now = () => real() + 42 * 60_000;
    await rented.poll();
    expect(await ro()).toMatchObject({ usedBy: null, mountedOn: [] });
    expect((await t.app.inject({ method: "DELETE", url: "/api/runpod/volumes/vol-ro" })).statusCode).toBe(200);
  });
});
