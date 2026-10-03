import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import type { Graph } from "@afflatus/core";
import { wan } from "../../../packages/workflows/test/fixtures";
import { cutFrames, frameAt, referenceClip } from "../src/cut";
import { pngSize } from "../src/media";
import { readVideo } from "../src/video";
import { get, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";
import { makePng } from "@afflatus/comfy/testing";

/** A test clip made with ffmpeg: a moving pattern and a tone. These tests are skipped where ffmpeg is not installed. */
function makeClip(seconds: number, opts: { fps?: number; sound?: boolean; size?: string } = {}): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-clip-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${opts.size ?? "192x320"}:rate=${opts.fps ?? 24}:duration=${seconds}`,
    ...(opts.sound === false ? [] : ["-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-c:a", "aac", "-shortest"]),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
/** A tone as a sound file. */
function makeTone(seconds: number): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-tone-"));
  const file = join(dir, "tone.wav");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, file]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const tone = makeTone(4);
const three = makeClip(3);
const smooth = makeClip(3, { fps: 48 });
const silent = makeClip(2, { sound: false });

/** How many frames a video has, counted by ffprobe. */
function frames(bytes: Uint8Array): number {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-count-"));
  const file = join(dir, "v.mp4");
  writeFileSync(file, bytes);
  const out = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return Number(out.stdout.trim());
}

const H3_FILES = {
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  frame_interpolation: ["rife49.pth"],
  checkpoints: [],
};

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: H3_FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const call = async (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};
const view = async (id: string) => (await get(t.app, `/api/timelines/${id}`)).json();
const prompts = () => [...fake.prompts.entries()];
const nodes = (graph: Graph, cls: string) => Object.values(graph).filter((n) => n.class_type === cls);

/** Let the pretend ComfyUI finish the latest prompt with this video. */
async function finish(bytes: Uint8Array, count: number) {
  await until(() => fake.prompts.size === count);
  const [promptId, graph] = prompts().at(-1)!;
  const out = Object.entries(graph).find(([, n]) => /VideoCombine/.test(n.class_type))![0];
  fake.files[`${promptId}.mp4`] = bytes;
  fake.pending = fake.pending.filter((p) => p !== promptId);
  fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
  await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0 || fake.prompts.size > count);
  return graph;
}

const render = (timeline: string, clips: Array<{ id: string; fit?: boolean }>, description = "She walks to the window.") =>
  call("POST", `/api/timelines/${timeline}/render`, { clips: clips.map((c) => ({ ...c, input: { description } })) });

/** A timeline with two clips, the second carrying on from the first, both rendered. */
async function twoClips() {
  const tl = await call("POST", "/api/timelines", { name: "Evening" });
  const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
  await render(tl.id, [{ id: a }]);
  const first = await finish(three!, 1);
  const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
  await render(tl.id, [{ id: b }]);
  const second = await finish(three!, 2);
  return { id: tl.id as string, a, b, first, second };
}

describe.skipIf(!three || !smooth || !silent)("the frames a clip joins onto", () => {
  it("are the last ones before a moment, or the first ones after it, with their sound", async () => {
    const facts = { durationMs: 3000, hasSound: true };
    const end = await cutFrames(three!, "mp4", facts, { counts: [22, 5], fps: 24, side: "before" });
    expect(end.frames).toBe(22);
    expect(frames(end.bytes)).toBe(22);
    expect((await readVideo(end.bytes, "mp4")).facts).toMatchObject({ width: 192, height: 320, fps: 24, hasSound: true });
    const start = await cutFrames(three!, "mp4", facts, { counts: [22, 5], fps: 24, side: "after", at: 1000 });
    expect(frames(start.bytes)).toBe(22);
  });

  it("are every other frame of a clip that was smoothed to twice the speed", async () => {
    const cut = await cutFrames(smooth!, "mp4", { durationMs: 3000, hasSound: true }, { counts: [22, 5], fps: 24, side: "before", at: 2000 });
    expect(frames(cut.bytes)).toBe(22);
    expect((await readVideo(cut.bytes, "mp4")).facts).toMatchObject({ fps: 24 });
  });

  it("are fewer when the moment is close to the start, and refused when there is no room at all", async () => {
    const facts = { durationMs: 2000, hasSound: false };
    const cut = await cutFrames(silent!, "mp4", facts, { counts: [22, 5], fps: 24, side: "before", at: 500 });
    expect(cut.frames).toBe(5);
    expect((await readVideo(cut.bytes, "mp4")).facts).toMatchObject({ hasSound: false });
    await expect(cutFrames(silent!, "mp4", facts, { counts: [22, 5], fps: 24, side: "before", at: 100 })).rejects.toThrow(/too short/);
  });

  it("one frame comes out as a picture, the last one when the moment is past the end", async () => {
    expect(pngSize(await frameAt(three!, "mp4", 1500))).toEqual({ width: 192, height: 320 });
    expect(pngSize(await frameAt(three!, "mp4", 9000, 3000))).toEqual({ width: 192, height: 320 });
  });
});

describe.skipIf(!three)("a timeline", () => {
  it("renders a clip, makes its video a take that plays, and takes its frame from it", async () => {
    const tl = await call("POST", "/api/timelines", {});
    expect(tl).toMatchObject({ name: "Timeline 1", width: null, clips: [] });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await render(tl.id, [{ id: a }]);
    await until(async () => (await view(tl.id)).clips[0].job !== null);
    const graph = await finish(three!, 1);
    // on its own: nothing to join onto, the shape it was asked for
    expect(nodes(graph, "MiniMaxH3AddGuide")).toHaveLength(0);
    expect(nodes(graph, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 576, height: 1024, length: 124 });

    const v = await view(tl.id);
    expect(v).toMatchObject({ width: 192, height: 320, durationMs: 3000 });
    expect(v.clips[0]).toMatchObject({ job: null, join: null, lengthMs: 3000, take: { headMs: 0, tailMs: 0, asset: { kind: "video", kept: true } } });
    expect(v.clips[0].takes).toHaveLength(1);
    expect((await get(t.app, "/api/timelines")).json().items[0]).toMatchObject({ clips: 1, durationMs: 3000, cover: v.clips[0].take.asset.id });
  });

  it("gives a clip that carries on the last frames of the clip before it, and skips them when it plays", async () => {
    const { id, second } = await twoClips();
    // the join: 22 frames of the first clip pinned at the start, the clip that much longer, in the timeline's frame
    const guide = nodes(second, "MiniMaxH3AddGuide");
    expect(guide).toHaveLength(1);
    expect(guide[0]!.inputs.frame_idx).toBe(0);
    expect(nodes(second, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 192, height: 320, length: 158 });
    expect(fake.uploads.filter((u) => u.endsWith(".mp4"))).toHaveLength(1);

    const v = await view(id);
    expect(v.clips[1]).toMatchObject({ joined: "continue", join: "fresh", atMs: 3000, lengthMs: 3000 - 917, take: { headMs: 917, startMs: 917, endMs: 3000 } });
    expect(v.durationMs).toBe(6000 - 917);
    // the lineage: the second clip was made from the first
    const detail = (await get(t.app, `/api/assets/${v.clips[1].take.asset.id}`)).json();
    expect(detail.sources).toMatchObject([{ role: "previous", asset: { id: v.clips[0].take.asset.id } }]);
    expect(detail.generation.resolved.overlap).toEqual({ headMs: 917, tailMs: 0 });
  });

  it("makes a new take of a clip end where the next one begins, so the join holds", async () => {
    const { id, a } = await twoClips();
    await render(id, [{ id: a }]);
    const graph = await finish(three!, 3);
    const guide = nodes(graph, "MiniMaxH3AddGuide");
    expect(guide).toHaveLength(1);
    expect(guide[0]!.inputs.frame_idx).toBe(-22);
    const v = await view(id);
    expect(v.clips[0].takes).toHaveLength(2);
    expect(v.clips[0]).toMatchObject({ lengthMs: 3000 - 917, take: { tailMs: 917 } });
    expect(v.clips[1].join).toBe("fresh");
  });

  it("marks the join stale when the clip before changes without fitting, until it is redone or kept as a cut", async () => {
    const { id, a, b } = await twoClips();
    await render(id, [{ id: a, fit: false }]);
    await finish(three!, 3);
    expect((await view(id)).clips[1].join).toBe("stale");

    // the take that the second clip was made from plays again: the join is good again
    const old = (await view(id)).clips[0].takes[0].id;
    await call("PATCH", `/api/clips/${a}`, { take: old });
    expect((await view(id)).clips[1].join).toBe("fresh");
    // shortening the end of the first clip breaks it too
    await call("PATCH", `/api/clips/${a}`, { trimEndMs: 500 });
    expect((await view(id)).clips[1].join).toBe("stale");
    expect((await view(id)).clips[0].lengthMs).toBe(2500);

    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    expect((await view(id)).clips[1].join).toBe("cut");
    // redone, it follows the clip before from where that one now stops
    await call("PATCH", `/api/clips/${b}`, { joined: "continue" });
    await render(id, [{ id: b }]);
    await finish(three!, 4);
    expect((await view(id)).clips[1].join).toBe("fresh");
  });

  it("renders several clips in order, each waiting for the one it carries on from", async () => {
    const { id, a, b } = await twoClips();
    await render(id, [{ id: a }, { id: b }]);
    await until(() => fake.prompts.size === 3);
    // the second waits: its join is cut from the take the first one is about to give
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.prompts.size).toBe(3);
    const firstGraph = await finish(three!, 3);
    // rendered together, the first has nothing to fit
    expect(nodes(firstGraph, "MiniMaxH3AddGuide")).toHaveLength(0);
    await finish(three!, 4);
    const v = await view(id);
    expect(v.clips.map((c: { takes: unknown[] }) => c.takes.length)).toEqual([2, 2]);
    expect(v.clips[1].join).toBe("fresh");
  });

  it("puts a video from the library on the timeline as it is, and a picture as a clip that opens on it", async () => {
    const { id } = await twoClips();
    const first = (await view(id)).clips[1].take.asset.id;
    const tl = await call("POST", "/api/timelines", {});
    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: first })).timeline.clips[0];
    // it was made by afflatus: it comes with its form and the part of it that repeats another clip stays skipped
    expect(c).toMatchObject({ joined: "cut", recipe: "h3.video", inputs: { description: "She walks to the window." }, take: { headMs: 917 } });
    expect(c.inputs.previous).toBeUndefined();

    const frame = await call("POST", `/api/assets/${first}/frame`, { atMs: 1000 });
    expect(frame).toMatchObject({ kind: "image", origin: "frame", width: 192, height: 320, kept: true });
    const d = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: frame.id, as: "clip" })).timeline.clips[1];
    expect(d).toMatchObject({ kind: "video", joined: "cut", recipe: "h3.video", take: null, inputs: { start: frame.id } });
  });

  /** Ask for an export and wait for the queue to finish it. */
  async function exported(id: string, opts: Record<string, unknown> = {}) {
    await call("POST", `/api/timelines/${id}/export`, opts);
    await until(async () => (await view(id)).exporting === null, 20_000);
    const v = await view(id);
    if (v.exportFailed) throw new Error(v.exportFailed);
    return v.exported;
  }
  const upload = async (bytes: Uint8Array, type: string, name: string) => {
    const res = await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": type }, payload: Buffer.from(bytes) });
    if (res.statusCode >= 400) throw new Error(res.body);
    return res.json();
  };

  it("is exported as one video: what plays of each clip, one after the other", async () => {
    const { id } = await twoClips();
    const out = await exported(id);
    expect(out).toMatchObject({ kind: "video", origin: "exported", name: "Evening", width: 192, height: 320, hasSound: true, kept: true });
    expect(Math.abs(out.durationMs - (6000 - 917))).toBeLessThan(120);
    // it went through the queue, where it shows as an export and needs no ComfyUI
    const recent = (await get(t.app, "/api/queue")).json().recent;
    expect(recent[0]).toMatchObject({ kind: "export", label: "Evening · export", status: "done" });
  });

  it("is exported larger when asked, and while the queue is paused: an export does not use the GPU", async () => {
    const { id } = await twoClips();
    await call("POST", "/api/queue/pause");
    const out = await exported(id, { scale: 2 });
    expect(out).toMatchObject({ width: 384, height: 640 });
  });

  it("is exported with smooth motion when asked: twice the pictures a second, worked out without the GPU", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Smooth" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await render(tl.id, [{ id: a }]);
    await finish(three!, 1);
    const out = await exported(tl.id, { smooth: true });
    expect(out.fps).toBe(48);
    const bytes = new Uint8Array((await t.app.inject({ method: "GET", url: `/api/assets/${out.id}/file` })).rawPayload);
    // the filter gives up the last few pictures, which have nothing after them to work from
    expect(Math.abs(frames(bytes) - 144)).toBeLessThanOrEqual(4);
  });

  it("makes a clip pass through a picture at the moment it is pinned to", async () => {
    const { id } = await twoClips();
    const from = (await view(id)).clips[0].take.asset.id;
    const picture = (await call("POST", `/api/assets/${from}/frame`, { atMs: 1000 })).id as string;
    const tl = await call("POST", "/api/timelines", {});
    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await call("POST", `/api/timelines/${tl.id}/render`, { clips: [{ id: c, input: { description: "She turns around.", mid: picture, midAt: 1.5 } }] });
    const graph = await finish(three!, 3);
    const guides = nodes(graph, "MiniMaxH3AddGuide");
    expect(guides).toHaveLength(1);
    // 1.5 s at 24 pictures a second
    expect(guides[0]!.inputs.frame_idx).toBe(36);
    expect(nodes(graph, "LoadImage")).toHaveLength(1);
    // the picture is among what the take was made from
    const made = (await view(tl.id)).clips[0].take.asset.id;
    const detail = (await get(t.app, `/api/assets/${made}`)).json();
    expect(detail.sources.map((x: { asset: { id: string } }) => x.asset.id)).toContain(picture);
  });

  it("holds a picture on screen as a still, and a clip after it opens on that picture", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Stills" });
    const picture = await upload(makePng(192, 320, [200, 120, 40], [40, 60, 160]), "image/png", "terrace.png");
    const added = await call("POST", `/api/timelines/${tl.id}/clips`, { asset: picture.id });
    expect(added.timeline.clips[0]).toMatchObject({ kind: "still", lengthMs: 3000, still: { id: picture.id }, take: null, recipe: null });
    expect(added.timeline.durationMs).toBe(3000);
    await call("PATCH", `/api/clips/${added.clip}`, { stillMs: 1500 });
    expect((await view(tl.id)).clips[0].lengthMs).toBe(1500);

    const c = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip;
    await render(tl.id, [{ id: c }]);
    const graph = await finish(three!, 1);
    // the clip opens on the picture: it is its first frame, no clip to join onto
    expect(nodes(graph, "LoadImage")).toHaveLength(1);
    expect(nodes(graph, "MiniMaxH3AddGuide")).toHaveLength(0);
    const v = await view(tl.id);
    expect(v.clips[1]).toMatchObject({ join: "fresh", atMs: 1500 });
    // the picture is replaced: the clip no longer follows it
    const other = await upload(makePng(192, 320, [10, 10, 10], [90, 90, 90]), "image/png", "night.png");
    await call("DELETE", `/api/clips/${added.clip}`);
    await call("POST", `/api/timelines/${tl.id}/clips`, { asset: other.id, after: null });
    expect((await view(tl.id)).clips[1].join).toBe("stale");

    const out = await exported(tl.id);
    expect(Math.abs(out.durationMs - 6000)).toBeLessThan(150);
    // a still can become a clip to render, opening on its picture
    const still = (await view(tl.id)).clips[0].id;
    await call("PATCH", `/api/clips/${still}`, { animate: true });
    expect((await view(tl.id)).clips[0]).toMatchObject({ kind: "video", recipe: "h3.video", inputs: { start: other.id }, still: null });
  });

  it.skipIf(!tone)("mixes a clip's sound file and the music into the export, and mutes what is muted", async () => {
    const { id, a, b } = await twoClips();
    const sound = await upload(tone!, "audio/wav", "tone.wav");
    expect(sound).toMatchObject({ kind: "audio", mime: "audio/wav", hasSound: true, name: "tone.wav" });
    expect(sound.durationMs).toBeGreaterThan(3900);
    await call("PATCH", `/api/clips/${a}`, { soundAsset: sound.id, volume: 50 });
    await call("PATCH", `/api/clips/${b}`, { sound: "muted", fill: true });
    await call("PATCH", `/api/timelines/${id}`, { music: { asset: sound.id, volume: 40, fadeInMs: 500, fadeOutMs: 500, duck: true } });
    const v = await view(id);
    expect(v.clips[0]).toMatchObject({ sound: "file", soundAsset: { id: sound.id }, volume: 50 });
    expect(v.clips[1]).toMatchObject({ sound: "muted", fill: true });
    expect(v.music).toMatchObject({ asset: { id: sound.id }, volume: 40, fadeInMs: 500, duck: true });
    const out = await exported(id);
    expect(out).toMatchObject({ hasSound: true });
    expect(Math.abs(out.durationMs - (6000 - 917))).toBeLessThan(120);
    // without the music, and with the music removed
    expect(await exported(id, { music: false })).toMatchObject({ hasSound: true });
    await call("PATCH", `/api/timelines/${id}`, { music: { asset: null } });
    expect((await view(id)).music).toBeNull();
    // a picture is not a sound
    const picture = await upload(makePng(64, 64, [1, 2, 3], [4, 5, 6]), "image/png", "p.png");
    expect((await t.app.inject({ method: "PATCH", url: `/api/clips/${a}`, payload: { soundAsset: picture.id } })).statusCode).toBe(400);
  });

  it("takes changes back one at a time, without losing what was rendered since", async () => {
    const { id, a, b } = await twoClips();
    expect((await view(id)).undo).toBe("the clip added");
    await call("PATCH", `/api/clips/${a}`, { trimEndMs: 1000 });
    await call("PATCH", `/api/clips/${b}`, { after: null });
    await call("DELETE", `/api/clips/${a}`);
    let v = await view(id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([b]);
    expect(v.undo).toBe("the clip removed");

    expect((await call("POST", `/api/timelines/${id}/undo`)).undone).toBe("the clip removed");
    v = await view(id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([b, a]);
    // the clip is back with its take and its length
    expect(v.clips[1]).toMatchObject({ lengthMs: 2000, take: { trimEndMs: 1000 } });
    await call("POST", `/api/timelines/${id}/undo`);
    expect((await view(id)).clips.map((c: { id: string }) => c.id)).toEqual([a, b]);

    // a take rendered after a change survives undoing that change, and goes on playing
    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    await render(id, [{ id: b }]);
    await finish(three!, 3);
    const playing = (await view(id)).clips[1].take.id;
    expect((await call("POST", `/api/timelines/${id}/undo`)).undone).toBe("the cut");
    v = await view(id);
    expect(v.clips[1]).toMatchObject({ joined: "continue", take: { id: playing } });
    expect(v.clips[1].takes).toHaveLength(2);
    // what is written in a clip's form in one go is one step, however many times it was saved on the way
    await call("PATCH", `/api/clips/${a}`, { inputs: { description: "Something" } });
    await call("PATCH", `/api/clips/${a}`, { inputs: { description: "Something else." } });
    expect((await view(id)).undo).toBe("the parameters of clip 1");
    await call("POST", `/api/timelines/${id}/undo`);
    v = await view(id);
    // the form was empty before (the test renders with its own words)
    expect(v.clips[0].inputs.description).toBeUndefined();
    expect(v.undo).toBe("the new duration");
  });

  it("shows a clip's frames side by side for the track, and takes videos from the computer", async () => {
    const { id } = await twoClips();
    const video = (await view(id)).clips[0].take.asset.id;
    const strip = await get(t.app, `/api/assets/${video}/strip`);
    expect(strip.statusCode).toBe(200);
    expect(strip.headers["content-type"]).toBe("image/jpeg");
    expect(strip.rawPayload.length).toBeGreaterThan(500);
    const own = await upload(three!, "video/mp4", "holiday.mp4");
    expect(own).toMatchObject({ kind: "video", origin: "uploaded", mime: "video/mp4", width: 192, height: 320, hasSound: true, kept: true });
    const c = (await call("POST", `/api/timelines/${id}/clips`, { asset: own.id })).timeline.clips[2];
    expect(c).toMatchObject({ kind: "video", recipe: null, joined: "cut", lengthMs: 3000 });
    expect((await t.app.inject({ method: "POST", url: "/api/assets", headers: { "content-type": "video/mp4" }, payload: Buffer.from([1, 2, 3, 4]) })).statusCode).toBe(400);
  });

  it("moves, removes and renames", async () => {
    const { id, a, b } = await twoClips();
    await call("PATCH", `/api/clips/${b}`, { after: null });
    expect((await view(id)).clips.map((c: { id: string }) => c.id)).toEqual([b, a]);
    const take = (await view(id)).clips[0].take.id;
    await call("DELETE", `/api/takes/${take}`);
    expect((await view(id)).clips[0].take).toBeNull();
    await call("DELETE", `/api/clips/${b}`);
    expect((await view(id)).clips.map((c: { id: string }) => c.id)).toEqual([a]);
    expect((await call("PATCH", `/api/timelines/${id}`, { name: "Night" })).name).toBe("Night");
    await call("DELETE", `/api/timelines/${id}`);
    expect((await get(t.app, `/api/timelines/${id}`)).statusCode).toBe(404);
    // the video of the take that was removed went to the bin with it; the one of the clip that was removed stays in the library
    expect((await get(t.app, "/api/assets?kind=video")).json().items).toHaveLength(1);
  });

  it("stops a clip's render from the timeline: nothing is added, the take it had still plays, and it is not called a failure", async () => {
    const { id, a } = await twoClips();
    const before = (await view(id)).clips[0].take.id as string;
    await render(id, [{ id: a }], "She turns round.");
    await until(() => fake.prompts.size === 3);
    const job = (await view(id)).clips[0].job as { id: string; status: string };
    expect(job.status).toBe("running");
    await call("POST", `/api/jobs/${job.id}/cancel`);
    await until(async () => (await view(id)).clips[0].job === null);
    const clip = (await view(id)).clips[0];
    expect(clip).toMatchObject({ job: null, failed: null });
    expect(clip.take.id).toBe(before);
    expect(clip.takes).toHaveLength(1);
    // ComfyUI was told to stop
    expect(fake.calls.some((c) => c.startsWith("POST /interrupt"))).toBe(true);
  });

  it("keeps a clip's conversation with the designer and what it is held with, without that being a change to undo", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Talk" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    const before = (await view(tl.id)).undo;
    await call("PATCH", `/api/clips/${clip}`, { designer: { llm: "big", instruction: "film" }, chat: [{ role: "user", content: "a walk" }] });
    expect((await view(tl.id)).clips[0]).toMatchObject({ designer: { llm: "big", instruction: "film" }, chat: [{ role: "user", content: "a walk" }] });
    // starting over empties the conversation and keeps what it is held with
    await call("PATCH", `/api/clips/${clip}`, { chat: [] });
    expect((await view(tl.id)).clips[0]).toMatchObject({ designer: { llm: "big", instruction: "film" }, chat: [] });
    expect((await view(tl.id)).undo).toBe(before);
  });

  it("sends the video of a removed take to the bin, brings both back with Undo, and leaves alone a video brought in from the library", async () => {
    const { id } = await twoClips();
    const videos = async () => ((await get(t.app, "/api/assets?kind=video")).json().items as Array<{ id: string }>).map((v) => v.id);
    const inBin = async (asset: string) => (await get(t.app, `/api/assets/${asset}`)).json().inBin as boolean;
    const take = (await view(id)).clips[1].take as { id: string; asset: { id: string } };
    expect(await videos()).toHaveLength(2);

    await call("DELETE", `/api/takes/${take.id}`);
    expect((await view(id)).clips[1].take).toBeNull();
    expect(await videos()).not.toContain(take.asset.id);
    expect(await inBin(take.asset.id)).toBe(true);

    // Undo: the take plays again, and its video is back in the library
    expect((await call("POST", `/api/timelines/${id}/undo`)).undone).toBe("the take removed");
    expect((await view(id)).clips[1].take.id).toBe(take.id);
    expect(await inBin(take.asset.id)).toBe(false);
    expect(await videos()).toContain(take.asset.id);

    // a video of one's own, put on the timeline: taking it off the timeline does not take it out of the library
    const own = await upload(three!, "video/mp4", "holiday.mp4");
    const mine = (await call("POST", `/api/timelines/${id}/clips`, { asset: own.id })).timeline.clips[2].take as { id: string };
    await call("DELETE", `/api/takes/${mine.id}`);
    expect(await inBin(own.id)).toBe(false);
    expect(await videos()).toContain(own.id);
  });

  it("lets a workflow that opens on a picture pick up from the last frame that plays", async () => {
    const found = (await post(t.app, "/api/workflows/inspect", wan)).json();
    const wf = (await post(t.app, "/api/workflows", { title: "Picture to video", model: "Wan 2.2", source: "wan.json", graph: found.graph, bindings: found.suggested })).json();
    const { id } = await twoClips();
    const c = (await call("POST", `/api/timelines/${id}/clips`, { recipe: wf.id })).clip;
    await call("POST", `/api/timelines/${id}/render`, { clips: [{ id: c, input: { prompt: "She waves." } }] });
    await finish(three!, 3);
    expect(fake.uploads.filter((u) => u.endsWith(".png"))).toHaveLength(1);
    const v = await view(id);
    expect(v.clips[2]).toMatchObject({ join: "fresh", take: { headMs: 0 } });
    const detail = (await get(t.app, `/api/assets/${v.clips[2].take.asset.id}`)).json();
    // made from the clip before, by way of its last frame, which is a picture of the library now
    const roles = Object.fromEntries(detail.sources.map((s: { role: string; asset: { id: string; origin: string } }) => [s.role, s.asset]));
    expect(roles.previous.id).toBe(v.clips[1].take.asset.id);
    expect(roles.start).toMatchObject({ kind: "image", origin: "frame", width: 192, height: 320 });

    // another take from the same frame does not add the picture again
    await call("POST", `/api/timelines/${id}/render`, { clips: [{ id: c, input: { prompt: "She waves." } }] });
    await finish(three!, 4);
    expect((await get(t.app, "/api/assets?kind=image")).json().items).toHaveLength(1);
  });
});

describe.skipIf(!three)("a clip made outside a timeline", () => {
  it("can carry on from any moment of a video in the library", async () => {
    const { id } = await twoClips();
    const source = (await view(id)).clips[0].take.asset.id;
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "He turns around.", previous: { asset: source, at: 1500 } } });
    const graph = await finish(three!, 3);
    expect(nodes(graph, "MiniMaxH3AddGuide")[0]!.inputs.frame_idx).toBe(0);
    // no timeline: the frame is the one of the clip it carries on from
    expect(nodes(graph, "MiniMaxH3ImageToVideo")[0]!.inputs).toMatchObject({ width: 192, height: 320 });
    const made = (await get(t.app, "/api/assets?kind=video")).json().items[0];
    expect((await get(t.app, `/api/assets/${made.id}`)).json().sources).toMatchObject([{ role: "previous", asset: { id: source } }]);
  });
});

describe.skipIf(!three || !silent)("a video of a person as a reference", () => {
  it("is its first seconds, small, at the model's speed; a silent one is no voice", async () => {
    const big = makeClip(5, { size: "640x1136" })!;
    const clip = await referenceClip(big, "mp4", { seconds: 3, fps: 24, short: 384 });
    expect(clip).toMatchObject({ width: 384, frames: 72, hasSound: true });
    expect(clip.height).toBeGreaterThan(600);
    expect((await readVideo(clip.bytes, "mp4")).facts).toMatchObject({ fps: 24, hasSound: true });
    // already small: it is not enlarged
    expect(await referenceClip(three!, "mp4", { seconds: 3, fps: 24, short: 384 })).toMatchObject({ width: 192, height: 320 });
    expect((await referenceClip(silent!, "mp4", { seconds: 3, fps: 24, short: 384 })).hasSound).toBe(false);
  });

  it("goes up to ComfyUI as that short clip when a render names it, and is part of how the result was made", async () => {
    await t.close();
    await fake.close().catch(() => {});
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { ...H3_FILES, diffusion_models: [...H3_FILES.diffusion_models, "minimax_h3_ref2va_fp8.safetensors"] } });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
    const video = (await t.app.inject({ method: "POST", url: "/api/assets?name=her.mp4", headers: { "content-type": "video/mp4" }, payload: Buffer.from(makeClip(5, { size: "640x1136" })!) })).json();
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=p.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 64, [1, 2, 3], [4, 5, 6])) })).json();
    // a picture is not a video
    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "She waves.", refVideos: [{ asset: picture.id, role: "person" }] } });
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("status", "=", "failed").execute()).length === 1);
    expect((await t.db.selectFrom("jobs").select("error").where("status", "=", "failed").executeTakeFirstOrThrow()).error).toMatch(/reference video is no longer/);

    await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "She waves.", refVideos: [{ asset: video.id, role: "person" }] } });
    const graph = await finish(three!, 1);
    const node = nodes(graph, "MiniMaxH3ReferenceToVideo")[0]!;
    expect(Object.keys(node.inputs)).toEqual(expect.arrayContaining(["ref_videos.ref_video_0", "ref_video_audios.ref_video_audio_0"]));
    expect(String(node.inputs.prompt)).toContain("<Subject 1> is the character in <Video 1>.");
    // it went up as a video of its own (the short clip that was cut from it)
    const sent = String(nodes(graph, "LoadVideo")[0]!.inputs.file).replace(" [temp]", "");
    expect(sent).toMatch(/\.mp4$/);
    expect(fake.uploads).toContain(sent);
    const made = (await get(t.app, "/api/assets?kind=video")).json().items.find((a: { id: string }) => a.id !== video.id);
    expect((await get(t.app, `/api/assets/${made.id}`)).json().sources).toMatchObject([{ role: "person", asset: { id: video.id } }]);
  });
});

describe.skipIf(!three)("a clip's take, trimmed on the timeline", () => {
  it("splits into two clips at a moment, both playing from the same video", async () => {
    const tl = await call("POST", "/api/timelines", { name: "Split" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await render(tl.id, [{ id: a }]);
    await finish(three!, 1);
    const { clip: b } = await call("POST", `/api/clips/${a}/split`, { atMs: 1500 });
    const v = await view(tl.id);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([a, b]);
    const [first, second] = v.clips;
    expect(first.take.asset.id).toBe(second.take.asset.id);
    expect(first.take.endMs).toBeCloseTo(1500, -1);
    expect(second.take.startMs).toBeCloseTo(1500, -1);
    expect(first.lengthMs + second.lengthMs).toBeCloseTo(3000, -2);
    expect(second.recipe).toBe("h3.video");
    expect(second.joined).toBe("cut");
    // outside the part that plays: refused
    const bad = await t.app.inject({ method: "POST", url: `/api/clips/${a}/split`, payload: { atMs: 2900 } });
    expect(bad.statusCode).toBe(400);
    // undo takes the split back
    await call("POST", `/api/timelines/${tl.id}/undo`);
    expect((await view(tl.id)).clips).toHaveLength(1);
  });

  /** Two clips of three seconds, both rendered, as cuts. */
  async function twoRendered() {
    const tl = await call("POST", "/api/timelines", { name: "Range" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await call("PATCH", `/api/clips/${a}`, { inputs: { description: "She walks to the window." } });
    await render(tl.id, [{ id: a }]);
    await finish(three!, 1);
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await call("PATCH", `/api/clips/${b}`, { joined: "cut" });
    await render(tl.id, [{ id: b }]);
    await finish(three!, 2);
    expect((await view(tl.id)).durationMs).toBeCloseTo(6000, -2);
    return { tl: tl.id as string, a, b };
  }

  it("a range across two clips: split at In and Out, remove it, Undo each", async () => {
    const { tl, a, b } = await twoRendered();
    await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 4000, action: "split" });
    let v = await view(tl);
    expect(v.clips).toHaveLength(4);
    expect(v.clips.map((c: { lengthMs: number }) => Math.round(c.lengthMs / 100) * 100)).toEqual([1000, 2000, 1000, 2000]);
    expect(v.clips[0].id).toBe(a);
    expect(v.clips[2].id).toBe(b);
    expect(v.durationMs).toBeCloseTo(6000, -2);
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips).toHaveLength(2);
    // both on cuts already: refused
    const bad = await t.app.inject({ method: "POST", url: `/api/timelines/${tl}/range`, payload: { inMs: 0, outMs: 3000, action: "split" } });
    expect(bad.statusCode).toBe(400);

    await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 4000, action: "remove" });
    v = await view(tl);
    expect(v.clips).toHaveLength(2);
    expect(v.durationMs).toBeCloseTo(3000, -2);
    expect(v.clips[0].lengthMs).toBeCloseTo(1000, -2);
    // the second clip now starts a second in
    expect(v.clips[1].take.startMs).toBeCloseTo(1000, -2);
    expect(v.undo).toBe("the range removed");
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).durationMs).toBeCloseTo(6000, -2);

    // a range inside one clip: the rest of that clip stays, as a clip of its own
    await call("POST", `/api/timelines/${tl}/range`, { inMs: 1000, outMs: 2000, action: "remove" });
    v = await view(tl);
    expect(v.clips).toHaveLength(3);
    expect(v.clips.map((c: { lengthMs: number }) => Math.round(c.lengthMs / 100) * 100)).toEqual([1000, 1000, 3000]);
    expect(v.clips[0].take.asset.id).toBe(v.clips[1].take.asset.id);
  });

  it("regenerates a range: a new clip pinned to the frame before In and the frame at Out, in place of what played", async () => {
    const { tl, a, b } = await twoRendered();
    const { clip } = await call("POST", `/api/timelines/${tl}/range`, { inMs: 2000, outMs: 4000, action: "regenerate" });
    const v = await view(tl);
    expect(v.clips.map((c: { id: string }) => c.id)).toEqual([a, clip, b]);
    const made = v.clips[1];
    expect(made.recipe).toBe("h3.video");
    expect(made.take).toBeNull();
    expect(made.joined).toBe("cut");
    expect(made.inputs.description).toBe("She walks to the window.");
    expect(made.inputs.seconds).toBe(2);
    // the frames are pictures in the library, from the right moments
    const first = (await get(t.app, `/api/assets/${made.inputs.start}`)).json();
    const last = (await get(t.app, `/api/assets/${made.inputs.end}`)).json();
    expect(first.kind).toBe("image");
    expect(last.kind).toBe("image");
    expect(first.source).toMatchObject({ asset: { id: v.clips[0].take.asset.id } });
    expect(last.source).toMatchObject({ asset: { id: v.clips[2].take.asset.id } });
    // what played between went: the first clip stops at 2 s, the second starts a second in
    expect(v.clips[0].lengthMs).toBeCloseTo(2000, -2);
    expect(v.clips[2].take.startMs).toBeCloseTo(1000, -2);
    expect(v.undo).toBe("the regenerated range");
    await call("POST", `/api/timelines/${tl}/undo`);
    expect((await view(tl)).clips).toHaveLength(2);

    // In = Out on the cut: a clip between the two, nothing removed
    const between = (await call("POST", `/api/timelines/${tl}/range`, { inMs: 3000, outMs: 3000, action: "regenerate" })).clip;
    const w = await view(tl);
    expect(w.clips.map((c: { id: string }) => c.id)).toEqual([a, between, b]);
    expect(w.durationMs).toBeCloseTo(6000, -2);
    expect(w.clips[1].inputs.start).toBeTruthy();
    expect(w.clips[1].inputs.end).toBeTruthy();
    expect(w.undo).toBe("the clip added between");
  });

  it("copies a range to the library: one video of that part, through the export queue", async () => {
    const { tl } = await twoRendered();
    const { job } = await call("POST", `/api/timelines/${tl}/range`, { inMs: 2000, outMs: 4000, action: "copy" });
    expect(job).toBeTruthy();
    await until(async () => ((await get(t.app, "/api/jobs")).json().items as Array<{ id: string; status: string }>).some((j) => j.id === job && j.status === "done"), 60_000);
    const items = (await get(t.app, "/api/assets?kind=video")).json().items as Array<{ name: string; durationMs: number }>;
    const copy = items.find((x) => /0:02–0:04/.test(x.name));
    expect(copy).toBeTruthy();
    expect(copy!.durationMs).toBeGreaterThan(1700);
    expect(copy!.durationMs).toBeLessThan(2400);
  });
});
