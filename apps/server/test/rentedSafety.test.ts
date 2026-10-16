import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { podTime } from "../src/runpod";
import { readSettings } from "../src/settings";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * Rented machines where money is at stake (rented.ts), against a pretend RunPod that misbehaves as the real one can: one pod
 * refused something, RunPod down or rate-limited, an answer of another shape, a pod's ComfyUI gone, a race with the user.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let a: FakeComfy;
let b: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

beforeEach(async () => {
  home = await makeFake();
  a = await makeFake();
  b = await makeFake();
  for (const c of [a, b]) c.packVersion = "0.13.0";
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 30,
    pods: [
      { name: "pod-a", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 50, comfy: a, env: { HF_TOKEN: "hf_keep_me" } },
      { name: "pod-b", rate: 0.4, gpu: "NVIDIA GeForce RTX 4090", dataCenterId: "EU-RO-1", ports: ["8188/http"], diskGb: 20, comfy: b },
    ],
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
  await Promise.all([home, a, b, runpod].map((x) => x.close().catch(() => {})));
});

const podA = () => runpod.pods[0]!;
const podB = () => runpod.pods[1]!;
const add = async (pod: string) => (await post(t.app, "/api/runpod/add", { pod })).json().id as string;
const started = async (id: string, pod: () => { status: string }) => {
  expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
  await until(async () => (await t.services.rented.poll(), pod().status === "RUNNING"));
  await t.services.rented.poll();
};
const later = (ms: number) => {
  const real = Date.now;
  t.services.rented.now = () => real() + ms;
};
const rowOf = async (id: string) => (await t.services.queue.status()).machines.find((m) => m.id === id)!;
const sessions = () => t.db.selectFrom("rent_sessions").selectAll().execute();
const statusOf = async (job: string) => (await t.db.selectFrom("jobs").select("status").where("id", "=", job).executeTakeFirstOrThrow()).status;

