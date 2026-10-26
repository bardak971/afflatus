import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import type { Graph, NodeCatalog } from "@afflatus/core";
import type { PodFetch } from "../src/queuePlan";
import { readSettings } from "../src/settings";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { CHECKPOINT, complete, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";
import { nodes } from "./timelineKit";

/**
 * A Wan clip that carries on through SVI 2.0 Pro, queued on a pod behind other jobs while the clip before it waits its turn
 * (card #107): its SVI LoRAs are sent to the pod while the jobs before it render, and it is never released there before
 * its graph's files are ones the pod's ComfyUI offers. On #105's re-check pod they were never asked for, and the clip went
 * to the pod 13 s after the clip before ended, refused at its submit: "ComfyUI has no file SVI_v2_PRO…".
 */

const KEY = "rpa_test_key_0123456789";
const SVI = ["SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors", "SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors"];
/** The Wan files the pod had once its first jobs' files were in: the models, Turbo's LoRAs, not SVI's. */
const WAN = {
  diffusion_models: [
    "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors",
    "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
  ],
  text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vae: ["wan_2.1_vae.safetensors"],
  loras: [
    "wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors", "wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors",
    "wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors", "wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  ],
  frame_interpolation: ["rife_v4.26.safetensors"],
  checkpoints: [CHECKPOINT, "other.safetensors"],
  upscale_models: [],
};

let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;
let clip: Uint8Array;

/**
 * The pod's node list, its loaders offering the files its folders hold as a real ComfyUI's do (the reference list offers
 * none, and the submit's check of a graph's files against it then says nothing).
 */
function offering(models: Record<string, string[]>): NodeCatalog {
  const catalog = referenceCatalog();
  const offer = (node: string, input: string, files: string[]) => {
    (catalog[node]!.input.required![input] as unknown[])[0] = [...files];
  };
  offer("LoraLoaderModelOnly", "lora_name", models.loras ?? []);
  offer("UNETLoader", "unet_name", models.diffusion_models ?? []);
  offer("CLIPLoader", "clip_name", models.text_encoders ?? []);
  offer("VAELoader", "vae_name", models.vae ?? []);
  return catalog;
}

/**
 * podFiles.ts as the queue reads it, its files coming only when the test says (land): what was asked for, by job and tier.
 * A real pod's fetch would go to Hugging Face for SVI's LoRAs.
 */
function pretendFetch() {
  const asked: Array<{ file: string; tier: "need" | "ahead"; job: string }> = [];
  const there = new Set<string>();
  const fetch: PodFetch = {
    failed: () => null, short: async () => null, untilThere: async () => 1_000, drop: () => {}, holding: () => false, moving: () => false, failingPacks: () => new Map(),
    want: (_machine, files, tier, job) => {
      for (const f of files) asked.push({ file: f.file, tier, job });
    },
    holdsFor: (_machine, job) => asked.some((a) => a.job === job),
    jobState: (_machine, job, only) => (only?.length && only.every((f) => there.has(f.file)) ? "ready" : asked.some((a) => a.job === job) ? "waiting" : null),
  };
  return { fetch, asked, there };
}

beforeAll(async () => {
  if (ffmpegThere) clip = await patternClip(2, { sound: false });
}, FFMPEG_TIMEOUT);

beforeEach(async () => {
  // this PC has every file, SVI's too: a pod's missing ones are named by their downloads
  home = await startFakeComfy({ catalog: referenceCatalog(), models: { ...WAN, loras: [...WAN.loras, ...SVI] } });
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      pod = await startFakeComfy({ catalog: offering(WAN), models: structuredClone(WAN) });
      pod.packVersion = "0.14.0";
      return pod;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY, downloadModels: true, civitaiLookups: true } });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, pod].map((x) => x?.close().catch(() => {})));
});

/** A pod deployed and up, as a machine of Afflatus, this PC paused: every job of the series pinned to the pod. */
async function deployed(): Promise<string> {
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
  expect(res.statusCode).toBe(200);
  const id = res.json().id as string;
  await until(() => runpod.pods[0]?.status === "RUNNING");
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  await post(t.app, "/api/queue/pause", { machine: (await readSettings(t.db)).machines[0]!.id });
  return id;
}

const call = async (method: "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

/**
 * #105's series in small: a job ahead of it on the pod (an SDXL picture), then a timeline's two Wan Turbo clips, the second
 * carrying on from the first, all queued at once and pinned to the pod.
 */
async function series(id: string) {
  const ahead = (await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "a cat", checkpoint: CHECKPOINT }, machine: id })).json().ids[0] as string;
  const tl = await call("POST", "/api/timelines", { name: "zz-test wan chain on a pod" });
  const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "wan.video" })).clip as string;
  const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
  const input = { prompt: "A red kite turns over a hill.", fast: true };
  await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: a, input }, { id: b, input }], machine: id });
  const jobOf = async (c: string) => (await t.db.selectFrom("jobs").select("id").where("clip_id", "=", c).executeTakeFirstOrThrow()).id;
  return { ahead, first: await jobOf(a), second: await jobOf(b) };
}

