import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { runningRate } from "../src/runpod";
import { readSettings, updateSettings } from "../src/settings";
import { get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/** Rented machines (rented.ts) against a pretend RunPod: added, started by the user only, stopped when idle or at a cap. */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let podComfy: FakeComfy;
let otherComfy: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

beforeEach(async () => {
  home = await makeFake();
  podComfy = await makeFake();
  otherComfy = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50,
    pods: [
      { name: "comfy-5090", rate: 0.69, gpu: "NVIDIA GeForce RTX 5090", dataCenterId: "EU-RO-1", ports: ["8188/http", "22/tcp"], diskGb: 50, comfy: podComfy },
      { name: "no-comfy", rate: 0.3, gpu: "NVIDIA RTX A4000", dataCenterId: "US-TX-3", ports: ["8888/http"], diskGb: 20, comfy: otherComfy },
    ],
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
  await Promise.all([home, podComfy, otherComfy, runpod].map((x) => x.close().catch(() => {})));
});

const setKey = () => t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
const pod5090 = () => runpod.pods[0]!;
const add = async () => (await post(t.app, "/api/runpod/add", { pod: pod5090().id })).json().id as string;
const rowOf = async (id: string) => (await t.services.queue.status()).machines.find((m) => m.id === id)!;
const sessions = () => t.db.selectFrom("rent_sessions").selectAll().execute();

describe("adding a pod", () => {
  it("lists the pods only with a key, never shows the key, and adds one as it is, nothing started", async () => {
    expect((await get(t.app, "/api/runpod/pods")).statusCode).toBe(409);
    await setKey();
    expect((await get(t.app, "/api/settings")).body).not.toContain(KEY);
    expect((await get(t.app, "/api/settings")).json().hasRunpodKey).toBe(true);
    const pods = (await get(t.app, "/api/runpod/pods")).json().pods as Array<{ name: string; comfy: boolean; added: string | null; status: string }>;
    expect(pods.map((p) => [p.name, p.comfy, p.added, p.status])).toEqual([["comfy-5090", true, null, "EXITED"], ["no-comfy", false, null, "EXITED"]]);
    // a pod that does not expose ComfyUI is refused
    expect((await post(t.app, "/api/runpod/add", { pod: runpod.pods[1]!.id })).statusCode).toBe(409);
    const id = await add();
    const machine = (await get(t.app, "/api/settings")).json().machines.find((m: { id: string }) => m.id === id);
    expect(machine).toMatchObject({ name: "comfy-5090", url: podComfy.url, rented: { provider: "runpod", pod: pod5090().id, idleMinutes: 10, idleDo: "stop", watchdogMinutes: 15 } });
    expect(runpod.calls.filter((c) => c.includes("/action"))).toEqual([]);
    expect((await post(t.app, "/api/runpod/add", { pod: pod5090().id })).statusCode).toBe(409);
  });

  it("lists a pod whose machine was saved while RunPod was read as added, never as one to add", async () => {
    await setKey();
    const { rented } = t.services;
    const real = rented.client;
    // a deploy ending while the list is read: its machine saved after the read began, before RunPod answered
    rented.client = (key) => {
      const c = real(key);
      const pods = c.pods.bind(c);
      c.pods = async () => {
        const list = await pods();
        await updateSettings(t.db, (cur) => ({ machines: [...cur.machines, { id: "rp-new", name: "A40", url: "http://x", dir: "", takes: "all", families: {}, token: "", rented: { provider: "runpod", pod: pod5090().id, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 10, openPorts: false, closedPorts: [], secret: "" } }] }));
        return list;
      };
      return c;
    };
    const pods = (await get(t.app, "/api/runpod/pods")).json().pods as Array<{ name: string; added: string | null }>;
    expect(pods.find((p) => p.name === "comfy-5090")?.added).toBe("rp-new");
  });

  it("a wrong key is said as RunPod's refusal", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: "rpa_wrong_0123456789" } });
    const res = await get(t.app, "/api/runpod/pods");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/refused the API key/);
  });
});

