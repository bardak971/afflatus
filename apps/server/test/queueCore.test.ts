import { readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyLost } from "@afflatus/comfy";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { openSqlite } from "../src/db";
import type { QueueCore, Resume } from "../src/queueModel";
import { store } from "../src/queueStore";
import { awaitPrompt } from "../src/queueTools";
import { CHECKPOINT, complete, FAST, get, job, makeApp, makeFake, png, post, until, type TestApp } from "./helpers";

let fake: FakeComfy;
let t: TestApp;

beforeEach(async () => {
  fake = await makeFake();
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const statusOf = async (id: string) => t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const submitted = () => [...fake.prompts.keys()];
const INPUT = { prompt: "a cat", checkpoint: CHECKPOINT };

describe("cancelling a job that waits", () => {
  it("fails the jobs that continue from it, and those that continue from them, as stopping a running one does", async () => {
    await post(t.app, "/api/queue/pause");
    const first = await enqueue();
    const second = await t.services.queue.enqueue("sdxl.text-to-picture", INPUT, { dependsOn: first });
    const third = await t.services.queue.enqueueCut({ asset: "nope", startMs: 0, endMs: 1000, action: "copy" }, "a cut after", { dependsOn: second });
    expect((await post(t.app, `/api/jobs/${first}/cancel`)).statusCode).toBe(200);
    expect((await statusOf(first)).status).toBe("cancelled");
    for (const id of [second, third]) expect(await statusOf(id)).toMatchObject({ status: "failed", error: "the clip it continues was not rendered" });
  });
});

describe("a job done again", () => {
  it("keeps the take it finishes: a retried finish is still a finish", async () => {
    await post(t.app, "/api/queue/pause");
    const id = await t.services.queue.enqueue("sdxl.text-to-picture", INPUT, { finishedFrom: "take-1" });
    await post(t.app, `/api/jobs/${id}/cancel`);
    const again = (await post(t.app, `/api/jobs/${id}/retry`, {})).json().id as string;
    expect(again).not.toBe(id);
    expect((await statusOf(again)).finished_from).toBe("take-1");
  });
});

describe("a tool's prompt that ComfyUI lost", () => {
  it("fails at once instead of holding the line for hours", async () => {
    const comfy = await t.services.comfy();
    const started = Date.now();
    // in neither its queue nor its history: gone with a restart of ComfyUI
    await expect(awaitPrompt(comfy, "lost-prompt", "1", new AbortController().signal, FAST.wait)).rejects.toBeInstanceOf(ComfyLost);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("what waits for ComfyUI and what does not", () => {
  it("a pause holds a finish on the GPU, not a cut by ffmpeg", async () => {
    await post(t.app, "/api/queue/pause");
    const finish = await t.services.queue.enqueueCut({ asset: "nope", startMs: 0, endMs: 1000, action: "finish" }, "a finish");
    const cut = await t.services.queue.enqueueCut({ asset: "nope", startMs: 0, endMs: 1000, action: "copy" }, "a cut");
    // the cut ran (its video is not there: it fails) while the finish ahead of it waits for the end of the pause
    await until(async () => (await statusOf(cut)).status === "failed");
    // the queue has gone through its line again since, and left the finish waiting
    await t.services.queue.idle();
    expect((await statusOf(finish)).status).toBe("queued");
    await post(t.app, "/api/queue/resume");
    await until(async () => (await statusOf(finish)).status === "failed");
    expect((await statusOf(finish)).error).toContain("no longer in your library");
  });

  it("an export goes on while ComfyUI is away, though a render waits before it", async () => {
    await fake.close();
    const render = await enqueue();
    const exported = await t.services.queue.enqueueExport({ timeline: "nope", scale: 1, music: false }, "an export");
    await until(async () => (await statusOf(exported)).status !== "queued");
    expect((await statusOf(render)).status).toBe("queued");
    expect((await get(t.app, "/api/queue")).json().online).toBe(false);
  });
});

describe("a render's result that cannot be filed", () => {
  it("leaves no file behind in storage, and no row", async () => {
    const core = (t.services.queue as unknown as { core: QueueCore }).core;
    const comfy = await t.services.comfy();
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    fake.files["made.png"] = png(64, 64);
    // a recipe the database refuses (no family, a column that cannot be empty): the rows cannot be written, after the file was stored
    const resume = { promptId: "p", seed: 1, outputs: [{ node: "9", role: "result", kind: "image" }], totalSteps: 1, phases: {}, loads: [], startedAt: Date.now() } as unknown as Resume;
    const outputs = { "9": { images: [{ filename: "made.png", subfolder: "", type: "temp" }] } };
    await expect(store(core, comfy, { ...recipe, family: null } as never, INPUT, resume, outputs as never, { id: "job", draft_id: null, folder_id: null, look: null })).rejects.toThrow();
    const files = readdirSync(t.dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.map((f) => f.name)).toEqual([]);
    expect(await t.db.selectFrom("assets").select("id").execute()).toEqual([]);
    expect(await t.db.selectFrom("generations").select("id").execute()).toEqual([]);
  });
});

describe("a render one of whose sources was erased while it rendered", () => {
  it("is filed all the same, its lineage naming only the sources still there", async () => {
    const core = (t.services.queue as unknown as { core: QueueCore }).core;
    const comfy = await t.services.comfy();
    const recipe = t.services.registry.recipe("sdxl.text-to-picture")!;
    fake.files["made.png"] = png(64, 64);
    // a neighbour video or an opening frame chosen at submit, erased since: its row is gone
    const resume = { promptId: "p", seed: 1, outputs: [{ node: "9", role: "result", kind: "image" }], totalSteps: 1, phases: {}, loads: [], startedAt: Date.now(), sources: [{ asset: "not-there", role: "init" }] } as unknown as Resume;
    const outputs = { "9": { images: [{ filename: "made.png", subfolder: "", type: "temp" }] } };
    const generation = (await store(core, comfy, recipe, INPUT, resume, outputs as never, { id: "job", draft_id: null, folder_id: null, look: null })).id;
    expect(await t.db.selectFrom("assets").select("id").where("generation_id", "=", generation).execute()).toHaveLength(1);
    expect(await t.db.selectFrom("generation_inputs").selectAll().where("generation_id", "=", generation).execute()).toEqual([]);
  });
});

describe("a result filed just before the process died, its prompt since forgotten by ComfyUI", () => {
  it("is closed with what it filed, not rendered again", async () => {
    const db = openSqlite(":memory:");
    const first = await makeApp({ db, comfyUrl: fake.url });
    await first.services.queue.start();
    const id = (await post(first.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    first.services.queue.stop();
    await first.services.queue.idle();
    await first.app.close();
    const was = await db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    await db.updateTable("jobs").set({ status: "running", finished_at: null }).where("id", "=", id).execute();
    // ComfyUI restarted meanwhile: the prompt is in neither its queue nor its history
    fake.history = {};
    fake.pending = [];

    const second = await makeApp({ db, dir: first.dir, comfyUrl: fake.url });
    await second.services.queue.start();
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    expect((await db.selectFrom("jobs").select("generation_id").where("id", "=", id).executeTakeFirstOrThrow()).generation_id).toBe(was.generation_id);
    expect(submitted()).toHaveLength(1);
    expect(await db.selectFrom("generations").select("id").execute()).toHaveLength(1);
    await second.close();
  });
});

describe("what went less well in a job that finished", () => {
  it("is said on the job, in the queue and in its history", async () => {
    // a clip render whose take cannot be placed (the clip's timeline went wrong meanwhile): the render is no failure for it
    const clips = t.services.timelines as unknown as { plan: () => Promise<null>; finished: () => Promise<void> };
    clips.plan = async () => null;
    clips.finished = async () => {
      throw new Error("the clip is gone");
    };
    const id = await t.services.queue.enqueue("sdxl.text-to-picture", INPUT, { clip: { id: "clip-1", fit: false } });
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    expect((await statusOf(id)).warning).toBe("Its take was not placed on its clip: the clip is gone");
    expect((await get(t.app, "/api/queue")).json().recent[0]).toMatchObject({ id, status: "done", warning: "Its take was not placed on its clip: the clip is gone" });
    expect((await get(t.app, "/api/jobs")).json().items[0]).toMatchObject({ id, warning: "Its take was not placed on its clip: the clip is gone" });
  });
});

describe("the queue's history, searched", () => {
  it("finds a prompt and a model whatever their case", async () => {
    const id = await enqueue({ prompt: "A Red Fox" });
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    for (const q of ["red fox", "RED FOX", "A Red Fox"]) expect((await get(t.app, `/api/jobs?q=${encodeURIComponent(q)}`)).json().items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await get(t.app, "/api/jobs?model=ILLUSTRIOUS")).json().items).toHaveLength(1);
  });
});