describe("money safety", () => {
  it("one pod RunPod refuses a stop for does not keep the others from being watched and stopped", async () => {
    const ia = await add(podA().id);
    const ib = await add(podB().id);
    await started(ia, podA);
    await started(ib, podB);
    runpod.failAction[podA().id] = 409;
    later(11 * 60_000);
    await t.services.rented.poll();
    expect(podB().status).toBe("EXITED");
    expect(podA().status).toBe("RUNNING");
    expect((await rowOf(ia)).rented?.error).toMatch(/cannot do that now/);
  });

  it("runs out its idle time when its ComfyUI is gone, a job waiting or not", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    // the home machine paused: a job waits that the pod could take, but its ComfyUI went down on the pod
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: id } });
    await post(t.app, "/api/jobs", job());
    a.down = true;
    later(11 * 60_000);
    await t.services.rented.poll();
    expect(podA().status).toBe("EXITED");
  });

  it("arms the watchdog and the lock from its start, and keeps the rest of its environment", async () => {
    const id = await add(podA().id);
    await post(t.app, `/api/machines/${id}/start`, {});
    const token = (await readSettings(t.db)).machines.find((m) => m.id === id)!.token;
    expect(podA().env).toEqual({ HF_TOKEN: "hf_keep_me", AFFLATUS_TOKEN: `{{ RUNPOD_SECRET_afflatus-${podA().id} }}`, AFFLATUS_WATCHDOG_MINUTES: "15", AFFLATUS_WATCHDOG_ACTION: "stop" });
    expect(runpod.secrets[`afflatus-${podA().id}`]).toBe(token);
  });

  it("keeps the token in its environment when the key cannot make secrets, and the pod is locked all the same", async () => {
    runpod.failSecrets = true;
    const id = await add(podA().id);
    await started(id, podA);
    const token = (await readSettings(t.db)).machines.find((m) => m.id === id)!.token;
    expect(podA().env.AFFLATUS_TOKEN).toBe(token);
    expect(a.lock).toEqual({ token, local: false, fixed: true });
  });

  it("closes its other public ports at Start, unless asked to keep them", async () => {
    podA().ports = ["8188/http", "8080/http", "8888/http", "22/tcp"];
    const id = await add(podA().id);
    await t.services.rented.poll();
    expect((await rowOf(id)).rented?.otherPorts).toEqual(["8080/http", "8888/http", "22/tcp"]);
    await post(t.app, `/api/machines/${id}/start`, {});
    expect(podA().ports).toEqual(["8188/http"]);
    // remembered: the card still says them, closed
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.closedPorts).toEqual(["8080/http", "8888/http", "22/tcp"]);
    // kept open: the next Start puts back those it closed
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    const machines = (await readSettings(t.db)).machines.map(({ token: _token, ...m }) => (m.id === id ? { ...m, rented: { ...m.rented!, openPorts: true } } : m));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines } });
    await post(t.app, `/api/machines/${id}/start`, {});
    expect(podA().ports).toEqual(["8188/http", "8080/http", "8888/http", "22/tcp"]);
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.closedPorts).toEqual([]);
  });

  it("deletes the pod's secret however it is terminated: by its idle, or on RunPod", async () => {
    podB().diskGb = 0;
    const ia = await add(podA().id);
    const ib = await add(podB().id);
    await started(ia, podA);
    await started(ib, podB);
    expect(Object.keys(runpod.secrets).sort()).toEqual([`afflatus-${podA().id}`, `afflatus-${podB().id}`].sort());
    // pod B (no volume) terminated by its idle; pod A terminated on RunPod's site
    podA().status = "TERMINATED";
    later(11 * 60_000);
    await t.services.rented.poll();
    await t.services.rented.poll();
    expect(podB().status).toBe("TERMINATED");
    expect(runpod.secrets).toEqual({});
  });

  it("says plainly that its GPU was taken while it was stopped", async () => {
    const id = await add(podA().id);
    runpod.failAction[podA().id] = 400;
    runpod.failDetail = "There are not enough free GPUs on the host machine to start this pod.";
    const res = await post(t.app, `/api/machines/${id}/start`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/^Start refused: its GPU was taken while it was stopped/);
  });

  it("is terminated when idle by default without a volume, stopped with one", async () => {
    podB().diskGb = 0;
    const ia = await add(podA().id);
    const ib = await add(podB().id);
    const machines = (await readSettings(t.db)).machines;
    expect(machines.find((m) => m.id === ia)?.rented?.idleDo).toBe("stop");
    expect(machines.find((m) => m.id === ib)?.rented?.idleDo).toBe("terminate");
  });

  it("never writes the environment when RunPod did not say it, says so, and locks the pod once it is up", async () => {
    runpod.hideEnv = true;
    const id = await add(podA().id);
    await started(id, podA);
    expect(runpod.calls.some((c) => c.startsWith("PATCH"))).toBe(false);
    expect(podA().env).toEqual({ HF_TOKEN: "hf_keep_me" });
    // up open: locked now with the machine's token
    const token = (await readSettings(t.db)).machines.find((m) => m.id === id)!.token;
    expect(a.lock?.token).toBe(token);
    expect((await rowOf(id)).rented?.error ?? "").toMatch(/could not be set for its start/);
  });

  it("locks it once it is up when RunPod refuses the environment change", async () => {
    runpod.failPatch = 422;
    const id = await add(podA().id);
    await started(id, podA);
    expect(a.lock?.fixed).toBeFalsy();
    expect(a.lock?.token).toBe((await readSettings(t.db)).machines.find((m) => m.id === id)!.token);
  });

  it("takes no new work from the moment it is being stopped", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    runpod.actionDelayMs = 400;
    const stopping = post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    await until(() => t.services.queue.unavailable(id) === "being stopped");
    expect((await rowOf(id)).rented?.stopping).toBe(true);
    await stopping;
    expect(t.services.queue.unavailable(id)).toBe("stopped");
  });

  it("goes on saying still here while RunPod is down, and asks it less after a 429", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    const heard = a.alive.length;
    runpod.failList = 503;
    await t.services.rented.poll();
    expect(a.alive.length).toBeGreaterThan(heard);
    expect((await rowOf(id)).rented?.error).toMatch(/503|unavailable/);
    runpod.failList = 429;
    await t.services.rented.poll();
    const asked = runpod.calls.length;
    await t.services.rented.poll();
    expect(runpod.calls.length).toBe(asked);
    expect(a.alive.length).toBeGreaterThan(heard + 1);
  });

  it("says an answer of another shape, and never takes it for no pods", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    runpod.oddList = true;
    await t.services.rented.poll();
    const row = await rowOf(id);
    expect(row.rented?.status).toBe("RUNNING");
    expect(row.rented?.error).toMatch(/shape Afflatus does not know/);
  });

  it("closes a run that ended while Afflatus was away at the latest it could have run: its watchdog's minutes after it was last seen", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    const seen = (await sessions())[0]!.seen_at!;
    // the watchdog stopped it while this PC slept; Afflatus comes back ten hours later, knowing nothing more
    podA().status = "EXITED";
    podA().startedAt = null;
    t.services.rented.stop();
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    const real = Date.now;
    again.services.rented.now = () => real() + 10 * 3_600_000;
    await again.services.rented.poll();
    const closed = (await sessions())[0]!;
    // its watchdog (15 min) stopped it at the latest that long after the last "still here", give or take its checks
    expect(Date.parse(closed.ended_at!) - Date.parse(seen)).toBe(17 * 60_000);
    again.services.rented.stop();
  });

  it("at a cap, waits for the render running, but not past an hour", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    // a render that never ends: the home machine paused, the pretend ComfyUI never finishes it
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    await post(t.app, "/api/jobs", job());
    await until(() => t.services.queue.runningOn(id));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    expect(podA().status).toBe("RUNNING");
    expect((await rowOf(id)).rented?.capped).toBe(true);
    later(61 * 60_000);
    await t.services.rented.poll();
    expect(podA().status).toBe("EXITED");
  });

  it("at a cap, starts nothing new on the pod: the render running ends, the next one waits with why, and the pod stops", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    // the pod alone takes work: the home machine paused
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    const first = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => t.services.queue.runningOn(id) && a.prompts.size === 1);
    const next = (await post(t.app, "/api/jobs", job({ prompt: "a dog" }))).json().ids[0] as string;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    expect(podA().status).toBe("RUNNING");
    // the job waiting says why it is not sent to the pod
    expect((await t.services.queue.status()).waiting.find((w) => w.id === next)?.lacks?.[id]?.why).toBe("a spending cap is reached");
    // the render running ends: the queue looks at once for the next job, before RunPod is read again
    complete(a, [...a.prompts.keys()][0]!);
    await until(async () => (await statusOf(first)) === "done");
    await new Promise((r) => setTimeout(r, 300));
    expect(a.prompts.size).toBe(1);
    expect(await statusOf(next)).toBe("queued");
    await t.services.rented.poll();
    expect(podA().status).toBe("EXITED");
    expect(await statusOf(next)).toBe("queued");
  });

  it("at a cap, what waits goes to another machine once the pod's render ends", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    // each machine renders one that never ends by itself: the home machine stays busy, the pod is free first
    await post(t.app, "/api/jobs", { ...job(), machine: "m1" });
    await post(t.app, "/api/jobs", { ...job({ prompt: "a dog" }), machine: id });
    await until(() => home.prompts.size === 1 && a.prompts.size === 1);
    const next = (await post(t.app, "/api/jobs", job({ prompt: "a bird" }))).json().ids[0] as string;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    complete(a, [...a.prompts.keys()][0]!);
    await until(() => !t.services.queue.runningOn(id));
    await new Promise((r) => setTimeout(r, 300));
    expect(a.prompts.size).toBe(1);
    // the home machine's render ends: the job waiting goes there
    complete(home, [...home.prompts.keys()][0]!);
    await until(() => home.prompts.size === 2);
    expect((await t.db.selectFrom("jobs").select("machine_id").where("id", "=", next).executeTakeFirstOrThrow()).machine_id).toBe("m1");
    await t.services.rented.poll();
    expect(podA().status).toBe("EXITED");
  });

  it("keeps the rate of its last run for a pod RunPod says 0 for while it is stopped", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    t.services.rented.stop();
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    await again.services.rented.poll();
    expect((await again.services.queue.status()).machines.find((m) => m.id === id)?.rented?.rate).toBe(0.69 + (50 * 0.1) / 730);
    again.services.rented.stop();
    expect((await get(t.app, "/api/runpod/pods")).statusCode).toBe(200);
  });
});