describe("a rented machine", () => {
  it("stopped, takes no work and is never asked; a job pinned to it waits for it", async () => {
    await setKey();
    const id = await add();
    await t.services.rented.poll();
    const row = await rowOf(id);
    expect(row.rented).toMatchObject({ status: "EXITED", rate: null, diskPerDay: expect.closeTo((50 * 0.2 * 24) / 730, 9) });
    expect(t.services.queue.unavailable(id)).toBe("stopped");
    podComfy.calls.length = 0;
    const res = await post(t.app, "/api/jobs", { ...job(), machine: id });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const waiting = await t.db.selectFrom("jobs").select(["status", "pin_machine"]).where("id", "=", res.json().ids[0]).executeTakeFirstOrThrow();
    expect(waiting).toEqual({ status: "queued", pin_machine: id });
    expect(podComfy.calls.filter((c) => c.startsWith("POST /prompt"))).toEqual([]);
  });

  it("starts only when asked, runs a session, and its pinned job runs there once it is up", async () => {
    await setKey();
    const id = await add();
    await t.services.rented.poll();
    const queued = (await post(t.app, "/api/jobs", { ...job(), machine: id })).json().ids[0] as string;
    expect((await post(t.app, `/api/machines/${id}/start`, {})).statusCode).toBe(200);
    expect(runpod.calls).toContain(`POST /v2/pods/${pod5090().id}/action start`);
    await until(async () => (await t.services.rented.poll(), (await rowOf(id)).rented?.status === "RUNNING"));
    expect((await sessions()).map((s) => [s.machine_id, s.rate, s.ended_at])).toEqual([[id, runningRate(0.69, 0, 50), null]]);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", queued).executeTakeFirstOrThrow()).status !== "queued");
    const ran = await t.db.selectFrom("jobs").select(["status", "machine_id", "error"]).where("id", "=", queued).executeTakeFirstOrThrow();
    expect(ran).toMatchObject({ machine_id: id });
    await until(() => podComfy.calls.includes("POST /prompt"));
  });

  it("says what going back to a version without rented GPUs would leave on RunPod: what runs, what keeps billing", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    expect(await t.services.rented.goingBack()).toEqual({ running: ["comfy-5090 (NVIDIA GeForce RTX 5090)"], billing: [], unknown: false, unreadable: null });
    await post(t.app, `/api/machines/${id}/stop`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "EXITED"));
    expect(await t.services.rented.goingBack()).toEqual({ running: [], billing: ["comfy-5090, stopped: its 50 GB disk, $10.0/month"], unknown: false, unreadable: null });
    // RunPod not answering: why is said, and Go back is refused on it (updates.ts goBackCheck)
    runpod.failList = 500;
    expect(await t.services.rented.goingBack()).toMatchObject({ unknown: true, unreadable: expect.any(String) });
  });

  it("is down for good for its files only once stopped, or missing from two reads of RunPod's in a row", async () => {
    await setKey();
    const id = await add();
    await t.services.rented.poll();
    expect(t.services.rented.podGone(id)).toBe(true);
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    expect(t.services.rented.podGone(id)).toBe(false);
    // one answer of RunPod's without it: down for now, its files kept
    const [kept] = runpod.pods.splice(0, 1);
    await t.services.rented.poll();
    expect(t.services.rented.podDown(id)).not.toBeNull();
    expect(t.services.rented.podGone(id)).toBe(false);
    await t.services.rented.poll();
    expect(t.services.rented.podGone(id)).toBe(true);
    runpod.pods.unshift(kept!);
  });

  it("stops by itself after its idle time, nothing waiting for it, and says why", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    const row = await rowOf(id);
    expect(row.rented?.idleLeftMs).toBeGreaterThan(9 * 60_000);
    const real = Date.now;
    t.services.rented.now = () => real() + 11 * 60_000;
    await t.services.rented.poll();
    expect(pod5090().status).toBe("EXITED");
    expect((await rowOf(id)).rented?.stoppedBy).toBe("idle");
    expect((await sessions())[0]!.ended_at).not.toBeNull();
  });

  it("is not stopped by its idle time while its ComfyUI runs work queued outside Afflatus; a cap stops it all the same", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    // a workflow run from the pod's own ComfyUI page: Afflatus has nothing there, the GPU is at work all the same
    podComfy.running = ["from-its-own-page"];
    const real = Date.now;
    t.services.rented.now = () => real() + 11 * 60_000;
    await t.services.rented.poll();
    expect(pod5090().status).toBe("RUNNING");
    const row = await rowOf(id);
    expect(row.outside).toEqual({ running: 1, pending: 0 });
    // no countdown to a stop while it is at work
    expect(row.rented?.idleLeftMs).toBeNull();
    // its time at that work kept on its session, for Queue › Costs: used, not idle
    await t.services.podOutside.settled();
    expect(await t.db.selectFrom("pod_outside").select(["session_id", "ended_at"]).execute()).toEqual([{ session_id: (await sessions())[0]!.id, ended_at: null }]);
    // a spending cap is the user's word: it stops the pod whatever runs there that is not Afflatus's
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    expect(pod5090().status).toBe("EXITED");
    expect((await rowOf(id)).rented?.stoppedBy).toBe("cap");
  });

  it("at a cap, does not wait for a render of Afflatus's still queued in its ComfyUI behind work from outside Afflatus", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await post(t.app, "/api/jobs", { ...job(), machine: id });
    await until(() => podComfy.calls.includes("POST /prompt"));
    // sent, and then someone queued a workflow on the pod's own page that ComfyUI runs first: Afflatus's waits behind it
    podComfy.running = ["from-its-own-page"];
    await until(async () => (await rowOf(id)).outside?.running === 1);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await t.services.rented.poll();
    // not an hour's grace for a render that has not started: stopped at once
    expect(pod5090().status).toBe("EXITED");
    expect((await rowOf(id)).rented?.stoppedBy).toBe("cap");
  });

  it("is locked from its first second: the token in its environment before it starts, nobody can lock it first", async () => {
    await setKey();
    const id = await add();
    podComfy.packVersion = "0.13.0";
    await post(t.app, `/api/machines/${id}/start`, {});
    const token = (await readSettings(t.db)).machines.find((m) => m.id === id)!.token;
    expect(token.length).toBeGreaterThan(40);
    expect(runpod.calls).toContain(`PATCH /v2/pods/${pod5090().id}`);
    // kept as a secret of the account, its environment holding only the reference
    expect(pod5090().env.AFFLATUS_TOKEN).toBe(`{{ RUNPOD_SECRET_afflatus-${pod5090().id} }}`);
    expect(runpod.secrets[`afflatus-${pod5090().id}`]).toBe(token);
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    // up already locked, with a lock its routes cannot change: nothing was locked after the fact, and a stranger is refused
    expect(podComfy.lock).toEqual({ token, local: false, fixed: true });
    expect(podComfy.calls).not.toContain("POST /afflatus/lock");
    const stranger = await fetch(`${podComfy.url}/afflatus/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "a-stranger-token-0123456789" }) });
    expect(stranger.status).toBe(401);
    await t.services.rented.poll();
    expect((await rowOf(id)).online).not.toBe(false);
    // started again: the token already there is not written twice
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    await post(t.app, `/api/machines/${id}/start`, {});
    expect(runpod.calls.filter((c) => c.startsWith("PATCH /v2/pods")).length).toBe(1);
  });

  it("has work while a job it could take waits or runs there, none once it is done or the queue is paused", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    expect(await t.services.queue.wants(id)).toBe(false);
    // the home machine paused: a job free to go anywhere goes to the pod, which has work until it is done
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    const queued = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    expect(await t.services.queue.wants(id)).toBe(true);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", queued).executeTakeFirstOrThrow()).status === "running");
    expect(await t.services.queue.wants(id)).toBe(true);
    // a job pinned to the home machine (paused) is no work for the pod
    await t.app.inject({ method: "POST", url: `/api/jobs/${queued}/cancel` });
    await until(async () => !t.services.queue.runningOn(id));
    await post(t.app, "/api/jobs", { ...job(), machine: "m1" });
    expect(await t.services.queue.wants(id)).toBe(false);
  });

  it("fails a render ComfyUI is silent on with its GPU idle for long, so that the pod is not billed for it, and no sooner", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    // the home machine paused: the job goes to the pod, whose pretend ComfyUI keeps it running and says nothing of it
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    const queued = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    const row = () => t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", queued).executeTakeFirstOrThrow();
    // a render like nothing before it has no forecast: its silence counts once it ran 10 min, not from its first second
    type Run = { promptId?: string; startedAt?: number; expectedMs?: number | null };
    const run = () => (t.services.queue as unknown as { lanes: Map<string, { running: Run | null }> }).lanes.get(id)!.running;
    await until(async () => (await row()).status === "running" && Boolean(run()?.promptId));
    expect(run()!.expectedMs ?? null).toBeNull();
    expect(t.services.queue.quietFor(id).ms).toBe(0);
    run()!.startedAt = Date.now() - 10 * 60_000 - 1000;
    await until(() => t.services.queue.quietFor(id).ms > 0);
    // silent, but not for long yet: it runs on
    await t.services.rented.poll();
    expect((await row()).status).toBe("running");
    // silent, but its GPU at work (a node that says nothing on the way): its silence starts again. Read off the clock, not
    // raced against it: a timer in a busy test run can be late by more than any limit a test would set
    await new Promise((r) => setTimeout(r, 300));
    const before = t.services.queue.quietFor(id).ms;
    expect(before).toBeGreaterThanOrEqual(250);
    podComfy.send("crystools.monitor", { cpu_utilization: 10, gpus: [{ gpu_utilization: 95, vram_used: 20, vram_total: 24 }] });
    await until(() => t.services.queue.quietFor(id).ms < before);
    // an idle GPU does not: the silence goes on
    const idleFrom = t.services.queue.quietFor(id).ms;
    podComfy.send("crystools.monitor", { cpu_utilization: 10, gpus: [{ gpu_utilization: 2, vram_used: 20, vram_total: 24 }] });
    await new Promise((r) => setTimeout(r, 100));
    expect(t.services.queue.quietFor(id)).toMatchObject({ gpuIdle: true });
    expect(t.services.queue.quietFor(id).ms).toBeGreaterThanOrEqual(idleFrom);
    // silent past the limit: stuck
    t.services.rented.stuckMs = 1;
    await t.services.rented.poll();
    await until(async () => (await row()).status === "failed");
    expect((await row()).error).toMatch(/^Stuck: no progress from ComfyUI/);
    // dropped in its ComfyUI too (waiting there, it is taken off its queue; running, it is interrupted)
    expect(podComfy.calls).toContain("POST /queue");
    await until(async () => !t.services.queue.runningOn(id));
  });

  /** A render on the pod that its pretend ComfyUI keeps running and says nothing of, and the queue's own record of it. */
  const silentOnPod = async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
    const queued = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    const row = () => t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", queued).executeTakeFirstOrThrow();
    type Run = { promptId?: string; movedAt?: number; startedAt?: number; expectedMs?: number | null; loadAt?: number };
    const run = () => (t.services.queue as unknown as { lanes: Map<string, { running: Run | null }> }).lanes.get(id)!.running!;
    await until(async () => (await row()).status === "running" && Boolean(run()?.promptId && run().movedAt));
    return { id, row, run };
  };
  const MIN = 60_000;

  // The times below are set on the render's own record and read off the clock by the poll, not raced against it.
  it("fails a render silent for 10 min with its GPU read idle, however long its forecast", async () => {
    const { id, row, run } = await silentOnPod();
    run().expectedMs = 6 * 60 * MIN;
    podComfy.send("crystools.monitor", { cpu_utilization: 10, gpus: [{ gpu_utilization: 2, vram_used: 20, vram_total: 24 }] });
    await until(() => Boolean(run().loadAt));
    run().startedAt = run().movedAt = Date.now() - 9.5 * MIN;
    await t.services.rented.poll();
    expect((await row()).status).toBe("running");
    run().startedAt = run().movedAt = Date.now() - 10 * MIN - 1000;
    await t.services.rented.poll();
    await until(async () => (await row()).status === "failed");
    expect((await row()).error).toMatch(/^Stuck: no progress from ComfyUI for 10 min, its GPU idle, on the rented GPU comfy-5090;/);
    await until(async () => !t.services.queue.runningOn(id));
  });

  it("keeps a long silent node whose GPU is at work, past 10 min and past its forecast", async () => {
    const { id, row, run } = await silentOnPod();
    run().expectedMs = 5 * MIN;
    run().startedAt = run().movedAt = Date.now() - 40 * MIN;
    podComfy.send("crystools.monitor", { cpu_utilization: 10, gpus: [{ gpu_utilization: 95, vram_used: 20, vram_total: 24 }] });
    await until(() => Date.now() - run().movedAt! < MIN);
    await t.services.rented.poll();
    expect(t.services.queue.quietFor(id)).toMatchObject({ gpuIdle: true });
    expect(t.services.queue.quietFor(id).ms).toBeLessThan(MIN);
    expect((await row()).status).toBe("running");
  });

  it("with its GPU load not read, waits for a 6 h forecast only up to 10 min over it", async () => {
    const { id, row, run } = await silentOnPod();
    run().expectedMs = 6 * 60 * MIN;
    // silent from its first minute on, a GPU load once read but no more (a feed gone): its forecast is waited for
    podComfy.send("crystools.monitor", { cpu_utilization: 10, gpus: [{ gpu_utilization: 2, vram_used: 20, vram_total: 24 }] });
    await until(() => Boolean(run().loadAt));
    const from = (ago: number) => {
      run().startedAt = Date.now() - ago;
      run().movedAt = run().startedAt! + MIN;
      run().loadAt = run().movedAt;
    };
    from(6 * 60 * MIN + 9 * MIN);
    expect(t.services.queue.quietFor(id).ms).toBe(0);
    await t.services.rented.poll();
    expect((await row()).status).toBe("running");
    from(6 * 60 * MIN + 10 * MIN + 1000);
    await t.services.rented.poll();
    await until(async () => (await row()).status === "failed");
    expect((await row()).error).toMatch(/^Stuck: no progress from ComfyUI for 369 min, past its forecast, on the rented GPU comfy-5090;/);
  });

  it("with its GPU load not read, waits for a short forecast at most twice its length", async () => {
    const { id, row, run } = await silentOnPod();
    run().expectedMs = 4 * MIN;
    run().startedAt = run().movedAt = Date.now() - 7.5 * MIN;
    expect(t.services.queue.quietFor(id).ms).toBe(0);
    run().startedAt = run().movedAt = Date.now() - 8 * MIN - 1000;
    // past twice its forecast, but silent for less than 10 min: not yet
    await t.services.rented.poll();
    expect((await row()).status).toBe("running");
    expect(t.services.queue.quietFor(id).ms).toBeGreaterThan(8 * MIN);
    run().startedAt = run().movedAt = Date.now() - 10 * MIN - 1000;
    await t.services.rented.poll();
    await until(async () => (await row()).status === "failed");
  });

  it("at a cap: stops, and Start is refused", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { rentCaps: { day: 0.0000001, month: 0 } } });
    await new Promise((r) => setTimeout(r, 20));
    await t.services.rented.poll();
    expect(pod5090().status).toBe("EXITED");
    expect((await rowOf(id)).rented?.stoppedBy).toBe("cap");
    const again = await post(t.app, `/api/machines/${id}/start`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/spending cap/);
    // the balance is read again a minute after the last time
    const real = Date.now;
    t.services.rented.now = () => real() + 61_000;
    const spending = (await get(t.app, "/api/rented/spending")).json().spending;
    expect(spending).toMatchObject({ caps: { day: 0.0000001, month: 0 }, lowBalance: false });
    // the balance went down while the pod ran, as RunPod's does
    expect(spending.balance).toBeLessThan(23.4);
    expect(spending.balance).toBeGreaterThan(23.39);
    expect(spending.today).toBeGreaterThan(0);
  });

  it("locks the pod once it is up, says still here to the watchdog on it, and says when there is none", async () => {
    await setKey();
    const id = await add();
    podComfy.packVersion = "0.13.0";
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    expect(podComfy.alive.at(-1)).toMatchObject({ minutes: 15 });
    expect((await rowOf(id)).rented?.watchdog).toBe("on");
    // up, with a pack that can: locked at once, as its address is public
    expect(podComfy.lock?.token).toBeTruthy();
    expect((await readSettings(t.db)).machines.find((m) => m.id === id)?.token).toBe(podComfy.lock?.token);
    podComfy.packVersion = "0.12.0";
    await t.services.rented.poll();
    expect((await rowOf(id)).rented?.watchdog).toBe("none");
  });

  it("is picked up running after Afflatus restarts, its session not counted twice", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    const again = await makeApp({ db: t.db, comfyUrl: home.url }).catch(() => null);
    // the same database read by a second Afflatus: it reads RunPod and knows the pod runs
    if (again) {
      await again.services.rented.poll();
      expect((await again.services.queue.status()).machines.find((m) => m.id === id)?.rented?.status).toBe("RUNNING");
      expect((await sessions()).length).toBe(1);
      again.services.rented.stop();
    }
  });

  it("after Afflatus restarts, says its idle time left from its last work as kept, and never says it gone before RunPod is read", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    // its last work 3 min ago, as kept on its open session
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    await t.db.updateTable("rent_sessions").set({ started_at: ago(30), up_at: ago(28), busy_at: ago(3) }).where("ended_at", "is", null).execute();
    t.services.rented.stop();
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    try {
      again.services.rented.everyMs = 60_000;
      // not read from RunPod yet: not known, never "GONE"
      const before = (await again.services.queue.status()).machines.find((m) => m.id === id)?.rented;
      expect(before?.status).not.toBe("GONE");
      expect(again.services.rented.podGone(id)).toBe(false);
      // its first read held where its ComfyUI is asked (a pod's proxy can take seconds): RunPod says it runs from then on,
      // and its idle time left is said from then too, not only once the read ends
      const r = again.services.rented as unknown as { alive: (...a: unknown[]) => Promise<boolean> };
      const alive = r.alive.bind(r);
      let release = () => {};
      const held = new Promise<void>((done) => (release = done));
      r.alive = async (...a) => (await held, alive(...a));
      const polled = again.services.rented.poll();
      const rowOf = async () => (await again.services.queue.status()).machines.find((m) => m.id === id)?.rented;
      await until(async () => (await rowOf())?.status === "RUNNING");
      const near7 = (ms: number | null | undefined) => ms !== null && ms !== undefined && Math.abs(ms - 7 * 60_000) < 10_000;
      expect(near7((await rowOf())?.idleLeftMs)).toBe(true);
      release();
      await polled;
      expect(near7((await rowOf())?.idleLeftMs)).toBe(true);
      // the queue's answer says it as the moment it stops
      const said = (await get(again.app, "/api/queue")).json().machines.find((m: { id: string }) => m.id === id).rented;
      expect(near7(said.idleAt - Date.now())).toBe(true);
    } finally {
      again.services.rented.stop();
    }
  });

  it("after Afflatus restarts with its ComfyUI not answering, keeps its idle time from its last work: never a fresh one", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    await t.db.updateTable("rent_sessions").set({ started_at: ago(30), up_at: ago(28), busy_at: ago(3) }).where("ended_at", "is", null).execute();
    t.services.rented.stop();
    // its ComfyUI went down meanwhile (or its proxy does not answer at that read)
    podComfy.down = true;
    const again = await makeApp({ db: t.db, comfyUrl: home.url });
    try {
      again.services.rented.everyMs = 60_000;
      await again.services.rented.poll();
      await again.services.rented.poll();
      const left = (await again.services.queue.status()).machines.find((m) => m.id === id)?.rented?.idleLeftMs;
      expect(Math.abs((left ?? 0) - 7 * 60_000)).toBeLessThan(10_000);
      // stopped at its idle time from its last work, not 10 min after the restart
      const real = Date.now;
      again.services.rented.now = () => real() + 7.5 * 60_000;
      await again.services.rented.poll();
      expect(pod5090().status).toBe("EXITED");
    } finally {
      again.services.rented.stop();
    }
  });

  it("is not removed from Afflatus while it runs (billed, nothing would stop it), and is once stopped", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    expect((await sessions()).filter((r) => !r.ended_at)).toHaveLength(1);
    const refused = await post(t.app, `/api/machines/${id}/remove`, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/stop or terminate it first/);
    // still counted while it runs
    expect((await sessions()).filter((r) => !r.ended_at)).toHaveLength(1);
    await post(t.app, `/api/machines/${id}/stop`, { how: "stop" });
    await until(async () => (await t.services.rented.poll(), pod5090().status === "EXITED"));
    await t.services.rented.poll();
    expect((await post(t.app, `/api/machines/${id}/remove`, {})).statusCode).toBe(200);
    expect((await sessions()).filter((r) => !r.ended_at)).toEqual([]);
  });

  it("still running a while after its idle stop is asked to stop again: never left billing", async () => {
    await setKey();
    const id = await add();
    podComfy.packVersion = "0.14.0";
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    // RunPod takes the stop and the pod goes on running
    runpod.stopMs = 60 * 60_000;
    const real = Date.now;
    t.services.rented.now = () => real() + 11 * 60_000;
    await t.services.rented.poll();
    const stops = () => runpod.calls.filter((c) => c === `POST /v2/pods/${pod5090().id}/action stop`).length;
    expect(stops()).toBe(1);
    // a pod being stopped hears no "still here": its own watchdog may stop it if RunPod does not
    const pinged = podComfy.alive.length;
    await t.services.rented.poll();
    expect(podComfy.alive.length).toBe(pinged);
    expect(stops()).toBe(1);
    t.services.rented.now = () => real() + 14 * 60_000;
    await t.services.rented.poll();
    expect(stops()).toBe(2);
  });

  it("while RunPod's list cannot be read, says \"still here\" only to a pod with work or within its idle time", async () => {
    await setKey();
    const id = await add();
    podComfy.packVersion = "0.14.0";
    await post(t.app, `/api/machines/${id}/start`, {});
    await until(async () => (await t.services.rented.poll(), pod5090().status === "RUNNING"));
    await t.services.rented.poll();
    runpod.failList = 500;
    const pinged = podComfy.alive.length;
    await t.services.rented.poll();
    // within its idle time: kept alive while Afflatus cannot ask RunPod anything
    expect(podComfy.alive.length).toBe(pinged + 1);
    const real = Date.now;
    t.services.rented.now = () => real() + 11 * 60_000;
    await t.services.rented.poll();
    // idle past its time, and RunPod cannot be told to stop it: silent, so that its watchdog stops it
    expect(podComfy.alive.length).toBe(pinged + 1);
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(true);
  });

  it("never gives the page a pod's environment, nor lets the page write the secrets to delete", async () => {
    await setKey();
    pod5090().env = { AFFLATUS_TOKEN: "plain-token", HF_TOKEN: "hf_secret" };
    const pods = (await get(t.app, "/api/runpod/pods")).json().pods as Array<{ env: Record<string, string> }>;
    expect(JSON.stringify(pods)).not.toContain("plain-token");
    expect(JSON.stringify(pods)).not.toContain("hf_secret");
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { leftSecrets: [{ secret: "someone-elses", pod: "x" }] } });
    expect((await readSettings(t.db)).leftSecrets).toEqual([]);
  });

  it("is terminated when asked: gone from RunPod and from Afflatus, its secret with it", async () => {
    await setKey();
    const id = await add();
    await post(t.app, `/api/machines/${id}/start`, {});
    expect(Object.keys(runpod.secrets)).toHaveLength(1);
    expect((await post(t.app, `/api/machines/${id}/stop`, { how: "terminate" })).statusCode).toBe(200);
    expect(pod5090().status).toBe("TERMINATED");
    expect((await readSettings(t.db)).machines.some((m) => m.id === id)).toBe(false);
    expect(runpod.secrets).toEqual({});
  });

  it("terminated on RunPod's side: said not on RunPod", async () => {
    await setKey();
    const id = await add();
    pod5090().status = "TERMINATED";
    await t.services.rented.poll();
    expect((await rowOf(id)).rented?.status).toBe("GONE");
    expect(t.services.queue.unavailable(id)).toBe("not on RunPod");
  });
});
