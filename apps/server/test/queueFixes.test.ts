import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComfyUnreachable } from "@afflatus/comfy";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { newId, now, OWNER } from "../src/db";
import { CHECKPOINT, complete, get, job, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * The queue and the timeline edits it meets: a failed render that says where it failed, a lost render that is not rendered
 * twice, a finish that is the clip's job, Undo against a take that lands, and what a video that cannot be read is refused with.
 */

const FILES = {
  checkpoints: [CHECKPOINT, "other.safetensors"],
  diffusion_models: ["minimax_h3_fl2va_fp8.safetensors"],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: ["minimax_h3_turbo_lora.safetensors"],
  upscale_models: [],
};

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: FILES });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
});

const statusOf = async (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const submitted = () => [...fake.prompts.keys()];
const call = async (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await t.app.inject({ method, url, payload: payload as object });
  if (res.statusCode >= 400) throw new Error(`${method} ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

/** A video row of the library, kept, with `bytes` as its file; no size or length, as a file nothing could read yet. */
async function video(name: string, bytes = new Uint8Array([1, 2, 3, 4]), facts: { width?: number; height?: number; duration_ms?: number } = {}) {
  const id = newId();
  const at = now();
  const key = `assets/${id.slice(0, 2)}/${id}.mp4`;
  await t.services.storage.put(key, bytes);
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind: "video", origin: "uploaded", name, file_key: key, thumb_key: null, mime: "video/mp4", bytes: bytes.length,
    width: facts.width ?? null, height: facts.height ?? null, duration_ms: facts.duration_ms ?? null, fps: 24, has_sound: 0, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
  } as never).execute();
  return id;
}

describe("a render that fails in a ComfyUI node", () => {
  it("says the node, its type and the exception's class, keeps the traceback's end, and says it in the log", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => submitted().length === 1);
    const promptId = submitted()[0]!;
    fake.history[promptId] = { status: { status_str: "error", messages: [["execution_error", {
      prompt_id: promptId, node_id: "3", node_type: "KSampler", exception_type: "torch.OutOfMemoryError", exception_message: "Allocation on device",
      traceback: ["Traceback (most recent call last):\n", "  File \"execution.py\", line 496, in execute\n", "torch.OutOfMemoryError: Allocation on device\n"],
    }]] } };
    await until(async () => (await statusOf(id)).status === "failed");
    const row = await statusOf(id);
    expect(row.error).toBe("KSampler #3: torch.OutOfMemoryError: Allocation on device");
    expect(row.error_trace).toMatch(/^Traceback[\s\S]*Allocation on device$/);
    const failed = (await get(t.app, "/api/jobs?status=failed")).json().items[0];
    expect(failed).toMatchObject({ id, trace: row.error_trace });
    // one line that finds it again: the job, its prompt, its recipe
    expect(said.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining(`job ${id} failed (prompt ${promptId}, sdxl.text-to-picture): KSampler #3`));
  });
});

describe("a render lost from sight after ComfyUI made it", () => {
  it("is followed again by its prompt on the next attempt, not rendered a second time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const comfy = await t.services.comfy();
    const view = comfy.client.view.bind(comfy.client);
    let first = true;
    // its file could not be fetched once: ComfyUI did not answer just then
    comfy.client.view = async (file) => {
      if (first) {
        first = false;
        throw new ComfyUnreachable("ComfyUI did not answer");
      }
      return view(file);
    };
    const id = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    expect(first).toBe(false);
    expect(submitted()).toHaveLength(1);
  });
});

describe("a video a render is handed that cannot be read", () => {
  it("is refused with the reason, not as ffmpeg missing, and nothing is sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = await video("zz-test broken");
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "He turns around.", previous: { asset: broken, at: 1000 } } })).json().ids[0] as string;
    await until(async () => (await statusOf(id)).status === "failed");
    const { error } = await statusOf(id);
    expect(error).toMatch(/^The clip before could not be read for the join: "ffprobe" could not read this video \(exit code \d+\)/);
    expect(error).not.toMatch(/was not found|needs ffmpeg/);
    expect(submitted()).toEqual([]);
  });
});