describe("when RunPod is not read normally", () => {
  const actions = () => runpod.calls.filter((c) => /\/action (stop|terminate)$/.test(c)).map((c) => c.split(" ").pop());
  const idleDo = async (id: string, how: "stop" | "terminate") => {
    const machines = (await readSettings(t.db)).machines.map(({ token: _token, ...m }) => (m.id === id ? { ...m, rented: { ...m.rented!, idleDo: how } } : m));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { machines } });
  };

  it("a cap reached while RunPod's list cannot be read: no new job on the pod, and no \"still here\" with no render", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    runpod.failList = 503;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    const heard = a.alive.length;
    await t.services.rented.poll();
    // within its idle time, but at a cap: silent, so that its watchdog stops it while RunPod cannot be asked to
    expect(a.alive.length).toBe(heard);
    expect((await rowOf(id)).rented?.capped).toBe(true);
    expect(t.services.queue.unavailable(id)).not.toBeNull();
    const next = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await new Promise((r) => setTimeout(r, 300));
    expect(a.prompts.size).toBe(0);
    expect(await statusOf(next)).toBe("queued");
  });

  it("one read without the pod keeps its run: its session, its state, a stop under way and that stop asked again", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    runpod.stopMs = 10 * 60_000;
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    expect(podA().status).toBe("RUNNING");
    // an answer of RunPod's that came back without it
    runpod.unlisted.add(podA().id);
    await t.services.rented.poll();
    expect((await rowOf(id)).rented).toMatchObject({ status: "RUNNING", stopping: true });
    expect((await sessions()).map((r) => r.ended_at)).toEqual([null]);
    runpod.unlisted.clear();
    later(3 * 60_000);
    await t.services.rented.poll();
    expect(actions()).toEqual(["stop", "stop"]);
    expect(await sessions()).toHaveLength(1);
  });

  it("a stop asked again is the one sent: the user's Stop on a pod with a disk set to terminate when idle stays a stop", async () => {
    const id = await add(podA().id);
    await idleDo(id, "terminate");
    await started(id, podA);
    runpod.stopMs = 10 * 60_000;
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    later(3 * 60_000);
    await t.services.rented.poll();
    expect(actions()).toEqual(["stop", "stop"]);
    expect(podA().status).toBe("RUNNING");
  });

  it("a cap's stop asked again stays a stop on a pod with a disk set to terminate when idle", async () => {
    const id = await add(podA().id);
    await idleDo(id, "terminate");
    await started(id, podA);
    runpod.stopMs = 10 * 60_000;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    expect(actions()).toEqual(["stop"]);
    later(3 * 60_000);
    await t.services.rented.poll();
    expect(actions()).toEqual(["stop", "stop"]);
    expect(podA().status).toBe("RUNNING");
  });

  it("is not removed while its state on RunPod is not known: read first, refused while it runs or when RunPod cannot say", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    // Afflatus restarted while RunPod's list cannot be read: nothing is known of the pod yet
    t.services.rented.stop();
    runpod.failList = 500;
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    try {
      await again.services.rented.poll();
      const running = await post(again.app, `/api/machines/${id}/remove`, {});
      expect(running.statusCode).toBe(409);
      expect(running.json().error).toMatch(/running on RunPod, billed/);
      runpod.failOne = 500;
      const unknown = await post(again.app, `/api/machines/${id}/remove`, {});
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error).toMatch(/^Its state on RunPod is not known yet/);
      expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(true);
    } finally {
      again.services.rented.stop();
    }
  });

  it("the card's run cost counts from its session's start, never from a start time RunPod still says of the run before", async () => {
    const id = await add(podA().id);
    await started(id, podA);
    podA().startedAt = new Date(Date.now() - 5 * 3_600_000).toISOString();
    await t.services.rented.poll();
    const row = (await rowOf(id)).rented!;
    expect(row.since).toBe(Date.parse((await sessions())[0]!.started_at));
    expect(row.spent).toBeLessThan(0.05);
  });
});

