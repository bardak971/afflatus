import { describe, expect, it } from "vitest";
import { Kept } from "../src/kept";

/** One promise kept per key (card #261): what its ten hand-written copies each did, by option. */
describe("a read kept per key", () => {
  it("reads once while it is kept, and again once out of time", async () => {
    let now = 0;
    let reads = 0;
    const kept = new Kept<number>({ ttlMs: 1000, now: () => now });
    const read = async () => ++reads;
    expect(await kept.get("a", read)).toBe(1);
    expect(await kept.get("a", read)).toBe(1);
    now = 999;
    expect(await kept.get("a", read)).toBe(1);
    now = 1000;
    expect(await kept.get("a", read)).toBe(2);
    expect(kept.peek("a")).toBeDefined();
    now = 5000;
    expect(kept.peek("a")).toBeUndefined();
  });

  it("drops a failure, unless it is to be kept", async () => {
    let reads = 0;
    const fails = async () => {
      reads++;
      throw new Error("no");
    };
    const dropped = new Kept<number>();
    await expect(dropped.get("a", fails)).rejects.toThrow("no");
    await expect(dropped.get("a", fails)).rejects.toThrow("no");
    expect(reads).toBe(2);
    const keeping = new Kept<number>({ keepFailures: true });
    await expect(keeping.get("a", fails)).rejects.toThrow("no");
    await expect(keeping.get("a", fails)).rejects.toThrow("no");
    expect(reads).toBe(3);
  });

  it("keeps only the values it is told to, and only while running when asked", async () => {
    let reads = 0;
    const facts = new Kept<string | null>({ keepIf: (v) => v !== null });
    await facts.get("a", async () => (++reads, null));
    await facts.get("a", async () => (++reads, "x"));
    await facts.get("a", async () => (++reads, "y"));
    expect(reads).toBe(2);
    const running = new Kept<number>({ whileRunning: true });
    let free!: (n: number) => void;
    const first = running.get("a", () => new Promise<number>((r) => (free = r)));
    // asked again before it is done: the same run
    expect(running.get("a", async () => 99)).toBe(first);
    free(1);
    expect(await first).toBe(1);
    await Promise.resolve();
    expect(await running.get("a", async () => 2)).toBe(2);
  });

  it("holds its most recently used keys, the least recently used going first", async () => {
    const kept = new Kept<string>({ max: 2 });
    await kept.get("a", async () => "a");
    await kept.get("b", async () => "b");
    await kept.get("a", async () => "a again");
    await kept.get("c", async () => "c");
    expect(kept.size).toBe(2);
    expect(await kept.get("a", async () => "read anew")).toBe("a");
    expect(await kept.get("b", async () => "b anew")).toBe("b anew");
    kept.deleteWhere((k) => k === "b");
    expect(kept.peek("b")).toBeUndefined();
  });
});
