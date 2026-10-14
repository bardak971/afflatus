import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings } from "../src/settings";
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
    expect(row.rented).toMatchObject({ status: "EXITED", rate: null, diskPerDay: expect.closeTo((50 * 0.2) / 30, 5) });
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
    expect((await sessions()).map((s) => [s.machine_id, s.rate, s.ended_at])).toEqual([[id, 0.69, null]]);
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", queued).executeTakeFirstOrThrow()).status !== "queued");
    const ran = await t.db.selectFrom("jobs").select(["status", "machine_id", "error"]).where("id", "=", queued).executeTakeFirstOrThrow();
    expect(ran).toMatchObject({ machine_id: id });
    await until(() => podComfy.calls.includes("POST /prompt"));
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
    await until(async () => (await row()).status === "running" && t.services.queue.quietFor(id) > 0);
    // silent, but not for long yet: it runs on
    await t.services.rented.poll();
    expect((await row()).status).toBe("running");
    // silent, but its GPU at work (a node that says nothing on the way): it runs on
    t.services.rented.stuckMs = 400;
    for (let i = 0; i < 6; i++) {
      podComfy.send("crystools.monitor", { cpu_utilization: 10, gpus: [{ gpu_utilization: 95, vram_used: 20, vram_total: 24 }] });
      await new Promise((r) => setTimeout(r, 100));
    }
    await t.services.rented.poll();
    expect((await row()).status).toBe("running");
    // its GPU idle and ComfyUI silent: stuck
    await new Promise((r) => setTimeout(r, 450));
    await t.services.rented.poll();
    await until(async () => (await row()).status === "failed");
    expect((await row()).error).toMatch(/^Stuck: no progress from ComfyUI/);
    // dropped in its ComfyUI too (waiting there, it is taken off its queue; running, it is interrupted)
    expect(podComfy.calls).toContain("POST /queue");
    await until(async () => !t.services.queue.runningOn(id));
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