describe("Finish", () => {
  it("is the clip's job: the editor shows the clip busy, and a second Finish asked at once skips it", async () => {
    await post(t.app, "/api/queue/pause");
    const draft = await video("zz-test draft", undefined, { width: 192, height: 320, duration_ms: 3000 });
    const tl = await call("POST", "/api/timelines", { name: "zz-test finish" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: draft })).clip as string;
    const body = { route: "seedvr", factor: 2 };
    const [a, b] = await Promise.all([call("POST", `/api/timelines/${tl.id}/finish`, body), call("POST", `/api/timelines/${tl.id}/finish`, body)]);
    expect([...a.jobs, ...b.jobs]).toHaveLength(1);
    expect([...a.skipped, ...b.skipped]).toEqual([{ clip: 1, why: "a render or a finish is on its way" }]);
    expect((await statusOf([...a.jobs, ...b.jobs][0])).clip_id).toBe(clip);
    const v = (await get(t.app, `/api/timelines/${tl.id}`)).json();
    expect(v.clips[0].job).toMatchObject({ status: "queued" });
  });
});

describe("a take a finished take was made from", () => {
  it("cannot be removed while the finished take is there", async () => {
    const draft = await video("zz-test draft", undefined, { width: 192, height: 320, duration_ms: 3000 });
    const done = await video("zz-test finished", undefined, { width: 384, height: 640, duration_ms: 3000 });
    const tl = await call("POST", "/api/timelines", { name: "zz-test draft" });
    const clip = (await call("POST", `/api/timelines/${tl.id}/clips`, { asset: draft })).clip as string;
    const from = (await t.db.selectFrom("takes").select("id").where("clip_id", "=", clip).executeTakeFirstOrThrow()).id;
    await t.services.timelines.takes.takeFrom(clip, (await t.db.selectFrom("assets").selectAll().where("id", "=", done).executeTakeFirstOrThrow()), "the finished take", from);
    const refused = await t.app.inject({ method: "DELETE", url: `/api/takes/${from}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/draft of a finished take/);
    expect(await t.db.selectFrom("takes").select("id").where("id", "=", from).executeTakeFirst()).toBeTruthy();
  });
});

describe("Undo", () => {
  it("never leaves a take that lands meanwhile not playing, nor deletes it", async () => {
    const timelines = t.services.timelines;
    for (let hops = 0; hops < 160; hops += 1) {
      const v = await timelines.create(`zz-test race ${hops}`);
      const clip = await timelines.addClip(v.id, {});
      await timelines.editClip(clip, { fill: true });
      // a render's result: a generation and its video
      const generation = newId();
      await t.db.insertInto("generations").values({ id: generation, owner_id: OWNER, recipe_id: "h3.video", recipe_version: 1, family: "h3", inputs: "{}", resolved: "{}", gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
      const made = await video(`zz-test take ${hops}`, undefined, { width: 192, height: 320, duration_ms: 3000 });
      await t.db.updateTable("assets").set({ generation_id: generation }).where("id", "=", made).execute();
      await Promise.all([
        timelines.history.undo(v.id),
        (async () => {
          for (let i = 0; i < hops; i++) await Promise.resolve();
          await timelines.finished(clip, generation, undefined, {});
        })(),
      ]);
      const row = await t.db.selectFrom("clips").selectAll().where("id", "=", clip).executeTakeFirst();
      const takes = await t.db.selectFrom("takes").select("id").where("clip_id", "=", clip).execute();
      expect({ hops, playing: Boolean(row?.take_id && takes.some((x) => x.id === row.take_id)) }).toEqual({ hops, playing: true });
    }
  });

  it("keeps what was said to the designer, and with which model", async () => {
    const timelines = t.services.timelines;
    const v = await timelines.create("zz-test chat");
    const clip = await timelines.addClip(v.id, {});
    await timelines.editClip(clip, { fill: true });
    // said after the step was kept: no step of its own
    await timelines.editClip(clip, { chat: [{ role: "user", content: "a fox" }, { role: "assistant", content: "A red fox runs." }], designer: { llm: "local" } } as never);
    await timelines.history.undo(v.id);
    const row = await t.db.selectFrom("clips").select(["chat", "designer", "fill"]).where("id", "=", clip).executeTakeFirstOrThrow();
    expect(row.fill).toBe(0);
    expect(JSON.parse(row.chat!)).toHaveLength(2);
    expect(JSON.parse(row.designer!)).toEqual({ llm: "local" });
    await timelines.history.redo(v.id);
    expect(JSON.parse((await t.db.selectFrom("clips").select("chat").where("id", "=", clip).executeTakeFirstOrThrow()).chat!)).toHaveLength(2);
  });
});

/** A one-second test clip made with ffmpeg; null where ffmpeg is not installed. */
function makeClip(): Uint8Array<ArrayBuffer> | null {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-clip-"));
  const file = join(dir, "clip.mp4");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=16:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  const bytes = made.status === 0 ? new Uint8Array(readFileSync(file)) : null;
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}
const clipBytes = makeClip();

describe("a render's prompt", () => {
  it("is followed from before it is sent, so that what ComfyUI says at once is not missed", async () => {
    const comfy = await t.services.comfy();
    const submit = comfy.client.submit.bind(comfy.client);
    const followed: boolean[] = [];
    comfy.client.submit = async (graph, opts = {}) => {
      followed.push(Boolean(opts.promptId && comfy.monitor.measured(opts.promptId)));
      return submit(graph, opts);
    };
    const id = (await post(t.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    expect(followed).toEqual([true]);
  });
});

describe.skipIf(!clipBytes)("a finish stopped by a restart", () => {
  it("follows the prompt ComfyUI still has instead of running it on the GPU again", async () => {
    t.services.queue.stop();
    await t.services.queue.idle();
    const draft = await video("zz-test draft", clipBytes!, { width: 64, height: 64, duration_ms: 1000 });
    // the prompt the first run sent, which ComfyUI finished while this process was down
    fake.files["done.mp4"] = clipBytes!;
    fake.history["sent-before"] = { status: { completed: true }, outputs: { "99": { gifs: [{ filename: "done.mp4", subfolder: "", type: "temp" }] } } };
    const id = newId();
    const at = now();
    await t.db.insertInto("jobs").values({
      id, owner_id: OWNER, recipe_id: "afflatus.cut", label: "zz-test finish", status: "running", warm: 0, look: null, priority: 20, depends_on: null, attempts: 1,
      inputs: JSON.stringify({ asset: draft, startMs: 0, endMs: 1000, action: "finish", route: "model", by: 2, upscaleModel: "x2.pth" }),
      resume: JSON.stringify({ promptId: "sent-before" }), error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: null, draft_id: null, folder_id: null,
      finished_from: null, created_at: at, started_at: at, finished_at: null, updated_at: at,
    } as never).execute();
    const again = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    await again.services.queue.start();
    await until(async () => ["done", "failed"].includes((await statusOf(id)).status), 20_000);
    expect((await statusOf(id)).error).toBeNull();
    expect(submitted()).toEqual([]);
    again.services.queue.stop();
    await again.services.queue.idle();
    await again.app.close();
  });
});

describe("what a video's measures are kept in", () => {
  it("is measured again when the kept file was cut short, and the same frame asked twice at once is one picture", async () => {
    if (!clipBytes) return;
    const id = await video("zz-test measured", clipBytes, { width: 64, height: 64, duration_ms: 1000 });
    await t.services.storage.put(`motion/${id.slice(0, 2)}/${id}.json`, new TextEncoder().encode("{\"rate\":10,\"val"));
    expect((await t.services.timelines.media.motion(id)).values.length).toBeGreaterThan(0);
    const row = await t.db.selectFrom("assets").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    const [a, b] = await Promise.all([t.services.timelines.media.frame(row, 500, true), t.services.timelines.media.frame(row, 500, true)]);
    expect(a.id).toBe(b.id);
  });
});
