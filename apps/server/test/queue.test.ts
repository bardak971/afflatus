import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { openSqlite, OWNER } from "../src/db";
import { complete, get, job, makeApp, makeFake, post, until, type TestApp } from "./helpers";

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

const queue = async () => (await get(t.app, "/api/queue")).json();
const statusOf = async (id: string) => (await t.db.selectFrom("jobs").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
const enqueue = async (over: Record<string, unknown> = {}) => (await post(t.app, "/api/jobs", job(over))).json().ids[0] as string;
const submitted = () => [...fake.prompts.keys()];

describe("a job from start to finish", () => {
  it("renders, files the picture in the library and records how it was made", async () => {
    const id = await enqueue({ steps: 20 });
    await until(() => submitted().length === 1);
    expect((await queue()).running).toMatchObject({ id, status: "running", phase: "waiting" });

    complete(fake, submitted()[0]!, 832, 1216);
    await until(async () => (await statusOf(id)).status === "done");

    const { items } = (await get(t.app, "/api/assets")).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "image", origin: "generated", mime: "image/png", width: 832, height: 1216, kept: false, inBin: false });

    const detail = (await get(t.app, `/api/assets/${items[0].id}`)).json();
    expect(detail.generation).toMatchObject({ recipe: "sdxl.text-to-picture", family: "sdxl", inputs: { prompt: "a cat", steps: 20 } });
    // the seed that was really used is recorded, never the "random" marker
    expect(detail.generation.resolved.seed).toBeGreaterThanOrEqual(0);
    const graph = fake.prompts.get(submitted()[0]!)!;
    const sampler = Object.values(graph).find((n) => n.class_type === "KSampler")!;
    expect(sampler.inputs.seed).toBe(detail.generation.resolved.seed);

    const file = await get(t.app, `/api/assets/${items[0].id}/file`);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.rawPayload.length).toBe(33);
  });

  it("asks for live previews and frees ComfyUI's memory only when the model changes", async () => {
    const run = async (over: Record<string, unknown>) => {
      const id = await enqueue(over);
      const n = submitted().length;
      await until(() => submitted().length === n + 1);
      complete(fake, submitted().at(-1)!);
      await until(async () => (await statusOf(id)).status === "done");
    };
    const frees = () => fake.calls.filter((c) => c === "POST /free").length;
    await run({});
    expect(frees()).toBe(1); // unknown after a start: free first
    await run({ prompt: "a dog" });
    expect(frees()).toBe(1); // same checkpoint
    await run({ checkpoint: "other.safetensors" });
    expect(frees()).toBe(2);
  });

  it("remembers what is loaded across a restart: the same model is not unloaded for the first render after it", async () => {
    const frees = () => fake.calls.filter((c) => c === "POST /free").length;
    const run = async (app: TestApp, over: Record<string, unknown>) => {
      const id = (await post(app.app, "/api/jobs", job(over))).json().ids[0] as string;
      const n = submitted().length;
      await until(() => submitted().length === n + 1);
      complete(fake, submitted().at(-1)!);
      await until(async () => (await statusOf(id)).status === "done");
    };
    await run(t, {});
    expect(frees()).toBe(1);
    t.services.queue.stop();
    await t.services.queue.idle();

    const again = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    await again.services.queue.start();
    await run(again, { prompt: "a dog" });
    expect(frees()).toBe(1); // the same checkpoint: ComfyUI still has it
    await run(again, { checkpoint: "other.safetensors" });
    expect(frees()).toBe(2);
    // freed by hand: nothing is known to be loaded any more, also after the next restart
    await post(again.app, "/api/comfy/free");
    expect(frees()).toBe(3);
    again.services.queue.stop();
    await again.services.queue.idle();

    const third = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    await third.services.queue.start();
    await run(third, { checkpoint: "other.safetensors" });
    expect(frees()).toBe(4);
    third.services.queue.stop();
    await third.services.queue.idle();

    // a database from before the note existed: what the last render loaded stands for it
    await t.db.deleteFrom("settings").where("key", "=", "queue.loads").execute();
    const fourth = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    await fourth.services.queue.start();
    await run(fourth, { checkpoint: "other.safetensors", prompt: "a dog" });
    expect(frees()).toBe(4);
    fourth.services.queue.stop();
    await fourth.services.queue.idle();
  });

  it("frees ComfyUI's memory when asked, but not under a render; and by itself after a while without one, when Settings asks for it", async () => {
    const frees = () => fake.calls.filter((c) => c === "POST /free").length;
    const id = await enqueue({});
    await until(() => submitted().length === 1);
    const before = frees();
    // its model is in use
    const refused = await post(t.app, "/api/comfy/free");
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/render is under way/);
    expect(frees()).toBe(before);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");

    expect((await post(t.app, "/api/comfy/free")).json()).toEqual({ ok: true });
    expect(frees()).toBe(before + 1);

    // a few hundredths of a second stand in for the minutes
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { unloadAfterMinutes: 0.002 } });
    const again = await enqueue({ prompt: "a dog" });
    await until(() => submitted().length === 2);
    const loaded = frees();
    complete(fake, submitted()[1]!);
    await until(async () => (await statusOf(again)).status === "done");
    await until(() => frees() === loaded + 1);
    // once is enough: nothing is loaded any more
    await new Promise((r) => setTimeout(r, 300));
    expect(frees()).toBe(loaded + 1);
  });

  it("makes several when asked, each with its own seed", async () => {
    const res = await post(t.app, "/api/jobs", { ...job(), count: 3 });
    expect(res.json().ids).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      await until(() => submitted().length === i + 1);
      complete(fake, submitted()[i]!);
    }
    await until(async () => (await queue()).waiting.length === 0 && (await queue()).running === null);
    const seeds = submitted().map((p) => Object.values(fake.prompts.get(p)!).find((n) => n.class_type === "KSampler")!.inputs.seed);
    expect(new Set(seeds).size).toBe(3);
    expect((await get(t.app, "/api/assets")).json().items).toHaveLength(3);
  });
});

