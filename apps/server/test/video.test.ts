import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@studai/comfy/testing";
import { wan } from "../../../packages/workflows/test/fixtures";
import { readVideo, tools } from "../src/video";
import { get, makeApp, makeFake, post, until, type TestApp } from "./helpers";

/** A two-second test clip with a tone, made with ffmpeg. These tests are skipped where ffmpeg is not installed. */
function makeClip(sound: boolean): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "studai-clip-"));
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
