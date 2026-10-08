import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  // no VideoHelperSuite: the clip is written by ComfyUI's own SaveVideo, into its output folder
  const catalog = referenceCatalog();
  delete catalog.VHS_VideoCombine;
  fake = await startFakeComfy({
    catalog,
    models: {
      checkpoints: [], loras: ["minimax_h3_turbo.safetensors"], diffusion_models: ["minimax_h3_fl2va.safetensors"], text_encoders: ["qwen3vl_32b_minimax_h3.safetensors"],
      vae: ["minimax_h3_video_vae.safetensors", "minimax_h3_audio_vae.safetensors"],
    },
  });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

describe("the videos ComfyUI's SaveVideo leaves in its output folder", () => {
  it("are asked to be cleaned when a job writes one there, at most once an hour", async () => {
    for (const n of [1, 2]) {
      const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: `She waves, ${n}.` } })).json().ids[0] as string;
      await until(() => fake.prompts.size === n);
      const graph = [...fake.prompts.values()][n - 1]!;
      expect(Object.values(graph).some((node) => node.class_type === "SaveVideo")).toBe(true);
      // stopped: the next one is sent
      await t.services.queue.cancel(id);
      await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "cancelled");
    }
    await until(() => fake.cleaned.length === 1);
    expect(fake.cleaned).toEqual([{ folder: "output", older_than_hours: 24 }]);
  });
});
