import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, QueueStatus, RunningJob } from "../src/api";
import { endedSince, greetings, mergeProgress, notifyTag, throttle } from "../src/liveState";
import { mayReload, RELOAD_GAP_MS } from "../src/reload";

const job = (id: string, status: Job["status"], kind: Job["kind"] = "render"): Job => ({
  id, recipe: "r", label: id, status, error: null, generationId: null, clipId: null, draftId: null, join: null, kind, estimateMs: null, input: null, createdAt: "", startedAt: null, finishedAt: null, machine: null, pinned: null, startsInMs: null, runsOn: null, lacks: null,
});
const queue = (over: Partial<QueueStatus> = {}): QueueStatus => ({ paused: false, model: null, online: true, offlineForMs: 0, running: null, machines: [], tool: null, waiting: [], recent: [], ...over });
const running = (id: string): RunningJob => ({ ...job(id, "running"), progress: 0.1, eta: 30, phase: "sampling", step: 1, steps: 10, previewSeq: 0 });

describe("a progress event", () => {
  it("is worked into the running job in place", () => {
    const q = queue({ running: running("a") });
    const merged = mergeProgress(q, { id: "a", progress: 0.5, step: 5 })!;
    expect(merged.running).toMatchObject({ id: "a", progress: 0.5, step: 5, steps: 10, phase: "sampling" });
    // a new object: React Query sees the change; the one before is left as it was
    expect(merged).not.toBe(q);
    expect(q.running!.progress).toBe(0.1);
  });
  it("asks for the queue when it cannot be worked in", () => {
    expect(mergeProgress(queue({ running: running("a") }), { id: "b", progress: 1 })).toBeNull();
    expect(mergeProgress(queue(), { id: "a" })).toBeNull();
    expect(mergeProgress(undefined, { id: "a" })).toBeNull();
    expect(mergeProgress(queue({ running: running("a") }), null)).toBeNull();
    expect(mergeProgress(queue({ running: running("a") }), { progress: 1 })).toBeNull();
  });
});

describe("the jobs that ended", () => {
  it("counts nothing the first time the queue is read, then each job that ended since, once", () => {
    const first = endedSince(null, queue({ recent: [job("a", "done")] }));
    expect(first.ended).toEqual([]);
    const second = endedSince(first.seen, queue({ recent: [job("b", "failed"), job("a", "done"), job("c", "running")] }));
    expect(second.ended.map((j) => j.id)).toEqual(["b"]);
    expect(endedSince(second.seen, queue({ recent: [job("b", "failed"), job("a", "done")] })).ended).toEqual([]);
  });
  it("counts a cancelled job as ended", () => {
    expect(endedSince(new Set(), queue({ recent: [job("x", "cancelled")] })).ended.map((j) => j.id)).toEqual(["x"]);
  });
  it("tags each job's notification apart, so that two tabs saying one job show it once", () => {
    expect(notifyTag("a")).not.toBe(notifyTag("b"));
    expect(notifyTag("a")).toBe(notifyTag("a"));
  });
});

describe("the throttle of the queue and library reads", () => {
  afterEach(() => vi.useRealTimers());
  it("reads once for a burst, and at most once a second after", () => {
    vi.useFakeTimers({ now: 0 });
    const run = vi.fn();
    const read = throttle(run, 1000, () => Date.now());
    read();
    read();
    read();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    read();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
    read();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("reads nothing more once cancelled", () => {
    vi.useFakeTimers({ now: 0 });
    const run = vi.fn();
    const read = throttle(run, 1000, () => Date.now());
    read();
    read.cancel();
    vi.advanceTimersByTime(2000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the reload after a stale chunk", () => {
  it("reloads the first time, not again right after", () => {
    expect(mayReload(null, 5000)).toBe(true);
    expect(mayReload(1000, 1000 + RELOAD_GAP_MS - 1)).toBe(false);
    expect(mayReload(1000, 1000 + RELOAD_GAP_MS + 1)).toBe(true);
    expect(mayReload(Number.NaN, 0)).toBe(true);
  });
});

describe("a hello on the live connection", () => {
  it("is the page opening the first time, a reconnect after", () => {
    const g = greetings();
    expect(g.hello()).toBe(false);
    expect(g.hello()).toBe(true);
  });
  it("is a reconnect the first time too when another tab held the connection and answered", () => {
    const g = greetings();
    g.followed();
    expect(g.hello()).toBe(true);
  });
});
