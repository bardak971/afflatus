import { frozenTailAt } from "../src/cut";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { wan } from "../../../packages/workflows/test/fixtures";
import { readVideo, tools } from "../src/video";
import { rifeModelIn } from "../src/queue";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/** A two-second test clip with a tone, made with ffmpeg. These tests are skipped where ffmpeg is not installed. */
function makeClip(sound: boolean): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-clip-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x192:rate=16:duration=2",
    ...(sound ? ["-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", "-shortest"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const clip = makeClip(true);
const silent = makeClip(false);
const real = { ...tools };

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  Object.assign(tools, real);
  await t.close();
  await fake.close().catch(() => {});
});

/** Import the Wan test workflow, queue one clip and let the pretend ComfyUI answer with `bytes`. */
async function render(bytes: Uint8Array) {
  const found = (await post(t.app, "/api/workflows/inspect", wan)).json();
  const { id } = (await post(t.app, "/api/workflows", { title: "Picture to video", model: "Wan 2.2", source: "wan.json", graph: found.graph, bindings: found.suggested })).json();
  await post(t.app, "/api/jobs", { recipe: id, input: { prompt: "She waves." } });
  await until(() => fake.prompts.size === 1);
  const promptId = [...fake.prompts.keys()][0]!;
  fake.files["clip.mp4"] = bytes;
  fake.pending = [];
  fake.history[promptId] = { status: { completed: true }, outputs: { "63": { gifs: [{ filename: "clip.mp4", subfolder: "", type: "temp" }] } } };
  await until(async () => (await get(t.app, "/api/assets")).json().items.length === 1);
  return (await get(t.app, "/api/assets")).json().items[0];
}

describe.skipIf(!clip || !silent)("a video in the library", () => {
  it("is read for its size, its length, its speed and its sound", async () => {
    expect((await readVideo(clip!, "mp4")).facts).toMatchObject({ width: 320, height: 192, fps: 16, hasSound: true });
    expect((await readVideo(silent!, "mp4")).facts).toMatchObject({ durationMs: 2000, hasSound: false });
  });

  it("is filed with those, and with a frame to show in grids", async () => {
    const asset = await render(clip!);
    expect(asset).toMatchObject({ kind: "video", width: 320, height: 192, fps: 16, hasSound: true });
    expect(asset.durationMs).toBeGreaterThan(1900);
    const thumb = await get(t.app, `/api/assets/${asset.id}/thumb`);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
  });

  it("is stored and played all the same where ffmpeg is not installed: it just has no picture", async () => {
    tools.ffmpeg = "no-such-ffmpeg";
    tools.ffprobe = "no-such-ffprobe";
    const asset = await render(clip!);
    expect(asset).toMatchObject({ kind: "video", mime: "video/mp4", width: null, durationMs: null, hasSound: false });
    expect((await get(t.app, `/api/assets/${asset.id}/thumb`)).statusCode).toBe(404);
    expect((await get(t.app, `/api/assets/${asset.id}/file`)).statusCode).toBe(200);

    // once ffmpeg is there, the frame and the facts are made the first time they are asked for
    Object.assign(tools, real);
    expect((await get(t.app, `/api/assets/${asset.id}/thumb`)).headers["content-type"]).toBe("image/webp");
    expect((await get(t.app, `/api/assets/${asset.id}`)).json()).toMatchObject({ width: 320, height: 192, hasSound: true });
  });
});

describe("what is not a video", () => {
  it("gives no facts and no frame, and does not throw", async () => {
    const read = await readVideo(new Uint8Array([1, 2, 3, 4]), "mp4");
    expect(read).toEqual({ facts: null, frame: null });
  });
});

