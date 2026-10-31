import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OWN_MODEL } from "@afflatus/core";
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

  // card #192: the model picked was left out, the pass ran on the fused turbo at 4 steps whatever Finish said
  it("redraws with the Face refine model picked in Finish, at that model's steps, and a redo with another model is a change", async () => {
    const full = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    fake.models = { ...FILES, diffusion_models: [...FILES.diffusion_models, full] };
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance model" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    await finish(four!, 2);

    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, faceModel: full, redo: "changed" });
    expect(res.jobs).toHaveLength(1);
    const job = await t.db.selectFrom("jobs").selectAll().where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(JSON.parse(job.inputs)).toMatchObject({ route: "face", faceModel: full });
    const graph = await finish(four!, 3);
    const of = (type: string) => Object.values(graph).filter((n) => n.class_type === type);
    expect(of("UNETLoader").map((n) => n.inputs.unet_name)).toEqual([full]);
    expect(of("BasicScheduler")[0]!.inputs).toMatchObject({ steps: 10 });
    // the same model again: nothing changed
    expect((await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, faceModel: full, redo: "changed" })).jobs).toEqual([]);
  });

  // card #204: the form's Face refine model, where Finish names none ("as each clip's form")
  it("with no model picked in Finish, redraws with the one the clip's form picked", async () => {
    const full = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    fake.models = { ...FILES, diffusion_models: [...FILES.diffusion_models, full] };
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance form model" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1, faceRefine: true, faceRefineModel: full } }] });
    const rendered = await finish(four!, 1);
    expect(Object.values(rendered).filter((n) => n.class_type === "UNETLoader").map((n) => n.inputs.unet_name)).toContain(full);
    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    const job = await t.db.selectFrom("jobs").selectAll().where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(JSON.parse(job.inputs)).toMatchObject({ route: "face", faceModel: full });
    const graph = await finish(four!, 2);
    expect(Object.values(graph).filter((n) => n.class_type === "UNETLoader").map((n) => n.inputs.unet_name)).toEqual([full]);
  });

  // release review 0.9.0, B7: the steps the form typed came out as the full model's 10
  it("with no model picked in Finish, redraws at the steps the clip's form typed", async () => {
    const full = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    fake.models = { ...FILES, diffusion_models: [...FILES.diffusion_models, full] };
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance form steps" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1, faceRefine: true, faceRefineModel: full, faceRefineSteps: 12 } }] });
    await finish(four!, 1);
    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    const job = await t.db.selectFrom("jobs").selectAll().where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(JSON.parse(job.inputs)).toMatchObject({ route: "face", faceModel: full, faceSteps: 12 });
    const graph = await finish(four!, 2);
    expect(Object.values(graph).filter((n) => n.class_type === "BasicScheduler")[0]!.inputs).toMatchObject({ steps: 12 });
  });

  it("asked for the clip's own model: SCAIL-2's is not H3's, so the fused turbo, and its job says so", async () => {
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance own" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, faceModel: OWN_MODEL, redo: true });
    const graph = await finish(four!, 2);
    const of = (type: string) => Object.values(graph).filter((n) => n.class_type === type);
    expect(of("UNETLoader").map((n) => n.inputs.unet_name)).toEqual([FILES.diffusion_models[1]]);
    expect(of("BasicScheduler")[0]!.inputs).toMatchObject({ steps: 4 });
    const job = await t.db.selectFrom("jobs").select("warning").where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(job.warning).toContain(`Face refine ran on ${FILES.diffusion_models[1]}, the fused turbo of Settings › Models: this clip's own model is not H3's.`);
  });

  it("finds its files in the scan kept and sends its Picture once to that ComfyUI, finished again or not", async () => {
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance twice" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    // what each finish asks of ComfyUI from its job's start to its prompt: a folder listing per slot, the photo every time
    const from = fake.calls.length;
    await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    await finish(four!, 2);
    await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    await finish(four!, 3);
    const asked = fake.calls.slice(from);
    console.log(`[face finish] two finishes: ${asked.filter((c) => c.startsWith("GET /models/")).length} folder listings, ${asked.filter((c) => c === "POST /upload/image").length} uploads, ${fake.uploads.filter((n) => n.startsWith("afflatus_")).length} under the photo's name`);
    // listed only where the scan has no file for a slot (its optional face segmenter): 16 listings before, for two finishes
    expect(asked.filter((c) => /^GET \/models\/(diffusion_models|text_encoders|vae)$/.test(c))).toEqual([]);
    expect(asked.filter((c) => c.startsWith("GET /models/")).length).toBeLessThanOrEqual(4);
    // the take's frames once, under their content's name as the Picture: the second finish of the same take sends nothing,
    // and the Picture the render sent already is not sent again (4 uploads before)
    expect(asked.filter((c) => c === "POST /upload/image")).toHaveLength(1);
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

  it("without the Impact Pack's SAMLoader: refined, pasted over the face's box, and the job says so", async () => {
    const driving = await asset("video", four!);
    const picture = await asset("image", png(192, 320));
    const tl = await call("POST", "/api/timelines", { name: "zz-test dance no sam" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "scail.motion24" })).clip as string;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { picture, driving: { asset: driving }, drivingStart: 0, drivingSeconds: 3.05, prompt: "zz-test", seed: 1 } }] });
    await finish(four!, 1);
    fake.catalog = Object.fromEntries(Object.entries(fake.catalog).filter(([n]) => n !== "SAMLoader")) as never;
    (await t.services.comfy()).forgetAll();
    const res = await call("POST", `/api/timelines/${tl.id}/finish`, { route: "face", factor: 2, redo: true });
    const graph = await finish(four!, 2);
    expect(Object.values(graph).filter((n) => n.class_type === "H3FaceStitch")).toHaveLength(1);
    expect(Object.values(graph).some((n) => n.class_type === "SAMLoader" || n.class_type === "H3FaceMaskSAM")).toBe(false);
    const job = await t.db.selectFrom("jobs").select("warning").where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(job.warning).toContain("Ran without SAM's outline (the face pasted over its box): its node pack comfyui-impact-pack is missing.");
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
