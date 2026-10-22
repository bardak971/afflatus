import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { CUT_JOB } from "../src/timelineModel";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, withTakes, makeApp, png, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Finish › Face refine on a SCAIL-2 take at 24 fps: SCAIL keeps no latent, so its take's own frames are refined in a cut job
 * (H3's pass, towards the clip's Picture, the take's sound held), and the result is the take's finished version.
 */

const FILES = {
  diffusion_models: ["wan2.1_14B_SCAIL_2_int8_convrot.safetensors", "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors"],
  loras: ["wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"],
  text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
  vae: ["wan_2.1_vae.safetensors", "minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
  clip_vision: ["clip_vision_h.safetensors"],
  checkpoints: ["sam3.1_multiplex_fp16.safetensors"],
  ultralytics: ["bbox/face_yolov8m.pt"],
  sams: ["sam_vit_b_01ec64.pth"],
};

let fake: FakeComfy;
let t: TestApp;
let four: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) four = await patternClip(4);
}, FFMPEG_TIMEOUT);
beforeEach(async () => {
  const catalog = referenceCatalog();
  // SAM 3 is a checkpoint: the reference catalog's checkpoints are an SDXL test's
  catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [FILES.checkpoints];
  fake = await startFakeComfy({ catalog, models: FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const call = async (method: "POST" | "PATCH", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

async function asset(kind: "video" | "image", bytes: Uint8Array): Promise<string> {
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}`;
  await t.services.storage.put(key, bytes);
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind, origin: "uploaded", name: `zz-test ${kind}`, file_key: key, thumb_key: null, mime: kind === "video" ? "video/mp4" : "image/png", bytes: bytes.length,
    width: 192, height: 320, duration_ms: kind === "video" ? 4000 : null, fps: kind === "video" ? 24 : null, has_sound: kind === "video" ? 1 : 0, folder_id: null, generation_id: null, kept_at: now(),
  })).execute();
  return id;
}

/** Let the pretend ComfyUI finish the latest prompt with this video. */
async function finish(bytes: Uint8Array, count: number) {
  await until(() => fake.prompts.size === count, 20_000);
  const [promptId, graph] = [...fake.prompts.entries()].at(-1)!;
  const out = Object.entries(graph).find(([, n]) => /VideoCombine|SaveVideo/.test(n.class_type))![0];
  fake.files[`${promptId}.mp4`] = bytes;
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0 || fake.prompts.size > count, 20_000);
  return graph;
}

describe.skipIf(!ffmpegThere)("Finish › Face refine on a SCAIL-2 take at 24 fps", { timeout: FFMPEG_TIMEOUT }, () => {
  it("refines the take's own frames towards its Picture, in a cut job, as its finished version", async () => {
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    const draft = withTakes((await get(t.app, `/api/timelines/${tl.id}`)).json()).clips[0].take;
    expect(draft).toBeTruthy();

    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, faceDenoise: 0.45, redo: true });
    expect(res.skipped).toEqual([]);
    expect(res.jobs).toHaveLength(1);
    const job = await t.db.selectFrom("jobs").selectAll().where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(job.recipe_id).toBe(CUT_JOB);
    // its own denoise (SCAIL's 0.35), not the dialog's, which is H3's; its Picture; the family whose files it loads
    expect(JSON.parse(job.inputs)).toMatchObject({ action: "finish", route: "face", faceDenoise: 0.35, picture, family: "scail", finishedFrom: draft.id });

    const graph = await finish(four!, 2);
    const of = (type: string) => Object.values(graph).filter((n) => n.class_type === type);
    expect(of("H3FaceStitch")).toHaveLength(1);
    expect(of("CLIPLoader").map((n) => n.inputs.clip_name)).toEqual(["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]);
    expect(of("AfflatusH3AudioLock")).toHaveLength(1);
    const sigmas = Object.values(graph).find((n) => n.class_type === "BasicScheduler")!;
    expect(sigmas.inputs).toMatchObject({ denoise: 0.35, steps: 4 });

    await until(async () => withTakes((await get(t.app, `/api/timelines/${tl.id}`)).json()).clips[0].takes.length === 2, 20_000);
    const after = withTakes((await get(t.app, `/api/timelines/${tl.id}`)).json()).clips[0];
    expect(after.take.finishedFrom).toBe(draft.id);
    expect(after.take.asset.name).toMatch(/face refined$/);
  });

  it("on a lone ComfyUI without its pack and no Manager to install it: it goes, and fails saying what to install, rather than wait for good", async () => {
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance no pack" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    fake.catalog = Object.fromEntries(Object.entries(fake.catalog).filter(([n]) => !n.startsWith("H3Face"))) as never;
    (await t.services.comfy()).forgetAll();
    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    const row = async () => t.db.selectFrom("jobs").select(["status", "error"]).where("id", "=", res.jobs[0]).executeTakeFirst();
    await until(async () => (await row())?.status === "failed", 20_000);
    expect((await row())?.error).toContain("comfyui-h3-facerefine");
  });

  it("skips the 16 fps recipe, which offers no Face refine", async () => {
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance 16" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 2, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    expect(res.jobs).toEqual([]);
    expect(res.skipped[0].why).toMatch(/offers no Face refine/);
  });
});
