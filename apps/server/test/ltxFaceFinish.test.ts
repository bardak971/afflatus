import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { CUT_JOB } from "../src/timelineModel";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip } from "./clipKit";
import { get, withTakes, makeApp, png, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Finish › Face refine on an LTX 2.5 take (card #84): its kept latent is LTX's, not H3's, so its take's own frames are
 * refined in a cut job as SCAIL-2's are (H3's pass, towards the clip's person, the take's sound held), at the dialog's
 * denoise as H3's clips; never rendered again (an LTX clip rendered again is a new video).
 */

const FILES = {
  diffusion_models: ["ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors"],
  text_encoders: ["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"],
  vae: ["ltx-2.5-video-vae-bf16.safetensors", "ltx-2.5-audio-vae-bf16.safetensors", "minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"],
  latent_upscale_models: ["ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"],
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
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: FILES });
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

async function picture(): Promise<string> {
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}`;
  const bytes = png(192, 320);
  await t.services.storage.put(key, bytes);
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind: "image", origin: "uploaded", name: "zz-test picture", file_key: key, thumb_key: null, mime: "image/png", bytes: bytes.length,
    width: 192, height: 320, duration_ms: null, fps: null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now(),
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

/** A timeline with one LTX 2.5 clip opening on a picture, its draft rendered. */
async function drafted(name: string) {
  const start = await picture();
  const tl = await call("POST", "/api/timelines", { name });
  const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "ltx25.video" })).clip as string;
  await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: clip, input: { prompt: "zz-test a person talks", start, seconds: 4, seed: 1 } }] });
  await finish(four!, 1);
  const draft = withTakes((await get(t.app, `/api/timelines/${tl.id}`)).json()).clips[0].take;
  return { tl: tl.id as string, start, draft };
}

describe.skipIf(!ffmpegThere)("Finish › Face refine on an LTX 2.5 take", { timeout: FFMPEG_TIMEOUT }, () => {
  it("refines the take's own frames towards the picture it opened on, in a cut job, at the dialog's denoise", async () => {
    const { tl, start, draft } = await drafted("zz-test ltx face");
    expect(draft).toBeTruthy();
    const res = await call("POST", `/api/timelines/${tl}/finish`, { route: "face", factor: 2, faceDenoise: 0.4, redo: true });
    expect(res.skipped).toEqual([]);
    expect(res.jobs).toHaveLength(1);
    const job = await t.db.selectFrom("jobs").selectAll().where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(job.recipe_id).toBe(CUT_JOB);
    expect(JSON.parse(job.inputs)).toMatchObject({ action: "finish", route: "face", faceDenoise: 0.4, picture: start, family: "ltx25", finishedFrom: draft.id });

    const graph = await finish(four!, 2);
    const of = (type: string) => Object.values(graph).filter((n) => n.class_type === type);
    expect(of("H3FaceStitch")).toHaveLength(1);
    // H3's own pieces, found among LTX 2.5's family's Face refine files
    expect(of("CLIPLoader").map((n) => n.inputs.clip_name)).toEqual(["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"]);
    expect(of("BasicScheduler")[0]!.inputs).toMatchObject({ denoise: 0.4, steps: 4 });
    await until(async () => withTakes((await get(t.app, `/api/timelines/${tl}`)).json()).clips[0].takes.length === 2, 20_000);
    const after = withTakes((await get(t.app, `/api/timelines/${tl}`)).json()).clips[0];
    expect(after.take.finishedFrom).toBe(draft.id);
  });

  it("is never queued as a render again before an upscale: the upscale alone, and said", async () => {
    const { tl } = await drafted("zz-test ltx face seedvr");
    const res = await call("POST", `/api/timelines/${tl}/finish`, { route: "seedvr", factor: 2, face: true, redo: true });
    expect(res.jobs).toHaveLength(1);
    const job = await t.db.selectFrom("jobs").select("recipe_id").where("id", "=", res.jobs[0]).executeTakeFirstOrThrow();
    expect(job.recipe_id).toBe(CUT_JOB);
    expect(res.skipped[0].why).toMatch(/Face refine it alone/);
  });

  it("skips a take interpolated to twice its frames with none of its own kept", async () => {
    const { tl, draft } = await drafted("zz-test ltx face doubled");
    await t.db.updateTable("assets").set({ fps: 48 }).where("id", "=", draft.asset.id).execute();
    const res = await call("POST", `/api/timelines/${tl}/finish`, { route: "face", factor: 2, redo: true });
    expect(res.jobs).toEqual([]);
    expect(res.skipped[0].why).toMatch(/Face refine runs at 24 a second/);
  });
});
