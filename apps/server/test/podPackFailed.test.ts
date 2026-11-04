import { afterEach, describe, expect, it, vi } from "vitest";
import { nodesOfPack } from "@afflatus/core";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings } from "../src/settings";
import { CHECKPOINT, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A job a rented pod would run once a node pack it cannot run without came, whose install failed there (card #282: on
 * 2026-11-04 comfyui_ipadapter_plus failed on a pod, "ComfyUI-Manager did not start its installs (404)"). With no machine
 * left to run it, the job stayed queued while the pod idled, billed. It fails now, in the pack's words; one another machine
 * can take goes there.
 */

const KEY = "rpa_test_key_0123456789";
const GGUF = "minimax_h3_fl2va-Q5_K_M.gguf";
const FILES = {
  checkpoints: [CHECKPOINT],
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  unet_gguf: [GGUF],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors", "minimax_h3_audio_vae_fp32.safetensors", "minimax_h3_video_vae_int8_convrot.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  upscale_models: [],
};
// the GGUF loader is in its graph whatever else is asked (a .gguf model): a pack the job cannot run without
const ON_GGUF = { description: "a cat on a wall", seconds: 5, fast: false, cache: false, model: GGUF };
const NO_GGUF = nodesOfPack("ComfyUI-GGUF");

let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

async function setUp(homeHasPack: boolean) {
  const all = referenceCatalog();
  const without = Object.fromEntries(Object.entries(all).filter(([n]) => !NO_GGUF.includes(n)));
  // this PC: with the pack, or without it and without ComfyUI-Manager to install it
  home = await startFakeComfy({ catalog: homeHasPack ? all : without, models: FILES });
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      // the pod lacks the pack, and its proxy answers Manager's queue start with an empty 404 at every try (card #282)
      pod = await startFakeComfy({ catalog: without, models: { ...FILES, frame_interpolation: ["rife_v4.26.safetensors"] }, manager: true });
      pod.packVersion = "0.14.0";
      pod.startAnswers = [404, 404, 404, 404];
      return pod;
    },
  });
  vi.stubEnv("RUNPOD_API_URL", runpod.url);
  vi.stubEnv("RUNPOD_PROXY", "http://127.0.0.1:{id}");
  t = await makeApp({ comfyUrl: home.url });
  t.services.rented.everyMs = 60_000;
  t.services.rented.imageCheck = async () => true;
  t.services.podFiles.packStartRetryMs = 10;
  await t.app.inject({ method: "PUT", url: "/api/settings", payload: { runpodKey: KEY } });
  await t.services.queue.start();
  const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
  expect(res.statusCode).toBe(200);
  const id = res.json().id as string;
  await until(() => runpod.pods[0]?.status === "RUNNING");
  await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
  return { podId: id, homeId: (await readSettings(t.db)).machines[0]!.id };
}

const jobOf = (id: string) => t.db.selectFrom("jobs").select(["status", "error", "machine_id"]).where("id", "=", id).executeTakeFirstOrThrow();

afterEach(async () => {
  await t?.close();
  vi.unstubAllEnvs();
  await Promise.all([home, runpod, pod].map((x) => x?.close().catch(() => {})));
});

describe("a job whose node pack failed on the pod that would run it", () => {
  it("fails in the pack's words when no other machine can run it, never left waiting while the pod bills", async () => {
    await setUp(false);
    const job = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: ON_GGUF })).json().ids[0] as string;
    await until(async () => (t.services.queue.nudge(), (await jobOf(job)).status === "failed"), 20_000);
    const row = await jobOf(job);
    expect(row.error).toContain("the node pack ComfyUI-GGUF: ComfyUI-Manager did not start its installs (404)");
    expect(row.error).toContain("no other machine can run it");
    expect(pod.prompts.size).toBe(0);
    expect(home.prompts.size).toBe(0);
  }, 60_000);

  it("goes to another machine that can run it", async () => {
    const { podId, homeId } = await setUp(true);
    // this PC paused while the pod is asked for the pack: the job is the pod's, whose install fails
    await post(t.app, "/api/queue/pause", { machine: homeId });
    const job = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: ON_GGUF })).json().ids[0] as string;
    await until(() => (t.services.queue.nudge(), t.services.podFiles.failingPacks(podId).has("ComfyUI-GGUF")), 20_000);
    // paused, this PC may still run it: the job waits for it, not failed
    for (let i = 0; i < 3; i++) {
      t.services.queue.nudge();
      await new Promise((r) => setTimeout(r, 200));
    }
    expect((await jobOf(job)).status).toBe("queued");
    await post(t.app, "/api/queue/resume", { machine: homeId });
    await until(() => home.prompts.size === 1, 20_000);
    expect((await jobOf(job)).status).not.toBe("failed");
    expect(pod.prompts.size).toBe(0);
  }, 60_000);
});