/** The pod's latest prompt finished with a short video (a clip's render). */
function finishClip(promptId: string) {
  const graph = pod.prompts.get(promptId)!;
  const out = Object.entries(graph).find(([, n]) => /VideoCombine/.test(n.class_type))![0];
  pod.files[`${promptId}.mp4`] = clip;
  pod.pending = pod.pending.filter((p) => p !== promptId);
  pod.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
}

const status = async (job: string) => (await t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", job).executeTakeFirstOrThrow());
const promptOf = (n: number) => [...pod.prompts.entries()][n - 1]!;

describe.skipIf(!ffmpegThere)("a Wan clip carrying on through SVI, queued on a pod behind other jobs (card #107)", { timeout: FFMPEG_TIMEOUT }, () => {
  it("has SVI's LoRAs sent to the pod while the jobs before it render, and goes there only once they are in", async () => {
    const id = await deployed();
    const files = pretendFetch();
    t.services.queue.podFetch = files.fetch;
    const { ahead, first, second } = await series(id);
    // the job ahead renders on the pod; the clip after waits for the first clip, and its LoRAs are asked for meanwhile
    await until(() => pod.prompts.size === 1, 15_000);
    await until(() => SVI.every((f) => files.asked.some((a) => a.file === f && a.job === second)), 15_000);
    expect(files.asked.filter((a) => SVI.includes(a.file)).every((a) => a.job === second)).toBe(true);
    complete(pod, promptOf(1)[0]);
    await until(async () => (await status(ahead)).status === "done");
    // the first clip renders, then ends: the second, its LoRAs not in yet, stays off the pod, asked for as needed now
    await until(() => pod.prompts.size === 2, 15_000);
    finishClip(promptOf(2)[0]);
    await until(async () => (await status(first)).status === "done", 20_000);
    await until(() => SVI.every((f) => files.asked.some((a) => a.file === f && a.job === second && a.tier === "need")), 15_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(pod.prompts.size).toBe(2);
    expect((await status(second)).status).toBe("queued");
    // they land: listed in its folder, offered by its loader, the pod's files read again as podFiles does once one is in
    pod.models.loras = [...pod.models.loras!, ...SVI];
    pod.catalog = offering(pod.models);
    for (const f of SVI) files.there.add(f);
    (await t.services.machines()).find((m) => m.machine.id === id)!.comfy.forgetFiles();
    t.services.queue.nudge();
    await until(() => pod.prompts.size === 3, 15_000);
    const graph = promptOf(3)[1] as Graph;
    expect(nodes(graph, "WanImageToVideoSVIPro")).toHaveLength(1);
    expect(nodes(graph, "LoraLoaderModelOnly").map((n) => n.inputs.lora_name)).toEqual(expect.arrayContaining(SVI));
    expect((await status(second)).status).toBe("running");
    finishClip(promptOf(3)[0]);
    await until(async () => (await status(second)).status === "done", 20_000);
  });

  it("is not released while the pod's folders list its LoRAs and its ComfyUI's node list does not offer them yet", async () => {
    const id = await deployed();
    const files = pretendFetch();
    t.services.queue.podFetch = files.fetch;
    // SVI's LoRAs in the pod's folder, not yet in the node list it was given (read before they came: it is kept ten minutes)
    pod.models.loras = [...pod.models.loras!, ...SVI];
    const comfy = (await t.services.machines()).find((m) => m.machine.id === id)!.comfy;
    comfy.catalogBehindMs = 0;
    const { ahead, first, second } = await series(id);
    await until(() => pod.prompts.size === 1, 15_000);
    complete(pod, promptOf(1)[0]);
    await until(async () => (await status(ahead)).status === "done");
    await until(() => pod.prompts.size === 2, 15_000);
    finishClip(promptOf(2)[0]);
    await until(async () => (await status(first)).status === "done", 20_000);
    // held for them, never sent to be refused at its submit ("ComfyUI has no file SVI_v2_PRO…")
    await until(() => SVI.every((f) => files.asked.some((a) => a.file === f && a.job === second && a.tier === "need")), 15_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(await status(second)).toEqual({ status: "queued", error: null });
    expect(pod.prompts.size).toBe(2);
    // its node list read again offers them: it goes, through SVI
    pod.catalog = offering(pod.models);
    for (const f of SVI) files.there.add(f);
    t.services.queue.nudge();
    await until(() => pod.prompts.size === 3, 15_000);
    expect(nodes(promptOf(3)[1] as Graph, "WanImageToVideoSVIPro")).toHaveLength(1);
    finishClip(promptOf(3)[0]);
    await until(async () => (await status(second)).status === "done", 20_000);
  });
});