describe("while a job renders", () => {
  it("reports progress and serves the live preview", async () => {
    const id = await enqueue({ steps: 20 });
    await until(() => submitted().length === 1);
    const promptId = submitted()[0]!;
    const sampler = Object.entries(fake.prompts.get(promptId)!).find(([, n]) => n.class_type === "KSampler")![0];
    expect((await get(t.app, `/api/jobs/${id}/preview`)).statusCode).toBe(404);

    fake.send("execution_start", { prompt_id: promptId });
    fake.send("progress", { prompt_id: promptId, node: sampler, value: 5, max: 20 });
    fake.sendBinary(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 42, 43]));
    await until(async () => (await queue()).running?.previewSeq === 1);
    expect((await queue()).running).toMatchObject({ id, phase: "sampling", step: 5, steps: 20, progress: 0.25 });

    const preview = await get(t.app, `/api/jobs/${id}/preview`);
    expect(preview.headers["content-type"]).toBe("image/jpeg");
    expect([...preview.rawPayload]).toEqual([42, 43]);

    complete(fake, promptId);
    await until(async () => (await statusOf(id)).status === "done");
  });

  it("pushes live events to the browser", async () => {
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address() as { port: number };
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: abort.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`the stream ended before "${needle}"`);
        text += new TextDecoder().decode(value);
      }
    };
    await readUntil("event: hello");
    await post(t.app, "/api/queue/pause");
    await readUntil("event: queue");
    abort.abort();
  });

  it("passes a burst of progress on at most four times a second, and always its last", async () => {
    await t.app.listen({ host: "127.0.0.1", port: 0 });
    const address = t.app.server.address() as { port: number };
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: abort.signal });
    const reader = res.body!.getReader();
    let text = "";
    const count = () => text.split("event: progress").length - 1;
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    await until(() => text.includes("event: hello"));
    // five in a row: the first goes at once, the last after the wait, the ones between are folded
    for (let i = 0; i < 5; i++) t.services.queue.events.emit("progress");
    await until(() => count() === 2);
    await new Promise((r) => setTimeout(r, 400));
    expect(count()).toBe(2);
    abort.abort();
  });
});

