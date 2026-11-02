import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, startFakeRunpod, type FakeComfy, type FakeRunpod } from "@afflatus/comfy/testing";
import { readSettings } from "../src/settings";
import { CHECKPOINT, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A pod's ComfyUI restarting for a node pack its job asked for (podPacks.ts): unread for that minute, the pod was left out of
 * the plan, and the job given to another machine that could run it, the user's own PC among them (card #219's pod test,
 * where RunPod's proxy answered the restart with a 502). The job waits for the pod, and runs there once it is back.
 */

const KEY = "rpa_test_key_0123456789";
const FILES = {
  checkpoints: [CHECKPOINT],
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  upscale_models: [],
};
const DASIWA = ["DaSiWa_RTX_UpscalerRefiner", "MiniMaxH3Cache"];
const CACHED = { description: "a cat on a wall", seconds: 5, fast: false, cache: true };

let home: FakeComfy;
let pod: FakeComfy;
let runpod: FakeRunpod;
let t: TestApp;

beforeEach(async () => {
  const all = referenceCatalog();
  // this PC has H3 and DaSiWa's pack: it could render the job at once
  home = await startFakeComfy({ catalog: all, models: FILES });
  runpod = await startFakeRunpod({
    key: KEY, bootMs: 50, pods: [],
    spawn: async () => {
      // the pod has H3 but not the pack: its Manager installs it, and the restart loads it
      const catalog = Object.fromEntries(Object.entries(all).filter(([n]) => !DASIWA.includes(n)));
      pod = await startFakeComfy({ catalog, models: { ...FILES, frame_interpolation: ["rife_v4.26.safetensors"] }, manager: true, afterReboot: Object.fromEntries(DASIWA.map((n) => [n, all[n]!])) });
      pod.packVersion = "0.14.0";
      return pod;
    },
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

describe("a job whose node pack a pod restarts its ComfyUI for", () => {
  it("waits for the pod while it restarts, never given to this PC meanwhile, and runs on the pod once it is back", async () => {
    const res = await post(t.app, "/api/runpod/deploy", { gpu: "NVIDIA A40", cloud: "SECURE", template: "afflatus", volume: "", disk: 60, idleMinutes: 10, idleDo: "terminate", watchdogMinutes: 15 });
    expect(res.statusCode).toBe(200);
    const id = res.json().id as string;
    await until(() => runpod.pods[0]?.status === "RUNNING");
    await until(async () => (await t.services.rented.poll(), !(await readSettings(t.db)).machines.find((m) => m.id === id)?.rented?.deployedAt));
    const homeId = (await readSettings(t.db)).machines[0]!.id;
    // this PC paused: the job goes to the pod, which installs the pack and restarts for it
    await post(t.app, "/api/queue/pause", { machine: homeId });
    const job = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: CACHED })).json().ids[0] as string;
    await until(() => pod.reboots === 1, 15_000);
    // down for its restart, as RunPod's proxy says it (502); this PC free again meanwhile
    pod.down = true;
    await post(t.app, "/api/queue/resume", { machine: homeId });
    for (let i = 0; i < 5; i++) {
      t.services.queue.nudge();
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(home.prompts.size).toBe(0);
    // back, the pack loaded: this PC paused again, the job is the pod's (free, this PC could take it: it ends sooner there)
    await post(t.app, "/api/queue/pause", { machine: homeId });
    pod.down = false;
    await until(() => pod.prompts.size === 1, 20_000);
    // the pod's, built with the node its pack brought
    expect((await t.db.selectFrom("jobs").select("machine_id").where("id", "=", job).executeTakeFirstOrThrow()).machine_id).toBe(id);
    expect(Object.values([...pod.prompts.values()][0] as Record<string, { class_type: string }>).map((n) => n.class_type)).toContain("MiniMaxH3Cache");
    expect(home.prompts.size).toBe(0);
  }, 60_000);
});
