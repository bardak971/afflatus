import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_LAYERS, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { bootOf, BootLogs, bootPacks, bootStep, parseBootLog } from "../src/podBoot";
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

  it("its node packs' time: from their step to the step after their installs, each install up to the next step", () => {
    const at = (s: number) => new Date(Date.parse("2026-10-16T10:00:00.000Z") + s * 1000).toISOString();
    const steps = [
      line("[afflatus-pod] step: checking the GPU", at(0)),
      line("[afflatus-pod] step: putting in the node packs", at(10)),
      line("[afflatus-pod] step: installing the Python packages of ComfyUI-KJNodes", at(12)),
      line("Collecting kornia", at(20)),
      line("[afflatus-pod] step: installing the Python packages of was-node-suite", at(72)),
      line("[afflatus-pod] step: setting up ComfyUI-Manager", at(102)),
      line("[afflatus-pod] step: starting ComfyUI", at(104)),
    ];
    expect(bootPacks(steps.slice(0, 1))).toBeNull();
    // under way: its start known, its end not yet, the installs done so far
    expect(bootPacks(steps.slice(0, 5))).toEqual({ from: at(10), to: null, installs: [{ pack: "ComfyUI-KJNodes", ms: 60_000 }] });
    expect(bootPacks(steps)).toEqual({ from: at(10), to: at(102), installs: [{ pack: "ComfyUI-KJNodes", ms: 60_000 }, { pack: "was-node-suite", ms: 30_000 }] });
    // a container started again begins a new course
    expect(bootPacks([...steps, line("[afflatus-pod] step: checking the GPU", at(200))])).toBeNull();
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
    // its boot kept in parts on its session, for Queue › Costs: its container up after its pull, its node packs' step and
    // the pack whose Python packages were installed, before its ComfyUI's first answer
    const kept = await t.db.selectFrom("rent_sessions").selectAll().executeTakeFirstOrThrow();
    const [from, pulled, packsFrom, packsTo, up] = [kept.started_at, kept.pulled_at!, kept.packs_from!, kept.packs_to!, kept.up_at!].map(Date.parse);
    expect(from).toBeLessThan(pulled!);
    expect(pulled).toBeLessThanOrEqual(packsFrom!);
    expect(packsFrom).toBeLessThan(packsTo!);
    expect(packsTo).toBeLessThanOrEqual(up!);
    // the pretend pod installs two packs' Python packages, each step with its count ("(1/2)"), which the name leaves out
    expect(JSON.parse(kept.boot_packs!).map((p: { pack: string }) => p.pack)).toEqual(["ComfyUI-KJNodes", "ComfyUI-VideoHelperSuite"]);
    expect(kept.start_failed).toBeNull();
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
    // in the words its phase line said (stepSaid, shared with the screens), not the pod's own
    expect(row.error).toMatch(/^Terminated: start failed at linking node packs \(exit 1\), as its boot log says/);
    expect(told.map((x) => x.body).join("\n")).toMatch(/its start failed: linking node packs \(exit 1\)/);
    expect(runpod.secrets).toEqual({});
    // its last lines kept, after its pod is gone
    const lines = (await get(t.app, `/api/comfy/logs?machine=${id}`)).json().lines as Array<{ m: string }>;
    expect(lines.map((l) => l.m)).toContain("ERROR: the step stopped");
    // its session says its start failed there: Queue › Costs counts its boot as a failed start
    const kept = await t.db.selectFrom("rent_sessions").selectAll().executeTakeFirstOrThrow();
    expect(kept).toMatchObject({ start_failed: "putting in the node packs (exit 1)", up_at: null, packs_to: null });
    expect(kept.pulled_at).not.toBeNull();
  });

  it("says its pull's progress from RunPod's log, and keeps its build, host, data center and pull with its run", async () => {
    t.services.rented.pullEveryMs = 0;
    t.services.rented.imageLayersOf = async () => FAKE_LAYERS;
    runpod.pullMs = 1500;
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    // mid-pull: its bytes against the image's, its stage; the deploy's build on its card, its host's CUDA as RunPod says it
    await until(async () => ((await rowOf(id)).boot?.pull?.done ?? 0) > 0);
    const pulling = await rowOf(id);
    expect(pulling.boot).toMatchObject({ phase: "pulling", pull: { stage: "downloading", bytes: 144e6 } });
    expect(pulling).toMatchObject({ cuda: "13.0", hostCuda: "13.2" });
    await until(async () => (await rowOf(id)).booting === false);
    const kept = await t.db.selectFrom("rent_sessions").selectAll().executeTakeFirstOrThrow();
    expect(kept).toMatchObject({ image: expect.stringMatching(/\/afflatus-pod:[\d.]+$/), host_cuda: "13.2", data_center: expect.any(String), boot_log: null });
    expect(JSON.parse(kept.pull!)).toMatchObject({ fresh: true, bytes: 144e6 });
    // the Costs tab says it with its run
    const costs = (await get(t.app, "/api/costs")).json() as { sessions: Array<{ cuda: string; hostCuda: string; pull: { fresh: boolean } | null; bootLog: boolean }> };
    expect(costs.sessions[0]).toMatchObject({ cuda: "13.0", hostCuda: "13.2", pull: { fresh: true }, bootLog: false });
  });

  it("keeps a run's boot log only while boot logs are kept, served as text, and drops it after its days", async () => {
    t.services.rented.pullEveryMs = 0;
    t.services.rented.imageLayersOf = async () => FAKE_LAYERS;
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { bootLogDays: 7 } });
    const id = (await post(t.app, "/api/runpod/deploy", ASK)).json().id as string;
    await until(async () => (await rowOf(id)).booting === false);
    const row = await t.db.selectFrom("rent_sessions").selectAll().executeTakeFirstOrThrow();
    const log = JSON.parse(row.boot_log!) as { system: Array<{ line: string }>; pod: Array<{ m: string }> };
    expect(log.system.some((l) => /^Status: Downloaded newer image/.test(l.line))).toBe(true);
    expect(log.pod[0]!.m).toBe("[afflatus-pod] step: checking the GPU");
    const text = await get(t.app, `/api/rented/sessions/${row.id}/boot-log`);
    expect(text.headers["content-type"]).toMatch(/^text\/plain/);
    expect(text.body).toMatch(/RunPod's system log[\s\S]*Pull complete[\s\S]*The pod's boot log:[\s\S]*checking the GPU/);
    // older than its days: dropped at the next prune; while within them, kept
    await t.db.updateTable("rent_sessions").set({ started_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }).execute();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { bootLogDays: 30 } });
    await t.services.rented.poll();
    expect((await t.db.selectFrom("rent_sessions").select("boot_log").executeTakeFirstOrThrow()).boot_log).not.toBeNull();
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { bootLogDays: 7 } });
    await t.services.rented.poll();
    expect((await t.db.selectFrom("rent_sessions").select("boot_log").executeTakeFirstOrThrow()).boot_log).toBeNull();
    expect((await get(t.app, `/api/rented/sessions/${row.id}/boot-log`)).statusCode).toBe(404);
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

  it("RunPod's ComfyUI image: pulling, starting, then up, from RunPod's GraphQL (its REST list says no uptime); its boot log never asked", async () => {
    const id = (await post(t.app, "/api/runpod/deploy", { ...ASK, template: "runpod" })).json().id as string;
    const pod = runpod.pods[0]!;
    await until(() => pod.status === "RUNNING");
    expect(await rowOf(id)).toMatchObject({ booting: true, boot: { phase: "pulling", step: null, failed: false }, error: null });
    // as the real API: no uptime in the REST list, only in the GraphQL
    const listed = (await (await fetch(`${runpod.url}/v2/pods`, { headers: { Authorization: `Bearer ${KEY}` } })).json()) as { pods: Array<{ runtime?: unknown }> };
    expect(listed.pods[0]!.runtime).toBeUndefined();
    await until(async () => (await rowOf(id)).boot?.phase === "starting");
    expect(runpod.calls).toContain("POST /graphql");
    expect((await get(t.app, `/api/comfy/logs?machine=${id}`)).json()).toEqual({ lines: [], source: "boot" });
    await until(async () => (await rowOf(id)).booting === false);
    expect(pod.comfy.calls).not.toContain("GET /afflatus/boot");
    // its container's start kept on its session: its pull, then its ComfyUI starting, before its first answer
    const kept = await t.db.selectFrom("rent_sessions").selectAll().executeTakeFirstOrThrow();
    expect(Date.parse(kept.pulled_at!)).toBeGreaterThan(Date.parse(kept.started_at));
    expect(Date.parse(kept.pulled_at!)).toBeLessThanOrEqual(Date.parse(kept.up_at!));
    // known once: RunPod's GraphQL is not asked of it again for its uptime at every read
    const asked = runpod.calls.filter((c) => c === "POST /graphql").length;
    await rowOf(id);
    await rowOf(id);
    expect(runpod.calls.filter((c) => c === "POST /graphql").length - asked).toBeLessThanOrEqual(1);
  });
});
