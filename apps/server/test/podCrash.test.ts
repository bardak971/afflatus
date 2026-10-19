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
  vi.unstubAllEnvs();
  // the test's jobs stopped first: a render sent to a pod again (a pod that only stopped answering) runs on a pretend ComfyUI
  // that never ends it, and the close waits for the queue to be idle, past the hook's 30 s under a loaded run
  const open = await t.db.selectFrom("jobs").select("id").where("status", "in", ["queued", "running"]).execute();
  await Promise.all(open.map((j) => t.services.queue.cancel(j.id).catch(() => false)));
  await t.services.queue.idle();
  await t.close();
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
