import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";
import { makeApp, png, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A Motion transfer window carrying on from the clip before: the model's own frames of that clip are handed over, and its
 * last frame as it was filed goes up beside them (the colour match takes the transform that clip was filed with).
 */

const SCAIL_FILES = {
  diffusion_models: ["wan2.1_14B_SCAIL_2_int8_convrot.safetensors"],
  loras: ["wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"],
  text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vae: ["wan_2.1_vae.safetensors"],
  clip_vision: ["clip_vision_h.safetensors"],
  checkpoints: ["sam3.1_multiplex_fp16.safetensors"],
  frame_interpolation: ["rife49.pth"],
};

/** Two seconds of one colour at 16 a second. */
const plain = (colour: string) => ffmpegMade(["-f", "lavfi", "-i", `color=c=${colour}:size=192x320:rate=16:duration=2`, "-c:v", "libx264", "-pix_fmt", "yuv420p"]);

let fake: FakeComfy;
let t: TestApp;
let red: Uint8Array;
let blue: Uint8Array;
beforeAll(async () => {
  if (ffmpegThere) [red, blue] = await Promise.all([plain("red"), plain("blue")]);
}, FFMPEG_TIMEOUT);
beforeEach(async () => {
  const catalog = referenceCatalog();
  // SAM 3 is a checkpoint: the reference catalog's checkpoints are an SDXL test's
  catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [SCAIL_FILES.checkpoints];
  // a ComfyUI without the node pack's Follow Colours (before 0.34.0): the window matched to the clip before's last frame as filed
  delete catalog.AfflatusColorFollow;
  fake = await startFakeComfy({ catalog, models: SCAIL_FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

async function asset(kind: "video" | "image", bytes: Uint8Array, over: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  const key = `assets/${id.slice(0, 2)}/${id}`;
  await t.services.storage.put(key, bytes);
  await t.db.insertInto("assets").values(newAssetRow({
    id, kind, origin: "uploaded", name: `zz-test ${kind}`, file_key: key, thumb_key: null, mime: kind === "video" ? "video/mp4" : "image/png", bytes: bytes.length,
    width: 192, height: 320, duration_ms: kind === "video" ? 2000 : null, fps: kind === "video" ? 16 : null, has_sound: 0, folder_id: null, generation_id: null, kept_at: now(), ...over,
  })).execute();
  return id;
}

describe.skipIf(!ffmpegThere)("a Motion transfer window carrying on", { timeout: FFMPEG_TIMEOUT }, () => {
  it("is handed the clip before's own frames, and its last frame as it was filed beside them", async () => {
    // the clip before as filed is red, its own frames (kept beside it) blue
    const rawKey = `raw/${newId()}`;
    await t.services.storage.put(rawKey, blue!);
    const before = await asset("video", red!, { raw_key: rawKey });
    const driving = await asset("video", red!);
    const picture = await asset("image", png(192, 320));
    const res = await post(t.app, "/api/jobs", {
      recipe: "scail.motion",
      input: { picture, driving: { asset: driving }, previous: { asset: before }, drivingStart: 0, drivingSeconds: 1.5, prompt: "zz-test", seed: 1 },
    });
    expect(res.statusCode).toBeLessThan(400);
    await until(() => fake.prompts.size === 1, 30_000);
    const graph = [...fake.prompts.values()][0]!;
    const loads = Object.values(graph).filter((n) => n.class_type === "LoadImage").map((n) => String(n.inputs.image));
    const match = Object.values(graph).find((n) => n.class_type === "ColorTransfer" && n.inputs.source_stats === "target_frame");
    expect(match).toBeDefined();
    const look = graph[(match!.inputs.image_ref as [string, number])[0]]!.inputs.image as string;
    expect(loads).toContain(look);
    // the frame uploaded is the filed one's (red), not the model's own (blue)
    const uploaded = Object.entries(fake.uploaded).find(([name]) => look.includes(name))?.[1];
    expect(uploaded, `${look} in ${Object.keys(fake.uploaded).join(", ")}`).toBeDefined();
    const { channels } = await sharp(uploaded!).stats();
    expect(channels[0]!.mean).toBeGreaterThan(200);
    expect(channels[2]!.mean).toBeLessThan(60);
  });
});
