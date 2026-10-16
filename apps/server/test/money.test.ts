import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { shareIn } from "../src/rented";
import { runningRate } from "../src/runpod";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * The money rules of the rented GPUs (the pre-0.5.0 review's M-1 to M-9, W-1 and the disk in a pod's rate): what a pod
 * costs an hour, when its run is counted from, its idle across a restart of Afflatus, what a cap does to it, the bill's
 * midnight, the runway with storage, and the pretend RunPod's billing.
 */

const KEY = "rpa_test_key_0123456789";
const HOUR = 3_600_000;
const MIN = 60_000;
let home: FakeComfy;
let a: FakeComfy;
let b: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];
const told: Array<{ kind: string; title: string; body: string }> = [];

beforeEach(async () => {
  home = await makeFake();
  a = Object.assign(await makeFake(), { packVersion: "0.13.0" });
  b = Object.assign(await makeFake(), { packVersion: "0.13.0" });
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 30,
    pods: [
      { name: "pod-a", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 50, comfy: a },
      // a container disk of 150 GB and no pod volume, as a pod deployed without a volume is
      { name: "pod-b", rate: 0.59, gpu: "NVIDIA A40", dataCenterId: "CA-MTL-1", ports: ["8188/http"], diskGb: 0, containerGb: 150, comfy: b },
    ],
    spawn: async () => {
      const c = Object.assign(await makeFake(), { packVersion: "0.13.0" });
      spawned.push(c);
      return c;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  hear(t);
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
  // nothing goes to this PC: only the pods are followed
  await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  t.services.rented.stop();
  await t.close();
  await Promise.all([home, a, b, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
});

function hear(app: TestApp): void {
  app.services.rented.everyMs = 60_000;
  app.services.rented.imageCheck = async () => true;
  told.length = 0;
  app.services.rented.tell = (kind, m) => void told.push({ kind, title: m.title, body: m.body });
}

/** Afflatus's clock moved on by `ms` (RunPod's and the pods' stay real). */
const later = (app: TestApp, ms: number) => {
  const real = Date.now;
  app.services.rented.now = () => real() + ms;
};
const podA = () => runpod.pods[0]!;
const podB = () => runpod.pods[1]!;
const add = async (pod: string) => (await post(t.app, "/api/runpod/add", { pod })).json().id as string;
const spending = async (app = t) => (await get(app.app, "/api/rented/spending")).json().spending;
const sessions = () => t.db.selectFrom("rent_sessions").selectAll().orderBy("started_at").execute();

async function startUp(id: string, pod: () => FakeRunpod["pods"][number]): Promise<void> {
  expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
  await until(async () => (await t.services.rented.poll(), pod().status === "RUNNING"));
  await t.services.rented.poll();
}

describe("what a pod costs an hour", () => {
  it("is its GPU and its own disks while it runs: a 150 GB container disk adds 150 × $0.10 / 730 h", async () => {
    const id = await add(podB().id);
    await startUp(id, podB);
    const rate = 0.59 + (150 * 0.1) / 730;
    expect(runningRate(0.59, 150, 0)).toBe(rate);
    expect((await sessions()).map((s) => s.rate)).toEqual([rate]);
    const view = (await t.services.queue.status()).machines.find((m) => m.id === id)!.rented!;
    expect(view).toMatchObject({ rate, gpuRate: 0.59 });
  });

  it("a run opened at a lower rate (before its disk was counted) takes the full one", async () => {
    const id = await add(podB().id);
    await startUp(id, podB);
    await t.db.updateTable("rent_sessions").set({ rate: 0.59 }).execute();
    await t.services.rented.poll();
    expect((await sessions())[0]!.rate).toBe(0.59 + (150 * 0.1) / 730);
  });
});

describe("a run's start", () => {
  it("is its first sight when RunPod still says the start time of the run before (M-4)", async () => {
    const id = await add(podA().id);
    const h = (n: number) => new Date(Date.now() - n * HOUR).toISOString();
    await t.db.insertInto("rent_sessions").values({ id: "prev", machine_id: id, pod: podA().id, rate: 0.69, started_at: h(5), ended_at: h(3), seen_at: h(3), gpu: null, up_at: null, idle_minutes: 10, busy_at: null }).execute();
    const spentBefore = (await spending()).today;
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    await until(() => podA().status === "RUNNING");
    // RunPod listing the start of the run before, as a list may until it is updated
    podA().startedAt = h(5);
    const before = Date.now();
    await t.services.rented.poll();
    const run = (await sessions()).at(-1)!;
    expect(run.id).not.toBe("prev");
    expect(Date.parse(run.started_at)).toBeGreaterThanOrEqual(before - 5_000);
    // the three hours it was stopped are not billed at once: today's count is seconds of it
    expect((await spending()).today - spentBefore).toBeLessThan(0.01);
  });
});

describe("idle across a restart of Afflatus", () => {
  it("an idle pod is stopped at its idle time from its last work, not given a new one by the restart (M-2)", async () => {
    const id = await add(podA().id);
    await startUp(id, podA);
    later(t, 9 * MIN);
    await t.services.rented.poll();
    expect(podA().status).toBe("RUNNING");
    // Afflatus restarted (an update, a live restart) at 9 min idle
    t.services.rented.stop();
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    hear(again);
    try {
      later(again, 9 * MIN);
      await again.services.rented.poll();
      expect(podA().status).toBe("RUNNING");
      later(again, 10.5 * MIN);
      await again.services.rented.poll();
      expect(podA().status).toBe("EXITED");
      expect(told.map((x) => x.body)).toEqual([expect.stringMatching(/^Why: idle 10 min\./)]);
    } finally {
      again.services.rented.stop();
    }
  });
});

describe("a cap", () => {
  it("a month's cap alone stops a pod, and Start is refused (M-9)", async () => {
    const id = await add(podA().id);
    await startUp(id, podA);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0, month: 0.0000001 } } });
    await t.services.rented.poll();
    expect(podA().status).toBe("EXITED");
    expect(told.map((x) => x.kind)).toEqual(["capReached", "podStopped"]);
    expect(told[0]!.title).toMatch(/^This month's cap reached/);
    const start = await post(t.app, `/api/machines/${id}/start`, {});
    expect(start.statusCode).toBe(409);
  });

  it("terminates a deployed pod that keeps nothing, at once: no stop, and no watchdog's notice after (M-5)", async () => {
    const id = (await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 })).json().id as string;
    const pod = runpod.pods.at(-1)!;
    await until(async () => (await t.services.rented.poll(), Boolean((await t.services.queue.status()).machines.find((m) => m.id === id)?.rented?.answers)));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    for (let i = 0; i < 3; i++) await t.services.rented.poll();
    expect(pod.status).toBe("TERMINATED");
    expect(runpod.calls.filter((c) => c.endsWith("/action stop"))).toEqual([]);
    expect(told.filter((x) => x.kind === "podStopped").map((x) => [x.title, x.body.split(".")[0]])).toEqual([[expect.stringMatching(/terminated$/), "Why: a spending cap was reached"]]);
    expect((await t.services.queue.status()).machines.some((m) => m.id === id)).toBe(false);
  });

  it("acts on a pod still provisioning: it does not come up billed first (M-6)", async () => {
    runpod.bootMs = 5_000;
    await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
    const pod = runpod.pods.at(-1)!;
    expect(pod.status).toBe("PROVISIONING");
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    expect(pod.status).toBe("TERMINATED");
    expect(told.map((x) => x.kind)).toEqual(["capReached", "podStopped"]);
  });

  it("stops a pod the user added while it starts", async () => {
    const id = await add(podA().id);
    runpod.bootMs = 5_000;
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    await t.services.rented.poll();
    expect(podA().status).toBe("STARTING");
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    expect(podA().status).toBe("EXITED");
  });
});

