import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import type { Graph } from "@afflatus/core";
import { FFMPEG_TIMEOUT, ffmpegThere, patternClip, toneFile } from "./clipKit";
import { get, makeApp, referenceCatalog, sentView, until, withTakes, type TestApp } from "./helpers";

/**
 * What the timeline tests share (timelines, timelineEdits and timelineRanges.test.ts, split so that they run side by side):
 * an app on a pretend ComfyUI that has MiniMax H3's files, made again for each test, the clips they render, and the steps
 * of a render.
 */

export const H3_FILES = {
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  frame_interpolation: ["rife49.pth"],
  checkpoints: [],
};

/** The clips a timeline test renders with, made once for its file. */
export interface Clips {
  /** Three seconds at 24 a second, with a tone. */
  three: Uint8Array;
  /** Three seconds at 48 a second (as smoothed to twice the speed). */
  smooth: Uint8Array;
  /** Two seconds, no sound. */
  silent: Uint8Array;
  /** A four-second tone, as a sound file. */
  tone: Uint8Array;
}

/** The app and the pretend ComfyUI of the test running, and the clips of the file, as the hooks set them. */
export interface Suite {
  fake: FakeComfy;
  t: TestApp;
  clips: Clips;
}

/** Registers the file's hooks: the clips once, an app and a pretend ComfyUI per test. */
/** `models`: the files the pretend ComfyUI lists (H3's by default; another family's for its own timeline tests). */
export function timelineSuite(models: Record<string, string[]> = H3_FILES): Suite {
  const s = {} as Suite;
  beforeAll(async () => {
    // where ffmpeg is not installed the tests that need them are skipped
    if (!ffmpegThere) return;
    const [three, smooth, silent, tone] = await Promise.all([patternClip(3), patternClip(3, { fps: 48 }), patternClip(2, { sound: false }), toneFile(4)]);
    s.clips = { three, smooth, silent, tone };
  }, FFMPEG_TIMEOUT);
  beforeEach(async () => {
    s.fake = await startFakeComfy({ catalog: referenceCatalog(), models });
    s.t = await makeApp({ comfyUrl: s.fake.url });
    await s.t.services.queue.start();
  });
  afterEach(async () => {
    await s.t.close();
    await s.fake.close().catch(() => {});
  });
  return s;
}

/** How many frames a video has, counted by ffprobe. */
export function frames(bytes: Uint8Array): number {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-count-"));
  const file = join(dir, "v.mp4");
  writeFileSync(file, bytes);
  const out = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return Number(out.stdout.trim());
}

export const nodes = (graph: Graph, cls: string) => Object.values(graph).filter((n) => n.class_type === cls);

/** The steps of a timeline test, on the suite's app and pretend ComfyUI. */
export function timelineSteps(s: Suite) {
  const call = async (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await s.t.app.inject({ method, url, payload: payload as object });
    if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
    return sentView(res.json());
  };
  const view = async (id: string) => withTakes((await get(s.t.app, `/api/timelines/${id}`)).json());
  const prompts = () => [...s.fake.prompts.entries()];

  /** Let the pretend ComfyUI finish the latest prompt with this video. */
  async function finish(bytes: Uint8Array, count: number) {
    // the job before may still be filing its result (ffmpeg): the next prompt comes when it is done
    await until(() => s.fake.prompts.size === count, 20_000);
    const [promptId, graph] = prompts().at(-1)!;
    const out = Object.entries(graph).find(([, n]) => /VideoCombine/.test(n.class_type))![0];
    s.fake.files[`${promptId}.mp4`] = bytes;
    s.fake.pending = s.fake.pending.filter((p) => p !== promptId);
    s.fake.history[promptId] = { status: { completed: true }, outputs: { [out]: { gifs: [{ filename: `${promptId}.mp4`, subfolder: "", type: "temp" }] } } };
    await until(async () => (await s.t.db.selectFrom("jobs").select("status").where("status", "in", ["queued", "running"]).execute()).length === 0 || s.fake.prompts.size > count, 20_000);
    return graph;
  }

  const render = (timeline: string, clips: Array<{ id: string; fit?: boolean }>, description = "She walks to the window.") =>
    call("POST", `/api/timelines/${timeline}/render`, { clips: clips.map((c) => ({ ...c, input: { description } })) });

  /** A timeline with two clips, the second carrying on from the first, both rendered. */
  async function twoClips() {
    const tl = await call("POST", "/api/timelines", { name: "Evening" });
    const a = (await call("POST", `/api/timelines/${tl.id}/clips`, { recipe: "h3.video" })).clip as string;
    await render(tl.id, [{ id: a }]);
    const first = await finish(s.clips.three, 1);
    const b = (await call("POST", `/api/timelines/${tl.id}/clips`, {})).clip as string;
    await render(tl.id, [{ id: b }]);
    const second = await finish(s.clips.three, 2);
    return { id: tl.id as string, a, b, first, second };
  }

  /** Ask for an export and wait for the queue to finish it. */
  async function exported(id: string, opts: Record<string, unknown> = {}) {
    await call("POST", `/api/timelines/${id}/export`, opts);
    await until(async () => (await view(id)).exporting === null, 20_000);
    const v = await view(id);
    if (v.exportFailed) throw new Error(v.exportFailed);
    return v.exported;
  }

  return { call, view, prompts, finish, render, twoClips, exported };
}
