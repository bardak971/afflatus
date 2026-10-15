import { describe, expect, it } from "vitest";
import { queueOf, type Job, type QueueAnswer } from "../src/api";

const whole = (id: string): Job => ({
  id, recipe: "r", label: id, status: "queued", error: null, generationId: null, clipId: null, draftId: null, join: null, kind: "render", estimateMs: 1000, input: null,
  createdAt: "2026-10-15T00:00:00Z", startedAt: null, finishedAt: null, machine: "m1", pinned: null, startsInMs: 0, runsOn: null, lacks: null, fetch: null,
});

describe("the queue's answer, as the screens read it", () => {
  it("has every waiting job in its order, the later ones with what they carry and the rest empty", () => {
    const a: QueueAnswer = {
      paused: false, model: null, online: true, offlineForMs: 0, running: null, machines: [], tool: null, recent: [], hunt: null,
      waiting: [whole("a"), whole("b")], waitingCount: 4,
      later: [{ id: "c", label: "c", kind: "render", recipe: "r", draftId: "d1", machine: "m2" }, { id: "d", label: "d", kind: "load", recipe: "r" }],
    };
    const q = queueOf(a);
    expect(q.waiting.map((w) => w.id)).toEqual(["a", "b", "c", "d"]);
    expect(q.whole).toBe(2);
    expect(q.waiting[2]).toMatchObject({ status: "queued", draftId: "d1", machine: "m2", clipId: null, pinned: null, estimateMs: null, lacks: null });
    expect(q.waiting[3]!.kind).toBe("load");
    expect(q).not.toHaveProperty("later");
  });
});