describe("what each cap weighs (P-8, D-2: the day compute, the month the whole bill)", () => {
  const hourToday = () => {
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return { startTime: new Date(start).toISOString(), endTime: new Date(start + HOUR).toISOString() };
  };

  it("a stopped pod's disk is not in the day cap, and is in the month's", async () => {
    // pod-a, stopped, billed $1 for an hour of its disk alone today: no run of it in Afflatus then
    runpod.bill = [{ podId: podA().id, ...hourToday(), totalAmount: 1, diskAmount: 1 }];
    const id = await add(podA().id);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.5, month: 0 } } });
    const s = await spending();
    expect(s.today).toBeCloseTo(0, 9);
    expect(s.month).toBeCloseTo(1, 9);
    // nothing ran today: the day cap is not reached, Start goes
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    // the month cap weighs the disk: Start refused
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0, month: 0.5 } } });
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(409);
  });

  it("a running pod's hour counts whole in the day cap, its disk in it", async () => {
    // the hour it runs in, billed $1, $0.10 of it its disk (set first: the bill is read again only every few minutes)
    const now = Date.now();
    runpod.bill = [{ podId: podA().id, startTime: new Date(now - 30 * MIN).toISOString(), endTime: new Date(now + 30 * MIN).toISOString(), totalAmount: 1, diskAmount: 0.1 }];
    const id = await add(podA().id);
    await startUp(id, podA);
    const s = await spending();
    const d = new Date(now);
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    expect(s.today).toBeCloseTo(now - 30 * MIN >= today ? 1 : (now + 30 * MIN - today) / HOUR, 6);
  });

  it("the volumes' bill is in the month cap and not the day's; at the month cap Make volume and Grow are refused", async () => {
    runpod.volumes.push({ id: "vol-1", name: "zz-test models", size: 50, dataCenter: "EU-RO-1" });
    runpod.volumeBill = [{ networkVolumeId: "vol-1", ...hourToday(), totalAmount: 2 }];
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 1, month: 0 } } });
    const s = await spending();
    expect(s).toMatchObject({ today: 0, monthVolumes: 2 });
    expect(s.month).toBeCloseTo(2, 9);
    const make = () => post(t.app, "/api/runpod/volumes", { name: "zz-test volume", size: 20, dataCenter: "EU-RO-1" });
    const grow = (size: number) => t.app.inject({ method: "PATCH", url: "/api/runpod/volumes/vol-1", payload: { size } });
    // the day cap is compute: a volume is not refused at it
    expect((await make()).statusCode).toBe(200);
    expect((await grow(60)).statusCode).toBe(200);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0, month: 2 } } });
    const refused = await make();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/^This month's cap is reached \(\$2\.00 of \$2\.00\)/);
    expect((await grow(70)).statusCode).toBe(409);
    expect(runpod.volumes.find((v) => v.id === "vol-1")?.size).toBe(60);
    expect(runpod.volumes).toHaveLength(2);
  });
});

