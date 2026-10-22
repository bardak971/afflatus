import { afterEach, describe, expect, it, vi } from "vitest";
import { api, queueOf, type Job, type QueueAnswer } from "../src/api";

const whole = (id: string): Job => ({
  id, recipe: "r", label: id, status: "queued", error: null, generationId: null, clipId: null, draftId: null, join: null, kind: "render", estimateMs: 1000, input: null,
  createdAt: "2026-10-15T00:00:00Z", startedAt: null, finishedAt: null, machine: "m1", pinned: null, startsInMs: 0, runsOn: null, lacks: null, fetch: null,
});

afterEach(() => vi.unstubAllGlobals());

describe("the queue's answer, as the screens read it", () => {
  it("has every waiting job in its order, the later ones with what they carry and the rest empty", () => {
    const a: QueueAnswer = {
      paused: false, model: null, online: true, offlineForMs: 0, running: null, machines: [], tool: null, recent: [], hunt: null,
      waiting: [whole("a"), whole("b")], waitingCount: 4,
      later: [{ id: "c", label: "c", kind: "render", recipe: "r", draftId: "d1", machine: "m2" }, { id: "d", label: "d", kind: "load", recipe: "r" }],
      parts: { waiting: "w1", later: "l1" }, same: [],
    };
    const q = queueOf(a);
    expect(q.waiting.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
    expect(q.whole).toBe(2);
    expect(q.waiting[2]).toMatchObject({ status: "queued", draftId: "d1", machine: "m2", clipId: null, pinned: null, estimateMs: null, lacks: null });
    expect(q.waiting[3]!.kind).toBe("load");
    expect(q).not.toHaveProperty("later");
    expect(q).not.toHaveProperty("parts");
  });

  it("names the waiting rows it holds on each read, and puts back the ones the server left out as unchanged", async () => {
    const answer = (over: Partial<QueueAnswer>): QueueAnswer => ({
      paused: false, model: null, online: true, offlineForMs: 0, running: null, machines: [], tool: null, recent: [], hunt: null,
      waiting: [whole("a")], waitingCount: 2, later: [{ id: "b", label: "b", kind: "render", recipe: "r" }], parts: { waiting: "w1", later: "l1" }, same: [], ...over,
    });
    const asked: string[] = [];
    const answers = [
      answer({}),
      // nothing changed: both parts left out
      answer({ waiting: [], later: [], same: ["waiting", "later"] }),
      // the later ones changed, the whole ones did not
      answer({ waiting: [], later: [{ id: "c", label: "c", kind: "render", recipe: "r" }], parts: { waiting: "w1", later: "l2" }, same: ["waiting"] }),
    ];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const first = await api.queue();
    const second = await api.queue();
    expect(second).toEqual(first);
    expect(second.waiting.map((w) => w.id)).toEqual(["a", "b"]);
    const third = await api.queue();
    expect(third.waiting.map((w) => w.id)).toEqual(["a", "c"]);
    expect(third.waiting[0]).toEqual(first.waiting[0]);
    // (the first read names what an answer before held, if any: the server sends it whole all the same)
    expect(asked.slice(1)).toEqual(["/api/queue?have=w1,l1", "/api/queue?have=w1,l1"]);
    // and the next read names the later rows as they are now
    answers.push(answer({ waiting: [], later: [], parts: { waiting: "w1", later: "l2" }, same: ["waiting", "later"] }));
    expect((await api.queue()).waiting.map((w) => w.id)).toEqual(["a", "c"]);
    expect(asked.at(-1)).toBe("/api/queue?have=w1,l2");
  });
});
