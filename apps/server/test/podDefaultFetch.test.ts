import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import type { NodeCatalog } from "@afflatus/core";
import { readSettings } from "../src/settings";
import type { PodFetch } from "../src/queuePlan";
import type { QueueCore } from "../src/queueModel";
import { loadedOn } from "../src/jobFiles";
import { Comfy } from "../src/comfy";
import { CHECKPOINT, makeApp, makeFake, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A file choice left on its default that a family downloads (Upscale 2x's 4xNomos8kSC), on a rented pod that lists another
 * file for it (card #319). In the 2026-11-05 pod test, Klein's Upscale 2x left on Nomos ran RealESRGAN, there only because a
 * MOSS hires fix of the same series had fetched it: the pod fetches the default, the job waits for it and runs on it. A
 * machine of the user's own still takes the best one it has.
 */

const KEY = "rpa_test_key_0123456789";
const ESRGAN = "RealESRGAN_x4plus.pth";
/** The upscale model Upscale 2x starts on (recipes UPSCALER_DEFAULT), with a download of its own. */
const UPSCALER_DEFAULT = "4xNomos8kSC.safetensors";
let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

/** A node list whose upscale model loader offers these files, as a real ComfyUI's does. */
function offering(files: string[]): NodeCatalog {
  const catalog = referenceCatalog();
  catalog.UpscaleModelLoader!.input.required!.model_name = ["COMBO", { options: files }] as never;
  return catalog;
}

beforeEach(async () => {
  home = await makeFake();
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => (pod = await startFakeComfy({ catalog: offering([ESRGAN]), models: { checkpoints: [CHECKPOINT], upscale_models: [ESRGAN], loras: [] } })),
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
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

async function picture(): Promise<string> {
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 90, g: 120, b: 150 } } }).png().toBuffer();
  return ((await t.app.inject({ method: "POST", url: "/api/assets", headers: { "content-type": "image/png" }, payload: bytes })).json() as { id: string }).id;
}

const core = () => (t.services.queue as unknown as { core: QueueCore }).core;
const row = (recipe: string, inputs: Record<string, unknown>) => ({ id: `zz-test-${Math.random()}`, recipe_id: recipe, inputs: JSON.stringify(inputs), finished_from: null as string | null, clip_id: null, clip_fit: 0, clip_mirror: null });
const upscalerOf = (files: Array<{ classType: string; file: string }> | undefined) => files?.filter((f) => f.classType === "UpscaleModelLoader").map((f) => f.file);

describe("a file choice left on a default a family downloads, on a pod that lists another (card #319)", () => {
  it("is fetched there for Upscale 2x (SDXL and Klein), never settled on the pod's other file; this PC's own ComfyUI takes the best it has", async () => {
    const other = await startFakeComfy({ catalog: offering([ESRGAN]), models: { checkpoints: [CHECKPOINT], upscale_models: [ESRGAN] } });
    try {
      const comfy = new Comfy(other.url, t.services.registry);
      const scan = await comfy.scan();
      const source = await picture();
      for (const r of [row("sdxl.sharper", { source, checkpoint: CHECKPOINT }), row("klein.sharper", { source })]) {
        // a rented pod: the default, there to fetch, its fetch with the family's address
        const onPod = await loadedOn(core(), r, { id: "pod", comfy, scan });
        expect(upscalerOf(onPod?.files)).toEqual([UPSCALER_DEFAULT]);
        expect(onPod?.absent.map((f) => f.file)).toContain(UPSCALER_DEFAULT);
        // a pod to come, built on this PC's node list
        expect(upscalerOf((await loadedOn(core(), r, null))?.files)).toEqual([UPSCALER_DEFAULT]);
        // a machine of the user's own: the file it has, as before
        expect(upscalerOf((await loadedOn(core(), r, { id: "own", comfy, scan, own: true }))?.files)).toEqual([ESRGAN]);
        // a pick of the pod's file is kept as picked
        const picked = { ...r, inputs: JSON.stringify({ ...JSON.parse(r.inputs), upscaler: ESRGAN }) };
        expect(upscalerOf((await loadedOn(core(), picked, { id: "pod", comfy, scan }))?.files)).toEqual([ESRGAN]);
      }
      // the graph a pod builds, and the price's build: the default
      const sharper = await t.services.queue.builtOf("klein.sharper", { source, refine: false }, { comfy, catalog: await comfy.catalog(), pod: true });
      expect(Object.values(sharper!.graph).find((n) => n.class_type === "UpscaleModelLoader")?.inputs.model_name).toBe(UPSCALER_DEFAULT);
      const own = await t.services.queue.builtOf("klein.sharper", { source, refine: false }, { comfy, catalog: await comfy.catalog() });
      expect(Object.values(own!.graph).find((n) => n.class_type === "UpscaleModelLoader")?.inputs.model_name).toBe(ESRGAN);
    } finally {
      await other.close();
    }
  });

  it("at its submit on the pod: waits with no attempt spent while it comes, then runs on it", async () => {
    await t.services.queue.start();
    const id = await deployed();
    const states = new Map<string, { state: "next" | "fetching" | "ready" | "failed"; error?: string }>([[UPSCALER_DEFAULT, { state: "fetching" }]]);
    const asked: Array<{ file: string; job: string }> = [];
    const fetch: PodFetch = {
      fileState: (_machine, f) => states.get(f.file) ?? null,
      failed: () => null, short: async () => null, untilThere: async () => 1_000, drop: () => {}, holding: () => false, moving: () => false, stalled: () => null, failingPacks: () => new Map(), restartsFor: () => null, lost: async () => 0,
      want: (_machine, files, _tier, job) => {
        for (const f of files) asked.push({ file: f.file, job });
      },
      holdsFor: (_machine, job) => asked.some((a) => a.job === job),
      // a plan that let the job go, so that its submit is what waits
      jobState: () => "ready",
    };
    t.services.queue.deps.pods.podFetch = fetch;
    const source = await picture();
    const a = (await post(t.app, "/api/jobs", { recipe: "sdxl.sharper", input: { source, checkpoint: CHECKPOINT, refine: false }, machine: id })).json().ids[0] as string;
    const job = () => t.db.selectFrom("jobs").selectAll().where("id", "=", a).executeTakeFirstOrThrow();
    await until(async () => asked.some((x) => x.file === UPSCALER_DEFAULT && x.job === a) || (await job()).status === "failed", 15_000);
    expect((await job()).error).toBeNull();
    await until(async () => (await job()).status === "queued");
    expect(await job()).toMatchObject({ attempts: 0, error: null });
    expect(pod.prompts.size).toBe(0);
    // it lands, and the pod's ComfyUI offers it
    pod.catalog = offering([ESRGAN, UPSCALER_DEFAULT]);
    pod.models.upscale_models = [ESRGAN, UPSCALER_DEFAULT];
    states.set(UPSCALER_DEFAULT, { state: "ready" });
    const comfy = (await t.services.machines()).find((m) => m.machine.id === id)!.comfy;
    comfy.forgetFiles();
    await until(() => pod.prompts.size === 1, 15_000);
    const graph = [...pod.prompts.values()][0]!;
    expect(Object.values(graph).find((n) => n.class_type === "UpscaleModelLoader")?.inputs.model_name).toBe(UPSCALER_DEFAULT);
  });
});

describe("a default its pod cannot get (card #319)", () => {
  it("is settled on the file the pod has after all, and the job says so: not sent with a file the pod lacks", async () => {
    await t.services.queue.start();
    const id = await deployed();
    const fetch: PodFetch = {
      fileState: (_machine, f) => (f.file === UPSCALER_DEFAULT ? { state: "failed", error: "its site answered 404" } : null),
      failed: () => null, short: async () => null, untilThere: async () => 1_000, drop: () => {}, holding: () => false, moving: () => false, stalled: () => null, failingPacks: () => new Map(), restartsFor: () => null, lost: async () => 0,
      want: () => {}, holdsFor: () => false, jobState: () => "ready",
    };
    t.services.queue.deps.pods.podFetch = fetch;
    const source = await picture();
    const a = (await post(t.app, "/api/jobs", { recipe: "sdxl.sharper", input: { source, checkpoint: CHECKPOINT, refine: false }, machine: id })).json().ids[0] as string;
    await until(() => pod.prompts.size === 1, 15_000);
    const graph = [...pod.prompts.values()][0]!;
    expect(Object.values(graph).find((n) => n.class_type === "UpscaleModelLoader")?.inputs.model_name).toBe(ESRGAN);
    const row = await t.db.selectFrom("jobs").selectAll().where("id", "=", a).executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).toContain(`${UPSCALER_DEFAULT} could not be had on its pod (its site answered 404), ${ESRGAN} was used.`);
  });
});
