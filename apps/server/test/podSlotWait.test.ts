import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { h3 } from "@afflatus/recipes";
import { readSettings } from "../src/settings";
import type { PodFetch } from "../src/queuePlan";
import { makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A render pinned to a pod whose family file (H3's text encoder) the pod's own files say is coming, or there whole, while
 * the pod's folders do not list it at its submit (card #221). On 2026-11-02 a clip pinned to an RTX PRO 4500 started 1 s
 * after the text encoder landed there and failed "a model file MiniMax H3 needs was not found", the three clips after it
 * failing with it: the job waits, or reads the folders again, and is refused only when the pod cannot get the file.
 */

const KEY = "rpa_test_key_0123456789";
const DASIWA = "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors";
const get_ = (id: string) => h3.slots.find((s) => s.id === id)!.get!;
const TE = get_("clip").file;
const RIFE = get_("rife").file;
let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    // a pod with H3's files, its text encoder among them: what its folders list is the test's to say
    spawn: async () => (pod = await startFakeComfy({ catalog: referenceCatalog(), models: { diffusion_models: [DASIWA], text_encoders: [TE], vae: [get_("videoVae").file, get_("audioVae").file], frame_interpolation: [RIFE], checkpoints: [], loras: [] } })),
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, pod].map((x) => x?.close().catch(() => {})));
});

async function deployed(): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
  expect(res.statusCode).toBe(200);
  const id = res.json().id as string;
  await until(() => runpod.pods[0]?.status === "RUNNING");
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  return id;
}

/** The pod's files as the queue reads them: each file's state the test's to say, what was asked for kept. */
function pretendFetch(states: Map<string, { state: "next" | "fetching" | "ready" | "failed"; error?: string }>, o: { planWaits?: boolean } = {}) {
  const asked: Array<{ file: string; tier: "need" | "ahead"; job: string }> = [];
  const fetch: PodFetch = {
    fileState: (_machine, f) => states.get(f.file) ?? null,
    failed: () => null, short: async () => null, untilThere: async () => 1_000, drop: () => {}, holding: () => false, moving: () => false, stalled: () => null, failingPacks: () => new Map(), restartsFor: () => null,
    want: (_machine, files, tier, job) => {
      for (const f of files) asked.push({ file: f.file, tier, job });
    },
    holdsFor: (_machine, job) => asked.some((a) => a.job === job),
    // the plan's word on the job's files: by their states, or "ready" whatever they are (`planWaits` false: a plan that let it go)
    jobState: (_machine, _job, only) => (o.planWaits === false || (only ?? []).every((f) => states.get(f.file)?.state === "ready") ? "ready" : "waiting"),
  };
  return { fetch, asked };
}

const job = (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const pinned = async (machine: string, smooth = false) => (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "a red ball rolls", seconds: 5, model: DASIWA, smooth }, machine })).json().ids[0] as string;
/** The pod's ComfyUI as Afflatus asks it. */
const podComfy = async (id: string) => (await t.services.machines()).find((m) => m.machine.id === id)!.comfy;
/** Its folders read anew at a submit of job `a` (`when`), not taken from the plan's scan. */
function atSubmit(comfy: Awaited<ReturnType<typeof podComfy>>, a: () => string, when: () => boolean): void {
  const scan = comfy.scan.bind(comfy);
  comfy.scan = async (...args) => {
    if (a() !== "" && when() && (await job(a())).status === "running") comfy.forgetFiles();
    return scan(...args);
  };
}

