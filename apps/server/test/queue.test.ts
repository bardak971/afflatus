import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeComfy } from "@afflatus/comfy/testing";
import { openSqlite } from "../src/db";
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