describe("what is refused before anything is queued", () => {
  it("an unknown recipe", async () => {
    const res = await post(t.app, "/api/jobs", { recipe: "nope.nothing", input: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("nope.nothing");
  });

  it("inputs the recipe does not accept", async () => {
    const res = await post(t.app, "/api/jobs", job({ steps: 5000 }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("steps");
    expect(submitted()).toEqual([]);
  });
});

describe("failures say why", () => {
  it("a model file ComfyUI does not have", async () => {
    const id = await enqueue({ checkpoint: "missing.safetensors" });
    await until(async () => (await statusOf(id)).status === "failed");
    expect((await statusOf(id)).error).toContain('ComfyUI has no file "missing.safetensors"');
    expect(submitted()).toEqual([]);
  });

  it("an error ComfyUI reports while rendering", async () => {
    const id = await enqueue();
    await until(() => submitted().length === 1);
    fake.history[submitted()[0]!] = { status: { status_str: "error", messages: [["execution_error", { exception_message: "CUDA out of memory" }]] } };
    await until(async () => (await statusOf(id)).status === "failed");
    expect((await queue()).recent[0]).toMatchObject({ id, status: "failed", error: "CUDA out of memory" });
  });

  it("a graph ComfyUI refuses", async () => {
    fake.rejectWith = { error: { message: "Prompt outputs failed validation" }, node_errors: {} };
    const id = await enqueue();
    await until(async () => (await statusOf(id)).status === "failed");
    expect((await statusOf(id)).error).toContain("Prompt outputs failed validation");
  });
});

describe("pause", () => {
  it("holds waiting jobs until resumed, and survives a restart", async () => {
    expect((await post(t.app, "/api/queue/pause")).json().paused).toBe(true);
    const id = await enqueue();
    await new Promise((r) => setTimeout(r, 60));
    expect(submitted()).toEqual([]);
    expect((await queue()).waiting.map((w: { id: string }) => w.id)).toEqual([id]);

    // the flag is stored: a new queue on the same database starts paused
    t.services.queue.stop();
    await t.services.queue.idle();
    const again = await makeApp({ db: t.db, dir: t.dir, comfyUrl: fake.url });
    await again.services.queue.start();
    expect((await get(again.app, "/api/queue")).json().paused).toBe(true);

    await post(again.app, "/api/queue/resume");
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    again.services.queue.stop();
    await again.services.queue.idle();
    await again.app.close();
  });
});

describe("stopping a job", () => {
  it("removes a waiting one", async () => {
    await post(t.app, "/api/queue/pause");
    const id = await enqueue();
    expect((await post(t.app, `/api/jobs/${id}/cancel`)).statusCode).toBe(200);
    expect((await statusOf(id)).status).toBe("cancelled");
    expect((await post(t.app, `/api/jobs/${id}/cancel`)).statusCode).toBe(404);
  });

  it("interrupts the running one on ComfyUI", async () => {
    const id = await enqueue();
    await until(() => submitted().length === 1);
    await post(t.app, `/api/jobs/${id}/cancel`);
    await until(async () => (await statusOf(id)).status === "cancelled");
    expect(fake.calls).toContain("POST /interrupt");
    expect((await get(t.app, "/api/assets")).json().items).toEqual([]);
  });
});

describe("when ComfyUI goes away", () => {
  it("queues a lost job again and renders it", async () => {
    const id = await enqueue();
    await until(() => submitted().length === 1);
    fake.pending = []; // ComfyUI restarted and forgot the prompt
    await until(() => submitted().length === 2);
    complete(fake, submitted()[1]!);
    await until(async () => (await statusOf(id)).status === "done");
    expect((await statusOf(id)).attempts).toBe(2);
  });

  it("waits while it is offline, then gives up after it has been away too long", async () => {
    await fake.close();
    const id = await enqueue();
    await until(async () => (await queue()).online === false);
    expect((await statusOf(id)).status).toBe("queued");
    await until(async () => (await statusOf(id)).status === "failed");
    expect((await statusOf(id)).error).toContain("offline");
  });

  it("picks a submitted job up again after a restart, without submitting it twice", async () => {
    const db = openSqlite(":memory:");
    const first = await makeApp({ db, comfyUrl: fake.url });
    await first.services.queue.start();
    const id = (await post(first.app, "/api/jobs", job({ steps: 12, hires: true, hiresSteps: 8 }))).json().ids[0] as string;
    await until(() => submitted().length === 1);
    // the server stops while ComfyUI keeps rendering
    first.services.queue.stop();
    await first.services.queue.idle();
    await first.app.close();

    const queuedAs = fake.sockets[0]!;
    const second = await makeApp({ db, dir: first.dir, comfyUrl: fake.url });
    await second.services.queue.start();

    // ComfyUI sends a prompt's progress only to the client that queued it: the new process listens under that id
    await until(() => fake.sockets.filter((s) => s === queuedAs).length === 2);
    const promptId = submitted()[0]!;
    const graph = fake.prompts.get(promptId)!;
    const samplers = Object.entries(graph).filter(([, n]) => n.class_type === "KSampler").map(([nodeId]) => nodeId);
    expect(samplers).toHaveLength(2);
    await until(async () => (await get(second.app, "/api/queue")).json().running?.steps === 20);
    // joined during the second pass: the first one (12 steps) is known to be done
    await new Promise((r) => setTimeout(r, 30));
    fake.send("progress", { prompt_id: promptId, node: samplers[1], value: 3, max: 8 });
    await until(async () => (await get(second.app, "/api/queue")).json().running?.step === 15);
    expect((await get(second.app, "/api/queue")).json().running).toMatchObject({ phase: "refining", step: 15, steps: 20 });

    complete(fake, promptId);
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    expect(submitted()).toHaveLength(1);
    await second.close();
  });

  it("keeps its step count on the job while it runs, and goes on from it after a restart", async () => {
    const db = openSqlite(":memory:");
    const first = await makeApp({ db, comfyUrl: fake.url });
    await first.services.queue.start();
    const id = (await post(first.app, "/api/jobs", job({ steps: 12, hires: true, hiresSteps: 8 }))).json().ids[0] as string;
    await until(() => submitted().length === 1);
    const promptId = submitted()[0]!;
    const samplers = Object.entries(fake.prompts.get(promptId)!).filter(([, n]) => n.class_type === "KSampler").map(([nodeId]) => nodeId);
    const saved = async () => JSON.parse((await db.selectFrom("jobs").select("resume").where("id", "=", id).executeTakeFirstOrThrow()).resume!).stepsDone;
    fake.send("progress", { prompt_id: promptId, node: samplers[0], value: 7, max: 12 });
    await until(async () => (await saved()) === 7);
    first.services.queue.stop();
    await first.services.queue.idle();
    await first.app.close();

    const second = await makeApp({ db, dir: first.dir, comfyUrl: fake.url });
    await second.services.queue.start();
    // the saved count shows from the pick-up, where the pass running (the first) would have said 0
    await until(async () => (await get(second.app, "/api/queue")).json().running?.steps === 20);
    expect((await get(second.app, "/api/queue")).json().running).toMatchObject({ step: 7, steps: 20 });
    await new Promise((r) => setTimeout(r, 30));
    fake.send("progress", { prompt_id: promptId, node: samplers[0], value: 8, max: 12 });
    await until(async () => (await get(second.app, "/api/queue")).json().running?.step === 8);
    await until(async () => (await saved()) === 8);

    complete(fake, promptId);
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    expect(submitted()).toHaveLength(1);
    await second.close();
  });
});

describe("a prompt sent just before the process died", () => {
  /** A job submitted by a first process, whose row is then made to look as it does when that process died between sending its prompt and hearing back. */
  async function diedWhileSending(): Promise<{ db: ReturnType<typeof openSqlite>; dir: string; id: string; promptId: string }> {
    const db = openSqlite(":memory:");
    const first = await makeApp({ db, comfyUrl: fake.url });
    await first.services.queue.start();
    const id = (await post(first.app, "/api/jobs", job())).json().ids[0] as string;
    await until(() => submitted().length === 1);
    first.services.queue.stop();
    await first.services.queue.idle();
    await first.app.close();
    const row = await db.selectFrom("jobs").select("resume").where("id", "=", id).executeTakeFirstOrThrow();
    const resume = JSON.parse(row.resume!);
    await db.updateTable("jobs").set({ resume: JSON.stringify({ ...resume, unsent: true }) }).where("id", "=", id).execute();
    return { db, dir: first.dir, id, promptId: resume.promptId };
  }

  it("is sent under the id saved on the job before it went", async () => {
    const id = await enqueue();
    await until(() => submitted().length === 1);
    // the mark "not sent yet" is cleared once ComfyUI has answered, a moment after it has the prompt
    await until(async () => !JSON.parse((await statusOf(id)).resume ?? "{}").unsent);
    const saved = JSON.parse((await statusOf(id)).resume!);
    expect(submitted()[0]).toBe(saved.promptId);
    expect(saved.promptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.unsent).toBeUndefined();
    // refused by ComfyUI: what was saved before it went is what the job holds, the id it was sent with
    fake.rejectWith = { error: "no" };
    const refused = await enqueue({ prompt: "a dog" });
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(refused)).status === "failed");
    expect(JSON.parse((await statusOf(refused)).resume!)).toMatchObject({ unsent: true, promptId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("is followed after a restart when ComfyUI has it, not sent twice", async () => {
    const { db, dir, id, promptId } = await diedWhileSending();
    const second = await makeApp({ db, dir, comfyUrl: fake.url });
    await second.services.queue.start();
    await until(() => fake.calls.filter((c) => c === "GET /queue").length > 0);
    complete(fake, promptId);
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    expect(submitted()).toEqual([promptId]);
    expect(JSON.parse((await db.selectFrom("jobs").select("resume").where("id", "=", id).executeTakeFirstOrThrow()).resume!).unsent).toBeUndefined();
    await second.close();
  });

  it("is sent again after a restart when ComfyUI never had it", async () => {
    const { db, dir, id, promptId } = await diedWhileSending();
    // it never reached ComfyUI
    fake.prompts.delete(promptId);
    fake.pending = [];
    const second = await makeApp({ db, dir, comfyUrl: fake.url });
    await second.services.queue.start();
    await until(() => submitted().length === 1);
    expect(submitted()[0]).not.toBe(promptId);
    complete(fake, submitted()[0]!);
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    await second.close();
  });
});

describe("the library", () => {
  const make = async (n: number) => {
    await post(t.app, "/api/jobs", { ...job(), count: n });
    for (let i = 0; i < n; i++) {
      await until(() => submitted().length === i + 1);
      complete(fake, submitted()[i]!);
    }
    await until(async () => (await get(t.app, "/api/assets?limit=200")).json().items.length === n);
  };

  it("pages from newest to oldest without repeating or skipping", async () => {
    await make(5);
    const seen: string[] = [];
    let after: string | null = "";
    while (after !== null) {
      const page: { items: Array<{ id: string }>; next: string | null } = (
        await get(t.app, `/api/assets?limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`)
      ).json();
      seen.push(...page.items.map((i: { id: string }) => i.id));
      after = page.next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("keeps, bins and restores", async () => {
    await make(1);
    const id = (await get(t.app, "/api/assets")).json().items[0].id as string;
    expect((await post(t.app, `/api/assets/${id}/keep`, { kept: true })).json().kept).toBe(true);

    await t.app.inject({ method: "DELETE", url: `/api/assets/${id}` });
    expect((await get(t.app, "/api/assets")).json().items).toEqual([]);
    expect((await get(t.app, "/api/assets?bin=1")).json().items.map((i: { id: string }) => i.id)).toEqual([id]);

    expect((await post(t.app, `/api/assets/${id}/restore`)).json().inBin).toBe(false);
    expect((await get(t.app, "/api/assets")).json().items).toHaveLength(1);
  });

  it("serves a byte range of a file", async () => {
    await make(1);
    const id = (await get(t.app, "/api/assets")).json().items[0].id as string;
    const res = await get(t.app, `/api/assets/${id}/file`, { range: "bytes=0-7" });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-7/33");
    expect([...res.rawPayload]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await get(t.app, `/api/assets/${id}/file`, { range: "bytes=100-200" })).statusCode).toBe(416);
  });

  it("answers 404 for something that is not there", async () => {
    expect((await get(t.app, "/api/assets/nope")).statusCode).toBe(404);
  });
});

describe("the queue's history", () => {
  it("lists finished jobs with what they made, searched and counted", async () => {
    const id = await enqueue({ steps: 20 });
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!, 832, 1216);
    await until(async () => (await statusOf(id)).status === "done");
    const page = (await get(t.app, "/api/jobs")).json();
    expect(page.counts).toEqual({ done: 1, failed: 0, cancelled: 0 });
    expect(page.more).toBe(false);
    expect(page.items[0]).toMatchObject({ id, status: "done", prompt: "a cat", kind: "render" });
    expect(page.items[0].made[0]).toMatchObject({ kind: "image", width: 832, height: 1216, kept: false, inBin: false });
    expect(typeof page.items[0].seed).toBe("number");
    expect(page.items[0].tookMs).toBeGreaterThanOrEqual(0);
    expect((await get(t.app, "/api/jobs?status=failed")).json().items).toHaveLength(0);
    expect((await get(t.app, "/api/jobs?q=cat")).json().items).toHaveLength(1);
    expect((await get(t.app, "/api/jobs?q=zebra")).json().items).toHaveLength(0);
    // the counts follow the search and the model
    expect((await get(t.app, "/api/jobs?q=zebra")).json().counts).toEqual({ done: 0, failed: 0, cancelled: 0 });
    expect((await get(t.app, "/api/jobs?q=cat&status=failed")).json().counts).toEqual({ done: 1, failed: 0, cancelled: 0 });
  });

  it("finds a model whose file name has an underscore in it, as nearly every model file has", async () => {
    // a finished job as the queue leaves one, with a model file named the usual way
    const at = new Date().toISOString();
    await t.db
      .insertInto("jobs")
      .values({
        id: "job-sdxl", owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: "a cat", inputs: JSON.stringify({ prompt: "a cat", checkpoint: "sdxl_base_1.0.safetensors" }),
        status: "done", warm: 0, look: null, priority: 0, depends_on: null, attempts: 1, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: null,
        draft_id: null, folder_id: null, finished_from: null, created_at: at, started_at: at, finished_at: at, updated_at: at,
      })
      .execute();
    const byModel = (await get(t.app, "/api/jobs?model=sdxl_base")).json();
    expect(byModel.items.map((i: { id: string }) => i.id)).toEqual(["job-sdxl"]);
    expect(byModel.items[0].model).toBe("sdxl_base_1.0");
    expect((await get(t.app, "/api/jobs?q=sdxl_base_1.0")).json().items).toHaveLength(1);
    // the underscore is that letter, not any one letter; a percent sign is not any run of them
    expect((await get(t.app, "/api/jobs?model=sdxlXbase")).json().items).toHaveLength(0);
    expect((await get(t.app, "/api/jobs?q=sdxl%25base")).json().items).toHaveLength(0);
  });
});

describe("dismissing from the history", () => {
  it("takes several finished jobs off in one request and one event, and leaves a job that is not finished", async () => {
    const at = new Date().toISOString();
    const row = (id: string, status: "done" | "failed" | "cancelled" | "queued") => ({
      id, owner_id: OWNER, recipe_id: "sdxl.text-to-picture", label: id, inputs: JSON.stringify({ prompt: id }),
      status, warm: 0, look: null, priority: 0, depends_on: null, attempts: 1, resume: null, error: null, generation_id: null, clip_id: null, clip_fit: 0, timeline_id: null,
      draft_id: null, folder_id: null, finished_from: null, created_at: at, started_at: at, finished_at: status === "queued" ? null : at, updated_at: at,
    });
    await t.services.queue.setPaused(true);
    await t.db.insertInto("jobs").values([row("a", "done"), row("b", "failed"), row("c", "cancelled"), row("w", "queued")]).execute();
    let events = 0;
    let timeline = 0;
    t.services.queue.events.on("queue", () => events++);
    t.services.queue.events.on("timeline", () => timeline++);
    const res = await post(t.app, "/api/jobs/dismiss", { ids: ["a", "b", "c", "w", "gone"] });
    expect(res.json()).toEqual({ dismissed: 3 });
    expect(events).toBe(1);
    // none of them was a clip's: no timeline to read again
    expect(timeline).toBe(0);
    const left = (await t.db.selectFrom("jobs").select("id").execute()).map((r) => r.id);
    expect(left).toEqual(["w"]);
    expect((await post(t.app, "/api/jobs/dismiss", { ids: [] })).statusCode).toBe(400);
  });

  it("says a timeline changed when a clip's job ends, not when a picture's does", async () => {
    let timeline = 0;
    t.services.queue.events.on("timeline", () => timeline++);
    const id = await enqueue();
    await until(() => submitted().length === 1);
    complete(fake, submitted()[0]!);
    await until(async () => (await statusOf(id)).status === "done");
    expect(timeline).toBe(0);
  });
});

describe("a result filed just before the process died", () => {
  it("is not filed twice when the job is picked up again: the job already names its generation", async () => {
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
    expect(was.generation_id).not.toBeNull();
    // as the row looks when the process dies right after the result was filed: still running, its prompt to wait on, its generation named
    await db.updateTable("jobs").set({ status: "running", finished_at: null }).where("id", "=", id).execute();

    const second = await makeApp({ db, dir: first.dir, comfyUrl: fake.url });
    await second.services.queue.start();
    await until(async () => (await db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "done");
    expect((await db.selectFrom("jobs").select("generation_id").where("id", "=", id).executeTakeFirstOrThrow()).generation_id).toBe(was.generation_id);
    expect(await db.selectFrom("generations").select("id").execute()).toHaveLength(1);
    expect(await db.selectFrom("assets").select("id").execute()).toHaveLength(1);
    expect(submitted()).toHaveLength(1);
    await second.close();
  });
});