describe.skipIf(!clip)("a range of a video", () => {
  const settled = async (id: string) => {
    await until(async () => ["done", "failed"].includes((await get(t.app, "/api/jobs")).json().items.find((j: { id: string }) => j.id === id)?.status));
    return (await get(t.app, "/api/jobs")).json().items.find((j: { id: string }) => j.id === id);
  };

  it("is copied to the library as a new video that remembers where it came from", async () => {
    const video = await render(clip!);
    const { id } = (await post(t.app, `/api/assets/${video.id}/range`, { startMs: 500, endMs: 1500, action: "copy", crf: 16 })).json();
    const job = await settled(id);
    expect(job).toMatchObject({ status: "done", kind: "cut" });
    const items = (await get(t.app, "/api/assets")).json().items as Array<{ id: string; kind: string; durationMs: number; name: string }>;
    expect(items).toHaveLength(2);
    const cut = items.find((a) => a.id !== video.id)!;
    expect(cut.kind).toBe("video");
    expect(cut.durationMs).toBeGreaterThan(900);
    expect(cut.durationMs).toBeLessThan(1150);
    expect(cut.name).toContain("0:00.5–0:01.5");
    const detail = (await get(t.app, `/api/assets/${cut.id}`)).json();
    expect(detail.source).toMatchObject({ asset: { id: video.id }, range: { startMs: 500, endMs: 1500 } });
    // the source stays
    expect((await get(t.app, `/api/assets/${video.id}`)).json().inBin).toBe(false);
  });

  it("is split into three, and removed from the rest; the source goes to the bin", async () => {
    const video = await render(clip!);
    const split = (await post(t.app, `/api/assets/${video.id}/range`, { startMs: 500, endMs: 1500, action: "split" })).json();
    expect((await settled(split.id)).status).toBe("done");
    let items = (await get(t.app, "/api/assets")).json().items as Array<{ id: string; durationMs: number }>;
    expect(items.filter((a) => a.id !== video.id)).toHaveLength(3);
    expect((await get(t.app, `/api/assets/${video.id}`)).json().inBin).toBe(true);
    // the pieces add up to the whole
    const total = items.filter((a) => a.id !== video.id).reduce((n, a) => n + a.durationMs, 0);
    expect(total).toBeGreaterThan(1850);
    expect(total).toBeLessThan(2200);

    const piece = items.find((a) => a.id !== video.id)!;
    const before = new Set(items.map((a) => a.id));
    const remove = (await post(t.app, `/api/assets/${piece.id}/range`, { startMs: 100, endMs: 300, action: "remove" })).json();
    expect((await settled(remove.id)).status).toBe("done");
    items = (await get(t.app, "/api/assets")).json().items;
    const without = items.find((a) => !before.has(a.id))!;
    expect(without.durationMs).toBeLessThan(piece.durationMs);
    expect((await get(t.app, `/api/assets/${piece.id}`)).json().inBin).toBe(true);
  });

  it("has its motion measured once: ten samples a second, kept for the next time", async () => {
    const video = await render(clip!);
    const first = (await get(t.app, `/api/assets/${video.id}/motion`)).json() as { rate: number; values: number[]; sound: number[] | null };
    expect(first.rate).toBe(10);
    // ten a second over the clip's length, none negative
    const expected = Math.round((video.durationMs ?? 0) / 100);
    expect(first.values.length).toBeGreaterThanOrEqual(expected - 3);
    expect(first.values.length).toBeLessThanOrEqual(expected + 2);
    expect(first.values.every((v) => v >= 0)).toBe(true);
    // and its loudness, in dB, as many samples (the clip has a tone)
    expect(first.sound).not.toBeNull();
    expect(Math.abs(first.sound!.length - first.values.length)).toBeLessThanOrEqual(2);
    expect(first.sound!.every((v) => v <= 0 && v >= -90)).toBe(true);
    const again = (await get(t.app, `/api/assets/${video.id}/motion`)).json();
    expect(again).toEqual(first);
  });

  it("is slowed down: twice as long, the same frame rate, its sound slowed with it (ffmpeg here, RIFE on a GPU)", async () => {
    const video = await render(clip!);
    const { id, engine } = (await post(t.app, `/api/assets/${video.id}/range`, { startMs: 500, endMs: 1500, action: "slow", factor: 2 })).json();
    expect(engine).toBe("ffmpeg");
    const job = await settled(id);
    expect(job).toMatchObject({ status: "done", kind: "cut" });
    const items = (await get(t.app, "/api/assets")).json().items as Array<{ id: string; durationMs: number; name: string; hasSound: boolean; fps: number | null }>;
    const slow = items.find((x) => /slow ×2/.test(x.name));
    expect(slow).toBeTruthy();
    expect(slow!.durationMs).toBeGreaterThan(1800);
    expect(slow!.durationMs).toBeLessThan(2300);
    expect(slow!.hasSound).toBe(true);
    const detail = (await get(t.app, `/api/assets/${slow!.id}`)).json();
    expect(detail.source).toMatchObject({ asset: { id: video.id }, range: { startMs: 500, endMs: 1500 } });
  });

  it("refuses an empty range and the whole video", async () => {
    const video = await render(clip!);
    expect((await post(t.app, `/api/assets/${video.id}/range`, { startMs: 500, endMs: 505, action: "copy" })).statusCode).toBe(400);
    expect((await post(t.app, `/api/assets/${video.id}/range`, { startMs: 0, endMs: video.durationMs, action: "copy" })).statusCode).toBe(400);
  });
});

