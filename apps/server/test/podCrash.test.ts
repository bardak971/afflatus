import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings, updateSettings } from "../src/settings";
import { reportsDeath } from "../src/runpod";
import { get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * A pod whose ComfyUI dies during a render (deploy/runpod/died.py, broken.py "comfy_died"), against a pretend RunPod: the
 * render fails at once with why and is never run again, the pod is terminated at once as a crash (not left to its idle
 * time), and the death is said on its card, in a notice and on its run in Queue › Costs. An older image, whose ComfyUI
 * restarted without the render, is taken the same way.
 */

const KEY = "rpa_test_key_0123456789";
let home: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
const spawned: FakeComfy[] = [];
let told: Array<{ kind: string; title: string; body: string }>;

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
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
  t.services.rented.imageCheck = async () => true;
  told = [];
  t.services.rented.tell = t.services.queue.tell = (kind, said) => void told.push({ kind, ...said });
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
});
afterEach(async () => {
  // the test's jobs stopped first: a render sent to a pod again (a pod that only stopped answering) runs on a pretend ComfyUI
  // that never ends it, and the close waits for the queue to be idle, past the hook's 30 s under a loaded run
  const open = await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute();
  await Promise.all(open.map((j) => t.services.queue.cancel(j.id).catch(() => false)));
  await t.services.queue.idle();
  await t.close();
  // the envs unstubbed last: a RunPod call still under way until the close (a hunt's round, a poll) read them
  // again and, without them, went to RunPod itself
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
});

const ASK = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 };
const GB = 1024 ** 3;
const OOM = {
  error: "ComfyUI was killed: out of system memory (peak 49.8 of 50.0 GB)",
  report: { cause: "oom", signal: 9, exit: null, oom_kills: 1, ram_peak: Math.round(49.8 * GB), ram_limit: 50 * GB, vram_used: 30 * GB, vram_total: 48 * GB, ran_s: 2100 },
};
const rowOf = async (id: string) => (await t.services.queue.status()).machines.find((m) => m.id === id);
const jobOf = (id: string) => t.db.selectFrom("jobs").select(["status", "error", "error_trace", "attempts"]).where("id", "=", id).executeTakeFirstOrThrow();
type Run = { promptId?: string };
/** The pod's image as an older Afflatus left it, or a pod deployed before Afflatus kept it. */
const withImage = (id: string, image: string) => updateSettings(t.db, (s) => ({ machines: s.machines.map((m) => (m.id === id && m.rented ? { ...m, rented: { ...m.rented, image } } : m)) }));
const running = (machine: string) => (t.services.queue as unknown as { lanes: Map<string, { running: Run | null }> }).lanes.get(machine)?.running ?? null;

/**
 * A pod deployed and up, the home machine paused so that a render goes to it, and that render running there. `image`: the
 * one it was deployed with, when not Deploy's own.
 */
async function renderingOnAPod(image?: string): Promise<{ id: string; pod: FakeRunpod["pods"][number]; jobId: string }> {
  const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
  const pod = runpod.pods[0]!;
  if (image !== undefined) await withImage(id, image);
  await until(async () => (await t.services.rented.poll(), (await rowOf(id))?.rented?.booting === false && pod.status === "RUNNING"));
  await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: { machine: "m1" } });
  const jobId = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
  await until(async () => (await jobOf(jobId)).status === "running" && Boolean(running(id)?.promptId));
  return { id, pod, jobId };
}