describe("what a real pod showed", () => {
  it("an older ComfyUI without the pack (405 to the watchdog's call) answers: it is up, with no watchdog", async () => {
    a.packVersion = null;
    a.oldPage = true;
    const id = await add(podA().id);
    await started(id, podA);
    const row = await rowOf(id);
    expect(row.rented).toMatchObject({ answers: true, watchdog: "none" });
  });

  it("a pod's machine id is its own: never an id a removed machine had, the same when added again", async () => {
    const id = await add(podA().id);
    expect(id).toBe(`rp-${podA().id}`);
    await post(t.app, `/api/machines/${id}/remove`, {});
    expect(await add(podA().id)).toBe(id);
  });
});

describe("what the second real test showed", () => {
  it("a pod whose container never starts: said on its card, then its idle action at 10 min, never taken for answering", async () => {
    podB().diskGb = 0;
    const id = await add(podB().id);
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    // RunPod has it running, but its container never came up: its proxy answers for every address, nothing behind it
    await until(() => podB().status === "RUNNING");
    b.down = true;
    await t.services.rented.poll();
    const real = Date.now;
    later(3 * 60_000);
    await t.services.rented.poll();
    const row = await rowOf(id);
    expect(row.rented).toMatchObject({ status: "RUNNING", answers: false, watchdog: "unknown" });
    expect(row.rented?.error).toMatch(/nothing answers on 8188 after 3 min: its image may still be pulling, or its container did not start/);
    t.services.rented.now = () => real() + 11 * 60_000;
    await t.services.rented.poll();
    expect(podB().status).toBe("TERMINATED");
  });

  it("a Start pressed while RunPod still says it is stopping waits, then prepares it", async () => {
    runpod.stopMs = 300;
    t.services.rented.settleEveryMs = 50;
    const id = await add(podA().id);
    await started(id, podA);
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    expect(podA().status).toBe("RUNNING");
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    expect(podA().env.AFFLATUS_TOKEN).toBe(`{{ RUNPOD_SECRET_afflatus-${podA().id} }}`);
  });
});

describe("RunPod's dates", () => {
  it("reads ISO and Go's way, and nothing else", () => {
    expect(podTime("2026-10-13T10:00:00.000Z")).toBe(Date.parse("2026-10-13T10:00:00.000Z"));
    expect(podTime("2026-10-13 10:00:00.000 +0000 UTC")).toBe(Date.parse("2026-10-13T10:00:00.000Z"));
    expect(podTime("2026-10-13 12:00:00 +0200 CEST")).toBe(Date.parse("2026-10-13T10:00:00Z"));
    expect(podTime("soon")).toBeNull();
    expect(podTime(null)).toBeNull();
  });
});