describe("the RIFE model a ComfyUI offers", () => {
  it("is read from an older catalog (choices in the type position) and a newer one (COMBO with options)", () => {
    expect(rifeModelIn({ FrameInterpolationModelLoader: { input: { required: { model_name: [["film_net.pkl", "rife47.pth"]] } } } })).toBe("rife47.pth");
    expect(rifeModelIn({ FrameInterpolationModelLoader: { input: { required: { model_name: ["COMBO", { options: ["rife_v4.26.safetensors"] }] } } } })).toBe("rife_v4.26.safetensors");
    expect(rifeModelIn({ FrameInterpolationModelLoader: { input: { required: { model_name: ["COMBO", { options: [] }] } } } })).toBeNull();
    expect(rifeModelIn({})).toBeNull();
  });
});

describe("the frozen tail of a clip", () => {
  const lively = (n: number) => Array.from({ length: n }, (_, i) => 1.2 + (i % 3) * 0.2);
  it("is found when the motion dies before the end, and left alone when the clip moves to the last", () => {
    // 4 s lively, then 0.6 s still: the hand-over is where it froze
    expect(frozenTailAt([...lively(40), 0.1, 0.05, 0.1, 0.0, 0.1, 0.05], 10, 0, 4600)).toBe(4000);
    // moving to the end: nothing to do
    expect(frozenTailAt(lively(46), 10, 0, 4600)).toBeNull();
    // a flicker of a tenth of a second at the end is not a frozen tail
    expect(frozenTailAt([...lively(45), 0.1], 10, 0, 4600)).toBeNull();
    // a clip still for most of its length: not a tail, the clip is like that (never more than a third)
    expect(frozenTailAt([...lively(10), ...Array(30).fill(0.05)], 10, 0, 4000)).toBeNull();
    // only the part that plays counts: a trimmed end that stops before the stillness
    expect(frozenTailAt([...lively(40), 0.1, 0.05, 0.1, 0.0, 0.1, 0.05], 10, 0, 3900)).toBeNull();
    // too short to judge
    expect(frozenTailAt([1, 1, 0, 0, 0], 10, 0, 500)).toBeNull();
  });
});

describe.skipIf(!clip)("a video an imported workflow's own loader reads", () => {
  // a workflow that carries a clip on (its loader named so): the loader's frames straight into the saver
  const v2v = {
    "1": { class_type: "VHS_LoadVideo", inputs: { video: "author.mp4", force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 }, _meta: { title: "Clip before" } },
    "2": { class_type: "VHS_VideoCombine", inputs: { images: ["1", 0], frame_rate: 16, loop_count: 0, filename_prefix: "v2v", format: "video/h264-mp4", pingpong: false, save_output: true } },
  };
  const handed = async (value: { asset: string; at?: number }) => {
    const found = (await post(t.app, "/api/workflows/inspect", v2v)).json();
    const { id } = (await post(t.app, "/api/workflows", { title: "V2V", model: "Wan 2.2", source: "v2v.json", graph: found.graph, bindings: found.suggested })).json();
    fake.prompts.clear();
    await post(t.app, "/api/jobs", { recipe: id, input: { previousVideo: value } });
    await until(() => fake.prompts.size === 1);
    const [promptId, graph] = [...fake.prompts.entries()][0]!;
    const name = String(graph["1"]!.inputs.video).replace(/ \[temp\]$/, "");
    // done, so that the next job is sent
    fake.pending = [];
    fake.history[promptId] = { status: { completed: true }, outputs: {} };
    await until(async () => (await get(t.app, "/api/jobs")).json().items.every((j: { status: string }) => ["done", "failed"].includes(j.status)));
    return (await readVideo(fake.uploaded[name]!, "mp4")).facts!;
  };

  it("is handed whole, or up to the moment chosen (Extend from here)", async () => {
    const source = (await t.app.inject({ method: "POST", url: "/api/assets?name=source.mp4", headers: { "content-type": "video/mp4" }, payload: Buffer.from(clip!) })).json();
    expect((await handed({ asset: source.id })).durationMs).toBeGreaterThan(1900);
    const cut = await handed({ asset: source.id, at: 1000 });
    expect(cut.durationMs).toBeGreaterThan(900);
    expect(cut.durationMs).toBeLessThan(1150);
    expect(cut.hasSound).toBe(true);
  });
});