describe("a render pinned to a pod, a family file its graph reads not listed at its submit", () => {
  it("there whole by the pod's word, its folder's listing failing once: read again, and the job runs (it was failed for it)", async () => {
    const id = await deployed();
    const { fetch } = pretendFetch(new Map([[TE, { state: "ready" }]]));
    t.services.queue.podFetch = fetch;
    // the pod's text encoders cannot be listed until the job has started, then once more: as a listing that failed reads, empty
    const comfy = await podComfy(id);
    const real = comfy.client.models.bind(comfy.client);
    let a = "";
    let afterStart = 0;
    comfy.client.models = async (folder) => {
      if (folder === "text_encoders") {
        const running = a !== "" && (await job(a)).status === "running";
        if (!running || afterStart++ < 1) throw new Error("fetch failed");
      }
      return real(folder);
    };
    a = await pinned(id);
    await until(() => pod.prompts.size === 1, 15_000);
    const row = await job(a);
    expect(row.status).toBe("running");
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("there whole by the pod's word and never listed: back in line each time, failed only once its attempts are spent, saying so", async () => {
    const id = await deployed();
    const { fetch } = pretendFetch(new Map([[TE, { state: "ready" }]]));
    t.services.queue.podFetch = fetch;
    pod.models.text_encoders = [];
    const a = await pinned(id);
    await until(async () => (await job(a)).status === "failed", 15_000);
    const row = await job(a);
    expect(row.attempts).toBe(3);
    expect(row.error).toContain("a model file MiniMax H3 needs was not found");
    expect(row.error).toContain(`${TE} came to its pod, and its ComfyUI did not list it`);
    expect(pod.prompts.size).toBe(0);
  });

  it("still coming to the pod (a plan that let it go): asked for first, the job back in line with no attempt spent, run once it is there", async () => {
    const id = await deployed();
    const states = new Map([[TE, { state: "fetching" as const }]]);
    const { fetch, asked } = pretendFetch(states, { planWaits: false });
    t.services.queue.podFetch = fetch;
    pod.models.text_encoders = [];
    const a = await pinned(id);
    // the clip that carries on from it, behind it on the same pod: it waits with it (it failed as "the clip it continues was not rendered")
    const b = await t.services.queue.enqueue("h3.video", { description: "the ball rolls on", seconds: 5, model: DASIWA, smooth: false }, { dependsOn: a, machine: id });
    await until(() => asked.some((x) => x.file === TE && x.tier === "need" && x.job === a), 15_000);
    await until(async () => (await job(a)).status === "queued");
    const waiting = await job(a);
    expect(waiting.attempts).toBe(0);
    expect(waiting.error).toBeNull();
    expect(await job(b)).toMatchObject({ status: "queued", error: null });
    // it lands: in the pod's folder, and there by the pod's word
    pod.models.text_encoders = [TE];
    states.set(TE, { state: "ready" } as never);
    (await podComfy(id)).forgetFiles();
    await until(() => pod.prompts.size === 1, 15_000);
    expect((await job(a)).status).toBe("running");
  });

  it("RIFE with RIFE ×2 on, there whole by the pod's word, its folder's listing failing once: read again, and the render interpolates (it ran at 24 fps)", async () => {
    const id = await deployed();
    const { fetch } = pretendFetch(new Map([[RIFE, { state: "ready" }]]));
    t.services.queue.podFetch = fetch;
    const comfy = await podComfy(id);
    const real = comfy.client.models.bind(comfy.client);
    let a = "";
    let afterStart = 0;
    comfy.client.models = async (folder) => {
      if (folder === "frame_interpolation") {
        const running = a !== "" && (await job(a)).status === "running";
        if (!running || afterStart++ < 1) throw new Error("fetch failed");
      }
      return real(folder);
    };
    a = await pinned(id, true);
    await until(() => pod.prompts.size === 1, 15_000);
    const graph = [...pod.prompts.values()][0] as unknown as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(Object.values(graph).find((n) => n.class_type === "FrameInterpolationModelLoader")?.inputs.model_name).toBe(RIFE);
  });

  it("RIFE there whole by the pod's word and never listed: the render goes without it after a few reads, as before, never held", async () => {
    const id = await deployed();
    const { fetch } = pretendFetch(new Map([[RIFE, { state: "ready" }]]));
    t.services.queue.podFetch = fetch;
    pod.models.frame_interpolation = [];
    const a = await pinned(id, true);
    await until(() => pod.prompts.size === 1, 15_000);
    const graph = [...pod.prompts.values()][0] as unknown as Record<string, { class_type: string }>;
    expect(Object.values(graph).some((n) => n.class_type === "FrameInterpolationModelLoader")).toBe(false);
    expect((await job(a)).attempts).toBe(1);
  });

  // card #235: a file a network volume held from an earlier session is no entry of the pod's files (its state unknown). A
  // listing blip at the submit asked for it as missing: 16 GB fetched again, Make room deleting for it, or failed for good
  it("never asked for there and on its volume, its folder's listing failing at the submit: read again, never asked for, and the job runs", async () => {
    const id = await deployed();
    const { fetch, asked } = pretendFetch(new Map());
    t.services.queue.podFetch = fetch;
    const comfy = await podComfy(id);
    const real = comfy.client.models.bind(comfy.client);
    let a = "";
    let failing = 1;
    // the submit's scan read anew (not the plan's, kept), its text encoders' listing failing once
    atSubmit(comfy, () => a, () => failing > 0);
    comfy.client.models = async (folder) => {
      if (folder === "text_encoders" && a !== "" && (await job(a)).status === "running" && failing-- > 0) throw new Error("fetch failed");
      return real(folder);
    };
    a = await pinned(id);
    await until(() => pod.prompts.size === 1, 15_000);
    expect(failing).toBeLessThan(1);
    expect(asked.filter((x) => x.file === TE)).toEqual([]);
    expect(await job(a)).toMatchObject({ status: "running", error: null, attempts: 1 });
  });

  it("never asked for there, its folder not answering at any submit: never asked for, back in line, failed once its attempts are spent, saying so", async () => {
    const id = await deployed();
    const { fetch, asked } = pretendFetch(new Map());
    t.services.queue.podFetch = fetch;
    const comfy = await podComfy(id);
    const real = comfy.client.models.bind(comfy.client);
    let a = "";
    atSubmit(comfy, () => a, () => true);
    comfy.client.models = async (folder) => {
      if (folder === "text_encoders" && a !== "" && (await job(a)).status === "running") throw new Error("fetch failed");
      return real(folder);
    };
    a = await pinned(id);
    await until(async () => (await job(a)).status === "failed", 20_000);
    const row = await job(a);
    expect(row.attempts).toBe(3);
    expect(row.error).toContain("a model file MiniMax H3 needs was not found");
    expect(row.error).toContain("its pod's ComfyUI did not list its text_encoders folder");
    expect(asked.filter((x) => x.file === TE)).toEqual([]);
    expect(pod.prompts.size).toBe(0);
  });

  it("that failed on the pod: refused, with why", async () => {
    const id = await deployed();
    const { fetch } = pretendFetch(new Map([[TE, { state: "failed", error: "Hugging Face answered 404" }]]), { planWaits: false });
    t.services.queue.podFetch = fetch;
    pod.models.text_encoders = [];
    const a = await pinned(id);
    await until(async () => (await job(a)).status === "failed", 15_000);
    const row = await job(a);
    expect(row.error).toContain("a model file MiniMax H3 needs was not found");
    expect(row.error).toContain("It could not be had on its pod: Hugging Face answered 404.");
    expect(row.attempts).toBe(1);
  });
});
