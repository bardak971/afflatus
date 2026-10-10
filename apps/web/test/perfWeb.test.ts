import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryJob, HistoryPage } from "../src/api";
import { withFreshHead, withoutJobs } from "../src/screens/queue/historyHead";
import { batched } from "../src/timeline/measures";

const job = (id: string): HistoryJob => ({
  id, recipe: "r", label: id, status: "done", error: null, generationId: null, clipId: null, draftId: null, join: null, kind: "render", estimateMs: null, input: null,
  createdAt: "", startedAt: null, finishedAt: null, tookMs: 1000, model: null, prompt: "", seed: null, batch: id, made: [],
} as HistoryJob);
const page = (ids: string[], more = true, done = 0): HistoryPage => ({ items: ids.map(job), more, next: more ? ids.at(-1)! : null, counts: { done, failed: 0, cancelled: 0 } });
const ids = (pages: HistoryPage[]) => pages.flatMap((p) => p.items.map((j) => j.id));

describe("the history after a job ended", () => {
  const loaded = [page(["e", "d"], true, 5), page(["c", "b"], true, 5), page(["a"], false, 5)];

  it("puts the jobs that ended in front, keeps every page loaded, and asks the next page after the job the list ends on", () => {
    const pages = withFreshHead(loaded, page(["g", "f", "e"], true, 7))!;
    expect(ids(pages)).toEqual(["g", "f", "e", "d", "c", "b", "a"]);
    expect(pages).toHaveLength(3);
    // the counts are the fresh ones; the pages after the first are the same objects (their rows are not drawn again)
    expect(pages[0]!.counts.done).toBe(7);
    expect(pages[1]).toBe(loaded[1]);
    expect(pages[2]).toBe(loaded[2]);
    // the next page is asked after the last job loaded, wherever the new ones moved it in the server's list
    expect(pages.at(-1)!.next).toBe(loaded.at(-1)!.next);
    expect(ids(pages).length - ids(loaded).length).toBe(2);
  });

  it("takes a loaded job's fresh state in its place, and keeps the ones it did not change", () => {
    const fresh = page(["e", "d"], true, 5);
    fresh.items[0] = { ...fresh.items[0]!, made: [], label: "renamed" };
    const pages = withFreshHead(loaded, { ...fresh, items: [fresh.items[0]!, loaded[0]!.items[1]!] })!;
    expect(pages[0]!.items[0]!.label).toBe("renamed");
    expect(pages[0]!.items[1]).toBe(loaded[0]!.items[1]);
    expect(ids(pages)).toEqual(ids(loaded));
  });

  it("gives up when more ended than a page holds: nothing known to join the fresh page to", () => {
    expect(withFreshHead(loaded, page(["x", "y"], true, 9))).toBeNull();
  });
});

describe("the history after jobs were dismissed", () => {
  const loaded = [page(["e", "d"], true, 5), page(["c", "b"], true, 5), page(["a"], false, 5)];

  it("takes them out of the pages loaded and lowers the counts, without reading a page again", () => {
    const pages = withoutJobs(loaded, ["d", "c"]);
    expect(ids(pages)).toEqual(["e", "b", "a"]);
    expect(pages[0]!.counts.done).toBe(3);
    // the pages keep where the next one starts; one none of them was on is the same object
    expect(pages.map((p) => p.next)).toEqual(loaded.map((p) => p.next));
    expect(pages[2]).toBe(loaded[2]);
    expect(withoutJobs(loaded, ["zz"])).toBe(loaded);
  });
});

describe("measures asked for together", () => {
  afterEach(() => vi.useRealTimers());

  it("sends what is asked in the same moment as one request, each ask with its own answer", async () => {
    const send = vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, k === "bad" ? null : k.toUpperCase()])));
    const ask = batched(send);
    const a = ask("a");
    const b = ask("b");
    const again = ask("a");
    const bad = ask("bad");
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
    await expect(again).resolves.toBe("A");
    await expect(bad).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual(["a", "b", "bad"]);
    // asked later: a request of its own
    await expect(ask("c")).resolves.toBe("C");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("splits a long list, and a request that fails fails each of its asks", async () => {
    const send = vi.fn(async (keys: string[]) => {
      if (keys.includes("x2")) throw new Error("down");
      return Object.fromEntries(keys.map((k) => [k, 1]));
    });
    const ask = batched(send, 2);
    const all = ["x0", "x1", "x2", "x3"].map((k) => ask(k).then(() => "ok", () => "failed"));
    expect(await Promise.all(all)).toEqual(["ok", "ok", "failed", "failed"]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("the first load", () => {
  it("does not hold the Viewer: no file imports it but through viewer/LazyViewer.tsx, or lazily", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "../src");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const static_ = files.filter((f) => /^import \{[^}]*\} from "(\.\.?\/)+Viewer";/m.test(readFileSync(join(root, f), "utf8")));
    expect(static_).toEqual([]);
  });
});
