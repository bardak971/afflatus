import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { bootOf, BootLogs, bootStep, parseBootLog } from "../src/podBoot";
import { readSettings, updateSettings } from "../src/settings";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/**
 * A deployed pod's boot, said where it is (podBoot.ts): from RunPod's data (no uptime: its image pulled; up: ComfyUI
 * starting), then from the Afflatus image's boot log, read with the pod's token only, in its log tab before ComfyUI's own.
 */

const line = (m: string, t = "2026-10-16T10:00:00.000Z") => ({ t, m });

describe("where a boot is, from RunPod's data and the boot log", () => {
  it("pulling the image while RunPod says no uptime, ComfyUI starting once it does, then the log's step", () => {
    expect(bootOf({ uptime: null }, null, 5)).toEqual({ phase: "pulling", step: null, failed: false, from: 5 });
    expect(bootOf({ uptime: 0 }, null, 5)).toMatchObject({ phase: "starting", step: null });
    expect(bootOf(null, null, 5).phase).toBe("pulling");
    const log = parseBootLog({ lines: [line("[afflatus-pod] step: checking the GPU"), line("[afflatus-pod] ComfyUI's files in /workspace/comfyui"), line("[afflatus-pod] step: putting in the node packs")] })!;
    // the log says more than RunPod: its step, whatever the uptime says
    expect(bootOf({ uptime: null }, log, 5)).toEqual({ phase: "step", step: "putting in the node packs", failed: false, from: 5 });
    // a log with no step yet says nothing more than RunPod
    expect(bootOf({ uptime: 3 }, parseBootLog({ lines: [] }), 5).phase).toBe("starting");
  });

  it("follows ComfyUI's own start after its step, and says where a start stopped", () => {
    const comfy = ["[afflatus-pod] step: starting ComfyUI", "Total VRAM 24135 MB, total RAM 128000 MB", "Import times for custom nodes:", "Starting server"].map((m) => line(m));
    expect(bootStep(comfy.slice(0, 1)).step).toBe("starting ComfyUI");
    expect(bootStep(comfy.slice(0, 2)).step).toBe("loading custom nodes");
    expect(bootStep(comfy).step).toBe("starting ComfyUI server");
    // ComfyUI's words count only once start.sh started it
    expect(bootStep([line("[afflatus-pod] step: checking the GPU"), line("Total VRAM 1 MB")]).step).toBe("checking the GPU");
    const failed = parseBootLog({ lines: [line("[afflatus-pod] step: putting in the node packs"), line("cp: no space left on device"), line("[afflatus-pod] failed: putting in the node packs (exit 1)")] })!;
    expect(bootOf({ uptime: 40 }, failed, 5)).toEqual({ phase: "step", step: "putting in the node packs (exit 1)", failed: true, from: 5 });
    // broken.py's words, the GPU check that failed
    expect(bootStep([line("[afflatus-pod] step: checking the GPU"), line("[afflatus-pod] failed: the GPU does not work on this host: RuntimeError: CUDA unknown error")]).failed).toMatch(/^the GPU does not work/);
    // a container started again begins anew: the failure before is not this start's
    expect(bootStep([...failed.lines, line("[afflatus-pod] step: checking the GPU")])).toEqual({ step: "checking the GPU", failed: null });
  });

  it("takes only the log's shape, bounded", () => {
    expect(parseBootLog(null)).toBeNull();
    expect(parseBootLog({ lines: "no" })).toBeNull();
    const long = parseBootLog({ lines: [...Array.from({ length: 400 }, (_, i) => line(`l${i}`)), { t: 1, m: "x" }, null, line("y".repeat(5000))] })!;
    expect(long.lines).toHaveLength(300);
    expect(long.lines.at(-1)!.m).toHaveLength(2000);
  });
});

describe("the boot log read from the pod", () => {
  let pod: FakeComfy;
  beforeEach(async () => {
    pod = await makeFake();
    vi.stubEnv("RUNPOD_PROXY", `${pod.url.replace(/\d+$/, "")}{id}`);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await pod.close();
  });
  const id = () => new URL(pod.url).port;
  const TOKEN = "k".repeat(43);

  it("with the pod's token: its lines and step; without it, nothing, and what was read before is kept", async () => {
    pod.bootLog = { token: TOKEN, lines: [line("[afflatus-pod] step: checking the GPU")] };
    const logs = new BootLogs();
    expect((await logs.read("m1", id(), TOKEN, 0))?.step).toBe("checking the GPU");
    expect(pod.calls).toContain("GET /afflatus/boot");
    // another token: refused by the pod, the last log kept
    const other = new BootLogs();
    expect(await other.read("m1", id(), "x".repeat(43), 0)).toBeNull();
    pod.bootLog.lines.push(line("[afflatus-pod] step: starting ComfyUI"));
    expect((await logs.read("m1", id(), TOKEN, 0))?.step).toBe("starting ComfyUI");
    // read again at most this often: within it, the log as last read
    pod.bootLog.lines.push(line("[afflatus-pod] failed: starting ComfyUI (exit 1)"));
    expect((await logs.read("m1", id(), TOKEN, 60_000))?.failed).toBeNull();
    // the pod gone, its server with it: the last lines stay, to say why
    pod.bootLog = null;
    pod.down = true;
    expect((await logs.read("m1", id(), TOKEN, 0))?.step).toBe("starting ComfyUI");
    logs.forget("m1");
    expect(logs.get("m1")).toBeNull();
  });

  it("a pod without a boot log (RunPod's image, an older Afflatus image) is no error: nothing read", async () => {
    const logs = new BootLogs();
    expect(await logs.read("m1", id(), TOKEN, 0)).toBeNull();
    pod.down = true;
    expect(await logs.read("m1", id(), TOKEN, 0)).toBeNull();
    expect(await logs.read("m1", id(), "", 0)).toBeNull();
  });
});

