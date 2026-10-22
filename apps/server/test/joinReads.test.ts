import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now } from "../src/db";
import { newAssetRow } from "../src/media";
import { FFMPEG_TIMEOUT, ffmpegMade, ffmpegThere } from "./clipKit";
import { makeApp, png, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * What a window carrying on from the clip before runs of ffmpeg and ffprobe before its prompt can go: every run sits in the
 * GPU's idle between two renders. The clip before's own frames were read twice whole (a probe and a first frame each time,
 * the frames never used) and cut from a third copy of their bytes: six runs and three copies where a probe and the cut do.
 */
const runs = vi.hoisted(() => ({ all: [] as Array<{ tool: string; args: string[] }> }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const execFile = (...all: unknown[]) => {
    const [tool, args] = all as [string, string[]];
    runs.all.push({ tool: String(tool), args: [...args] });
    return (real.execFile as (...a: unknown[]) => unknown)(...all);
  };
  return { ...real, execFile };
});

const SCAIL_FILES = {
  diffusion_models: ["wan2.1_14B_SCAIL_2_int8_convrot.safetensors"],
  loras: ["wan2.1_SCAIL_2_DPO_lora_bf16.safetensors", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"],
  text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
  vae: ["wan_2.1_vae.safetensors"],
  clip_vision: ["clip_vision_h.safetensors"],
  checkpoints: ["sam3.1_multiplex_fp16.safetensors"],
  frame_interpolation: ["rife49.pth"],
};

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
  catalog.CheckpointLoaderSimple!.input.required!.ckpt_name = [SCAIL_FILES.checkpoints];
  fake = await startFakeComfy({ catalog, models: SCAIL_FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
  runs.all.length = 0;
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

/** The file a run reads: ffmpeg's `-i`, ffprobe's last argument. */
const inputOf = (r: { tool: string; args: string[] }) => (r.args.includes("-i") ? r.args[r.args.indexOf("-i") + 1]! : r.args[r.args.length - 1]!);

describe.skipIf(!ffmpegThere)("a window carrying on from the clip before", { timeout: FFMPEG_TIMEOUT }, () => {
  it("probes the clip before's own frames once, grabs no first frame of them, and cuts them where they are stored", async () => {
    const rawKey = `raw/${newId()}.mp4`;
    await t.services.storage.put(rawKey, blue!);
    const rawPath = t.services.storage.localPath!(rawKey)!;
    const before = await asset("video", red!, { raw_key: rawKey });
    const driving = await asset("video", red!);
    const picture = await asset("image", png(192, 320));
    runs.all.length = 0;
    const res = await post(t.app, "/api/jobs", {
      recipe: "scail.motion",
      input: { picture, driving: { asset: driving }, previous: { asset: before }, drivingStart: 0, drivingSeconds: 1.5, prompt: "zz-test", seed: 1 },
    });
    expect(res.statusCode).toBeLessThan(400);
    await until(() => fake.prompts.size === 1, 30_000);
    const media = runs.all.filter((r) => /ff(mpeg|probe)/i.test(r.tool) && !r.args.includes("-version"));
    const ofRaw = media.filter((r) => inputOf(r) === rawPath);
    // what read a temporary copy of a stored file's bytes (written out as "in.<ext>"), not the stored file itself
    const copies = media.filter((r) => /[\\/]in\.\w+$/.test(inputOf(r)));
    const firstFrames = media.filter((r) => r.args.includes("-frames:v") && !r.args.includes("-ss"));
    const probes = ofRaw.filter((r) => /ffprobe/i.test(r.tool) && !r.args.includes("-count_frames"));
    console.log(`[joinReads] runs ${media.length}, of the raw file by path ${ofRaw.length}, of temp copies ${copies.length}, first frames ${firstFrames.length}, probes of the raw ${probes.length}`);
    expect(firstFrames).toHaveLength(0);
    expect(copies).toHaveLength(0);
    expect(probes).toHaveLength(1);
    // the cut (and its frame count) reads the stored file
    expect(ofRaw.filter((r) => /ffmpeg/i.test(r.tool) && r.args.some((a) => a.includes("trim=start_frame")))).toHaveLength(1);
  });
});