describe("a pod's ComfyUI that dies during a render", () => {
  it("fails the render at once with why, never runs it again, and terminates the pod as a crash", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    pod.comfy.bootLog?.lines.push({ t: new Date().toISOString(), m: "\x1b[32m[INFO]\x1b[0m got prompt" }, { t: new Date().toISOString(), m: "[afflatus-pod] ComfyUI ended (status 137)" });
    // the pod's ComfyUI killed: broken.py answers on its port with died.py's report
    pod.comfy.podDied = OOM;
    await t.services.rented.poll();
    await until(async () => (await jobOf(jobId)).status === "failed");
    const failed = await jobOf(jobId);
    expect(failed.error).toMatch(/^ComfyUI was killed: out of system memory \(peak 49\.8 of 50\.0 GB\)/);
    expect(failed.error).toMatch(/Not run again on its own/);
    // its report and ComfyUI's last lines kept with the job
    expect(failed.error_trace).toMatch(/The pod's report: \{"cause":"oom"/);
    // as plain text: ComfyUI's colour codes left out
    expect(failed.error_trace).toContain("[INFO] got prompt");
    expect(failed.error_trace).not.toContain("\x1b[");
    expect(failed.error_trace).toMatch(/ComfyUI's last lines:[\s\S]*ComfyUI ended \(status 137\)/);
    // not queued again: it stays failed, and nothing else runs it
    await new Promise((r) => setTimeout(r, 300));
    expect((await jobOf(jobId)).status).toBe("failed");
    // terminated at once, said as a crash, not as idle
    expect(pod.status).toBe("TERMINATED");
    const row = (await rowOf(id))!.rented!;
    expect(row).toMatchObject({ stoppedBy: "crash", status: "GONE" });
    expect(row.error).toMatch(/^Terminated: ComfyUI was killed: out of system memory .* Its render failed, not run again\. ComfyUI's last lines are in its log/);
    const stop = told.find((x) => x.kind === "podStopped")!;
    expect(stop.title).toMatch(/terminated$/);
    expect(stop.body).toMatch(/^Why: ComfyUI was killed: out of system memory \(peak 49\.8 of 50\.0 GB\); its render failed, not run again\./);
    expect(runpod.secrets).toEqual({});
    // its run says it, past a restart of Afflatus: its end's why and the pod's report on its session, Costs' row
    const session = await t.db.selectFrom("rent_sessions").selectAll().executeTakeFirstOrThrow();
    expect(session.end_why).toBe("crash");
    expect(JSON.parse(session.crash!)).toEqual({ said: OOM.error, report: OOM.report });
    const costs = (await get(t.app, "/api/costs?days=1")).json() as { pods?: { sessions: Array<{ crash: string | null }> } };
    const crashes = JSON.stringify(costs).match(/"crash":"([^"]*)"/);
    expect(crashes?.[1]).toBe(OOM.error);
    // the death kept for its render is let go with it
    expect((t.services.queue as unknown as { died: Map<string, unknown> }).died.size).toBe(0);
  });

  it("seen late (RunPod's reads delayed past the render's wait): asked of the pod before the render goes again, failed, the pod terminated", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    // no read of RunPod comes meanwhile: the render's own wait finds ComfyUI gone first
    pod.comfy.podDied = OOM;
    await until(async () => (await jobOf(jobId)).status !== "running", 20_000);
    const failed = await jobOf(jobId);
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.error).toMatch(/^ComfyUI was killed: out of system memory .*Not run again on its own/);
    expect(failed.error_trace).toMatch(/The pod's report: \{"cause":"oom"/);
    await t.services.rented.poll();
    expect(pod.status).toBe("TERMINATED");
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "crash" });
    expect(told.find((x) => x.kind === "podStopped")!.body).toMatch(/its render failed, not run again/);
  });

  it("terminates a pod at work outside Afflatus the same way: no render to fail", async () => {
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    const pod = runpod.pods[0]!;
    await until(async () => (await t.services.rented.poll(), (await rowOf(id))?.rented?.booting === false && pod.status === "RUNNING"));
    pod.comfy.podDied = { error: "ComfyUI ended on signal 11", report: { cause: "signal", signal: 11 } };
    await t.services.rented.poll();
    expect(pod.status).toBe("TERMINATED");
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "crash" });
    expect(told.find((x) => x.kind === "podStopped")!.body).toMatch(/^Why: ComfyUI ended on signal 11\./);
  });

  it("never terminates a pod the user added: its render fails, the death is said", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    await updateSettings(t.db, (s) => ({ machines: s.machines.map((m) => (m.id === id && m.rented ? { ...m, rented: { ...m.rented, deployed: false } } : m)) }));
    pod.comfy.podDied = OOM;
    await t.services.rented.poll();
    await until(async () => (await jobOf(jobId)).status === "failed");
    expect(pod.status).toBe("RUNNING");
    const said = told.find((x) => x.kind === "comfyGone")!;
    expect(said.title).toMatch(/ComfyUI died$/);
    expect(said.body).toMatch(/Its render failed, not run again\. A pod added by hand is not terminated by Afflatus/);
    // said once, not at each read
    await t.services.rented.poll();
    expect(told.filter((x) => x.kind === "comfyGone")).toHaveLength(1);
  });

  it("deployed with Deploy's image: the image is kept, one that reports its deaths", async () => {
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    const m = (await readSettings(t.db)).machines.find((x) => x.id === id)!;
    expect(m.rented!.image).toMatch(/\/afflatus-pod:\d+\.\d+\.\d+$/);
    expect(reportsDeath(m.rented!.image)).toBe(true);
    expect(reportsDeath("ghcr.io/bardak971/afflatus-pod:0.1.19-cu128")).toBe(true);
    expect(reportsDeath("ghcr.io/bardak971/afflatus-pod:0.1.18")).toBe(false);
    expect(reportsDeath("ghcr.io/bardak971/afflatus-pod:0.2.0")).toBe(true);
    expect(reportsDeath("")).toBe(false);
    expect(reportsDeath("runpod/comfyui:1.4.0-comfyuiv0.35.0-cuda12.8")).toBe(false);
  });

  it("an image that reports its deaths: a render cleared from its ComfyUI is no crash, it goes again and the pod is kept", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    // someone cleared the queue on the pod's own ComfyUI page: it answers, without the prompt
    pod.comfy.running = [];
    pod.comfy.pending = [];
    // it goes again: sent to the pod a second time (or, taken for a crash, failed)
    const sent = pod.comfy.prompts.size;
    await until(async () => pod.comfy.prompts.size > sent || (await jobOf(jobId)).status === "failed", 20_000);
    expect((await jobOf(jobId)).status).not.toBe("failed");
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: null, crash: null });
    expect(told.some((x) => x.kind === "podStopped")).toBe(false);
  });

  it("an older image: its ComfyUI back without the render is a crash too, the render failed and the pod terminated", async () => {
    const { id, pod, jobId } = await renderingOnAPod("ghcr.io/bardak971/afflatus-pod:0.1.18");
    // the container started again under the render: a fresh ComfyUI that never heard of the prompt
    pod.comfy.running = [];
    pod.comfy.pending = [];
    await until(async () => (await jobOf(jobId)).status === "failed", 20_000);
    const failed = await jobOf(jobId);
    expect(failed.error).toMatch(/^ComfyUI started again on the pod during the render, without it: it likely crashed/);
    await until(async () => (await t.services.rented.poll(), pod.status === "TERMINATED"));
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "crash" });
    expect(told.find((x) => x.kind === "podStopped")!.body).toMatch(/^Why: ComfyUI started again on the pod during the render/);
    expect((await jobOf(jobId)).status).toBe("failed");
  });

  /** Its render failed as stuck, its prompt still running in the pod's ComfyUI after the stop (a node that never reaches the interrupt check). */
  async function hungOnAPod(): Promise<{ id: string; pod: FakeRunpod["pods"][number]; jobId: string; promptId: string }> {
    const on = await renderingOnAPod();
    const promptId = running(on.id)!.promptId!;
    if (!on.pod.comfy.running.includes(promptId)) on.pod.comfy.running.push(promptId);
    on.pod.comfy.deaf.add(promptId);
    expect(await t.services.queue.endStuck(on.id, "Stuck: no progress from ComfyUI for 20 min, its GPU idle")).toBe(true);
    await until(async () => (await jobOf(on.jobId)).status === "failed");
    expect(on.pod.comfy.running).toContain(promptId);
    return { ...on, promptId };
  }
  const later = (ms: number) => {
    const real = Date.now;
    t.services.rented.now = () => real() + ms;
  };

  it("a render failed as stuck that still runs in a deployed pod's ComfyUI a minute after: the pod is terminated as hung (M2)", async () => {
    const { id, pod, jobId } = await hungOnAPod();
    expect((await jobOf(jobId)).error).toMatch(/^Stuck: /);
    // its own, not work from outside Afflatus that would hold the pod busy
    expect(await t.services.queue.busyOutside(id)).toBe(false);
    // the stop given a minute to reach it
    later(20_000);
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
    later(90_000);
    await t.services.rented.poll();
    await until(async () => (await t.services.rented.poll(), pod.status === "TERMINATED"));
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "crash" });
    expect((await rowOf(id))!.rented!.crash).toMatch(/hung in a render failed as stuck/);
  });

  it("the same across a restart of Afflatus: the stuck prompt read back from its job, never taken for outside work (M2)", async () => {
    const { id, pod } = await hungOnAPod();
    // Afflatus restarted: what it knew in memory is gone, the jobs are read back
    const queue = t.services.queue as unknown as { stuckOn: Map<string, unknown>; loadStuck(): Promise<void> };
    queue.stuckOn.clear();
    (t.services.rented as unknown as { seen: Map<string, unknown> }).seen.clear();
    await queue.loadStuck();
    expect(await t.services.queue.busyOutside(id)).toBe(false);
    later(3 * 60_000);
    await until(async () => (await t.services.rented.poll(), pod.status === "TERMINATED"));
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "crash" });
  });

  it("a pod added by hand, hung the same way: said, given no job, its idle stop not held, never terminated as a crash (M2)", async () => {
    const { id, pod, promptId } = await hungOnAPod();
    await updateSettings(t.db, (s) => ({ machines: s.machines.map((m) => (m.id === id && m.rented ? { ...m, rented: { ...m.rented, deployed: false } } : m)) }));
    later(90_000);
    await t.services.rented.poll();
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
    expect(t.services.rented.unavailable(id)).toMatch(/^ComfyUI hung in a render failed as stuck/);
    expect(told.filter((x) => x.title.endsWith("ComfyUI hung"))).toHaveLength(1);
    // a job waiting is not sent behind it
    const next = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await t.services.queue.idle();
    expect((await jobOf(next)).status).toBe("queued");
    await t.services.queue.cancel(next);
    // its ComfyUI restarted by the user: the prompt gone, it takes work again
    pod.comfy.running = pod.comfy.running.filter((p) => p !== promptId);
    await t.services.rented.poll();
    expect(t.services.rented.unavailable(id)).toBeNull();
    // hung again: its idle time runs all the same, the pod ended as its idle choice says, never as a crash
    pod.comfy.running.push(promptId);
    (t.services.queue as unknown as { noteStuck(m: string, p: string, at: number): void }).noteStuck(id, promptId, Date.now() - 2 * 60_000);
    later(12 * 60_000);
    await until(async () => (await t.services.rented.poll(), pod.status !== "RUNNING"));
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "idle" });
  });

  it("a render left running by a restart on a machine since removed is queued again, never followed on another pod that is then terminated (M3)", async () => {
    // pod B, of an image that does not report deaths, first in the machines' order
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    const pod = runpod.pods[0]!;
    await withImage(id, "ghcr.io/bardak971/afflatus-pod:0.1.18");
    await until(async () => (await t.services.rented.poll(), (await rowOf(id))?.rented?.booting === false && pod.status === "RUNNING"));
    await updateSettings(t.db, (s) => ({ machines: [...s.machines.filter((m) => m.id === id), ...s.machines.filter((m) => m.id !== id)] }));
    await t.app.inject({ method: "POST", url: "/api/queue/pause", payload: {} });
    const jobId = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    // as a restart finds it: running on pod A, gone from RunPod and from the settings meanwhile
    const resume = { promptId: "on-pod-a", seed: 1, outputs: {}, totalSteps: 20, phases: {}, loads: [], startedAt: Date.now() };
    await t.db.updateTable("jobs").set({ status: "running", machine_id: "rp-gone", attempts: 1, resume: JSON.stringify(resume) }).where("id", "=", jobId).execute();
    t.services.queue.nudge();
    await until(async () => (await jobOf(jobId)).status !== "running", 20_000);
    expect(await jobOf(jobId)).toMatchObject({ status: "queued", error: null });
    const kept = JSON.parse((await t.db.selectFrom("jobs").select("resume").where("id", "=", jobId).executeTakeFirstOrThrow()).resume ?? "null") as { unsent?: boolean; lostAt?: number } | null;
    // its prompt id kept, checked on the machine that takes it next, and not held for pod A, which never comes back
    expect(kept).toMatchObject({ promptId: "on-pod-a", unsent: true });
    expect(kept?.lostAt).toBeUndefined();
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: null, crash: null });
  });

  it("a pod that merely stops answering mid-render (its proxy out, a stop) is no crash: the render goes again, the pod is kept", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    // the provider's proxy answers for it, saying no container is there: the render's wait ends on ComfyUI gone (ComfyAway)
    pod.comfy.down = true;
    await until(async () => (await jobOf(jobId)).status === "queued", 20_000);
    expect((await jobOf(jobId)).error).toBeNull();
    pod.comfy.down = false;
    await t.services.rented.poll();
    expect(pod.status).toBe("RUNNING");
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: null, crash: null });
    expect(told.some((x) => x.kind === "podStopped")).toBe(false);
  });

  it("a terminate RunPod refuses is asked again at the next read, the render failed once", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    runpod.failAction[pod.id] = 500;
    pod.comfy.podDied = OOM;
    await t.services.rented.poll().catch(() => {});
    await until(async () => (await jobOf(jobId)).status === "failed");
    // refused: still running, still billed, and not taken for done
    expect(pod.status).toBe("RUNNING");
    delete runpod.failAction[pod.id];
    await t.services.rented.poll().catch(() => {});
    expect(pod.status).toBe("TERMINATED");
    expect((await rowOf(id))!.rented).toMatchObject({ stoppedBy: "crash", crash: OOM.error });
    const stops = told.filter((x) => x.kind === "podStopped");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.body).toMatch(/its render failed, not run again/);
  });

  it("a death is its own render's only: a later job on the same pod, stopped by the user, is cancelled, not failed with it", async () => {
    const { id, pod, jobId } = await renderingOnAPod();
    await updateSettings(t.db, (s) => ({ machines: s.machines.map((m) => (m.id === id && m.rented ? { ...m, rented: { ...m.rented, deployed: false } } : m)) }));
    pod.comfy.podDied = OOM;
    await t.services.rented.poll();
    await until(async () => (await jobOf(jobId)).status === "failed");
    // the user starts its ComfyUI again; a next render runs there, and is stopped by the user
    pod.comfy.podDied = null;
    pod.comfy.running = [];
    pod.comfy.pending = [];
    const next = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(async () => (await jobOf(next)).status === "running" && Boolean(running(id)?.promptId));
    await t.app.inject({ method: "POST", url: `/api/jobs/${next}/cancel` });
    await until(async () => (await jobOf(next)).status !== "running");
    expect(await jobOf(next)).toMatchObject({ status: "cancelled", error: "stopped by you" });
  });
});