describe("a deployed pod's boot on its card, its row and its log tab", () => {
  const KEY = "rpa_test_key_0123456789";
  let home: FakeComfy;
  let runpod: FakeRunpod;
  let t: TestApp;
  const spawned: FakeComfy[] = [];
  beforeEach(async () => {
    home = await makeFake();
    runpod = await startFakeRunpod({
      key: KEY, bootMs: 20, pullMs: 400, startMs: 400, pods: [],
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
    t.services.rented.bootEveryMs = 0;
    t.services.rented.imageCheck = async () => true;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await t.close();
    await Promise.all([home, runpod, ...spawned.splice(0)].map((x) => x.close().catch(() => {})));
  });
  const ASK = { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 120, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 };
  const rowOf = async (id: string) => {
    await t.services.rented.poll();
    return (await t.services.queue.status()).machines.find((m) => m.id === id)!.rented!;
  };

  it("pulling the image, then its boot log's steps, then up: the log tab has the boot log until ComfyUI answers", async () => {
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    const pulling = await rowOf(id);
    expect(pulling).toMatchObject({ booting: true, boot: { phase: "pulling", step: null, failed: false }, error: null });
    // no idle countdown while it boots: its idle time counts from its first answer
    expect(pulling.idleLeftMs).toBeNull();
    // its boot log's port is Afflatus's own, behind its token: not said as a port open outside the lock
    expect(pulling.otherPorts).toEqual([]);
    expect((await get(t.app, `/api/comfy/logs?machine=${id}`)).json()).toEqual({ lines: [], source: "boot" });
    await until(async () => (await rowOf(id)).boot?.phase === "step");
    const logs = (await get(t.app, `/api/comfy/logs?machine=${id}`)).json() as { lines: Array<{ t: string; m: string }>; source: string };
    expect(logs.source).toBe("boot");
    expect(logs.lines[0]!.m).toBe("[afflatus-pod] step: checking the GPU");
    // read with the machine's token, the one the pod was given for its lock
    const token = (await readSettings(t.db)).machines.find((m) => m.id === id)!.token;
    expect(pod.comfy.bootLog?.token).toBe(token);
    // the lines from a stamp on: only the newer ones
    const since = logs.lines.at(-1)!.t;
    const more = (await get(t.app, `/api/comfy/logs?machine=${id}&since=${encodeURIComponent(since)}&of=boot`)).json() as { lines: Array<{ t: string }> };
    expect(more.lines.every((l) => l.t >= since)).toBe(true);
    await until(async () => (await rowOf(id)).booting === false);
    expect((await rowOf(id)).boot).toBeNull();
    expect((await rowOf(id)).idleLeftMs).toBeGreaterThan(0);
    // up: ComfyUI's own log
    expect((await get(t.app, `/api/comfy/logs?machine=${id}`)).json().source).toBe("comfy");
  });

  it("a start that stops on an error is terminated at once, not billed to its boot limit; its card and its log say why", async () => {
    const told: Array<{ body: string }> = [];
    t.services.rented.tell = (_kind, said) => void told.push(said);
    runpod.bootFails = "putting in the node packs";
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await until(async () => (await rowOf(id), pod.status === "TERMINATED"));
    const row = (await t.services.queue.status()).machines.find((m) => m.id === id)!.rented!;
    expect(row).toMatchObject({ stoppedBy: "start", status: "GONE", boot: null });
    expect(row.error).toMatch(/^Terminated: its start stopped at "putting in the node packs \(exit 1\)", as its boot log says/);
    expect(told.map((x) => x.body).join("\n")).toMatch(/its start stopped on an error: putting in the node packs \(exit 1\)/);
    expect(runpod.secrets).toEqual({});
    // its last lines kept, after its pod is gone
    const lines = (await get(t.app, `/api/comfy/logs?machine=${id}`)).json().lines as Array<{ m: string }>;
    expect(lines.map((l) => l.m)).toContain("ERROR: the step stopped");
  });

  it("never terminates a pod the user added for what a boot log says: only one deployed from here", async () => {
    runpod.bootFails = "putting in the node packs";
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    // as a pod added: not deployed by Afflatus
    await updateSettings(t.db, (s) => ({ machines: s.machines.map((m) => (m.id === id && m.rented ? { ...m, rented: { ...m.rented, deployed: false, deployedAt: "" } } : m)) }));
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    await until(async () => (await rowOf(id), Boolean(t.services.rented.boots.get(id)?.failed)));
    await rowOf(id);
    expect(pod.status).toBe("RUNNING");
  });

  it("RunPod's ComfyUI image: RunPod's data only, its boot log never asked", async () => {
    runpod.comfyStaysDown = true;
    const id = (await post(t.app, "/api/runpod/deploy", { ...ASK, template: "runpod" })).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    const row = await rowOf(id);
    expect(row).toMatchObject({ boot: { phase: "starting", step: null, failed: false }, error: null });
    expect((await get(t.app, `/api/comfy/logs?machine=${id}`)).json()).toEqual({ lines: [], source: "boot" });
    expect(pod.comfy.calls).not.toContain("GET /afflatus/boot");
  });
});