describe("the bill", () => {
  it("an hour across midnight counts for its part after it, today (M-9)", async () => {
    const d = new Date();
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    // a pod not in Afflatus, billed $1 for the hour from 23:30 to 00:30
    runpod.bill = [{ podId: "elsewhere", startTime: new Date(today - 30 * MIN).toISOString(), endTime: new Date(today + 30 * MIN).toISOString(), totalAmount: 1 }];
    const s = await spending();
    expect(s.today).toBeCloseTo(0.5, 9);
    expect(s.month).toBeCloseTo(today - 30 * MIN >= month ? 1 : 0.5, 9);
    expect(shareIn({ start: 0, end: HOUR }, 15 * MIN, Infinity)).toBe(0.75);
    expect(shareIn({ start: 0, end: 0 }, 0, Infinity)).toBe(1);
  });
});

describe("the runway", () => {
  it("counts storage: an account with only volumes and stopped disks has one, and the same in Settings and Costs (W-1)", async () => {
    runpod.volumes.push({ id: "vol-1", name: "zz-test models", size: 100, dataCenter: "EU-RO-1" });
    const s = await spending();
    // the volume at $0.07, pod-a's stopped 50 GB disk at $0.20 a GB and month, by the hour over 730 h
    const storage = ((100 * 0.07 + 50 * 0.2) * 24) / 730;
    expect(s.perDay).toEqual({ pods: 0, storage: expect.closeTo(storage, 12) });
    expect(s.runwayDays).toBeCloseTo(s.balance / storage, 9);
    const costs = (await get(t.app, "/api/costs")).json();
    expect(costs).toMatchObject({ runwayDays: s.runwayDays, storageDay: s.perDay.storage, pace7: 0 });
  });

  it("leaves a running pod's disk out of storage: it bills in the pod's rate, with the pods' pace", async () => {
    runpod.volumes.push({ id: "vol-1", name: "zz-test models", size: 100, dataCenter: "EU-RO-1" });
    podA().status = "RUNNING";
    const s = await spending();
    expect(s.perDay.storage).toBeCloseTo((100 * 0.07 * 24) / 730, 12);
    // what bills with nothing running still counts its disk at the stopped price
    expect(s.storage.perMonth).toBeCloseTo(100 * 0.07 + 50 * 0.2, 9);
  });

  it("tells of a low balance under a day of storage too", async () => {
    runpod.volumes.push({ id: "vol-1", name: "zz-test models", size: 2000, dataCenter: "EU-RO-1" });
    // a day of storage: (1000 GB × 0.07 + 1000 × 0.05 past the first TB + 50 × 0.20) × 24 / 730, about $4.27
    runpod.balance = 4;
    // a pod followed: RunPod is read
    await add(podA().id);
    await t.services.rented.poll();
    expect(told.map((x) => x.kind)).toEqual(["balanceLow"]);
    expect(told[0]!.body).toMatch(/^Under \$4\.27, a day at this pace \(the last week's pods \$0\.00, storage \$4\.27\)/);
    expect((await spending()).lowBalance).toBe(true);
  });
});

describe("Queue › Costs", () => {
  it("waits for RunPod once: its bill, balance, storage and GPUs asked together, each once; a kept read given at once after", async () => {
    const LAT = 250;
    runpod.latencyMs = LAT;
    runpod.calls.length = 0;
    const at = Date.now();
    expect((await get(t.app, "/api/costs")).statusCode).toBe(200);
    const took = Date.now() - at;
    // one round trip of RunPod's (each read under way asked once, the bill too though storage reads it as well), where one
    // after the other they took four
    expect(took).toBeLessThan(2 * LAT);
    expect(runpod.calls.filter((c) => c.startsWith("GET /v2/billing/pods"))).toHaveLength(1);
    expect(runpod.calls.filter((c) => c === "POST /graphql")).toHaveLength(1);
    // past its freshness the GPUs' read is given at once, read again behind it
    t.services.hunt.now = () => Date.now() + 60_000;
    const again = Date.now();
    expect((await get(t.app, `/api/costs?from=${Date.now() - HOUR}&to=${Date.now()}`)).statusCode).toBe(200);
    expect(Date.now() - again).toBeLessThan(LAT);
    await until(() => runpod.calls.filter((c) => c === "GET /v2/catalog/gpus").length === 2);
  });
});

describe("a batch of renders' cost (Queue empty)", () => {
  it("counts the runs it overlaps from their start (boot and files), never before the batch before ended (M-1)", async () => {
    const at = (m: number) => new Date(Date.parse("2026-10-14T12:00:00.000Z") + m * MIN).toISOString();
    const T = Date.parse(at(0));
    await t.db.insertInto("rent_sessions").values({ id: "zz-r", machine_id: "rp-zz", pod: "zz", rate: 0.6, started_at: at(-60), ended_at: at(30), seen_at: null, gpu: null, up_at: at(-50), idle_minutes: 10, busy_at: null }).execute();
    // the batch rendered from 0 to 20: the pod's hour of boot and files before it is the batch's
    expect(await t.services.rented.batchCost(T, T + 20 * MIN, 0)).toBeCloseTo(0.8, 9);
    // a batch before it ended at -30: from there only
    expect(await t.services.rented.batchCost(T, T + 20 * MIN, T - 30 * MIN)).toBeCloseTo(0.5, 9);
  });
});

describe("the pretend RunPod", () => {
  it("bills a pod while it provisions, its disk with it, and writes its bill (M-8)", async () => {
    const balance = async () => ((await (await fetch(`${runpod.url}/graphql`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: "{}" })).json()) as { data: { myself: { clientBalance: number; currentSpendPerHr: number } } }).data.myself;
    runpod.bootMs = 60_000;
    runpod.autoBill = true;
    await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
    const pod = runpod.pods.at(-1)!;
    expect(pod).toMatchObject({ status: "PROVISIONING", diskGb: 0, containerGb: 120 });
    const first = await balance();
    // the A40 and its container disk, with pod-a's stopped disk
    expect(first.currentSpendPerHr).toBeCloseTo(0.44 + (120 * 0.1) / 730 + (50 * 0.2) / 730, 12);
    await new Promise((r) => setTimeout(r, 200));
    expect((await balance()).clientBalance).toBeLessThan(first.clientBalance);
    const bill = (await (await fetch(`${runpod.url}/v2/billing/pods?startTime=${new Date(0).toISOString()}&endTime=${new Date().toISOString()}`, { headers: { Authorization: `Bearer ${KEY}` } })).json()) as { records: Array<{ podId: string; totalAmount: number }> };
    expect(bill.records.some((r) => r.podId === pod.id && r.totalAmount > 0)).toBe(true);
  });
});
