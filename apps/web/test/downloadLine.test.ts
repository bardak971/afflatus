import { describe, expect, it } from "vitest";
import type { Download } from "../src/api";
import { inLine, linesOf, startsIn } from "../src/downloadLine";

const GB = 2 ** 30;
const dl = (id: string, over: Partial<Download> = {}): Download => ({ id, file: `${id}.safetensors`, folder: "loras", title: id, bytes: 0, total: GB, status: "starting", ...over });

describe("the downloads' line", () => {
  it("keeps one begun out of the line while its node pack's line is full: it cannot be moved, so it is not dragged", () => {
    const busy = dl("p", { status: "starting", begun: true, turn: 1, waiting: "the node pack's downloads at once are under way: waiting for one to end" });
    expect(inLine(busy)).toBe(false);
    expect(inLine(dl("q", { waiting: "behind p", turn: 2 }))).toBe(true);
    const [line] = linesOf([busy, dl("q", { waiting: "behind p", turn: 2 })], "m1");
    expect(line!.under.map((d) => d.id)).toEqual(["p"]);
    expect(line!.next.map((d) => d.id)).toEqual(["q"]);
  });

  it("splits each ComfyUI's downloads into under way, next in its order, done today and failed, the first ComfyUI first", () => {
    const now = new Date(2026, 9, 24, 15, 0).getTime();
    const items = [
      dl("pod", { machine: "pod1", status: "downloading", turn: 1, bytes: GB / 2, rate: 2 ** 20 }),
      dl("c", { waiting: "behind a and b", turn: 4 }),
      dl("a", { status: "downloading", turn: 1, bytes: GB / 4, rate: 2 ** 20 }),
      dl("x", { waiting: "behind a and b", turn: 3 }),
      dl("b", { status: "downloading", turn: 2, total: 0, rate: 2 ** 20 }),
      dl("old", { status: "done", at: now - 24 * 3600_000 }),
      dl("new", { status: "done", at: now - 3600_000 }),
      dl("bad", { status: "error", error: "refused", at: now - 60_000 }),
      dl("stop", { status: "stopped", at: now }),
    ];
    const [mine, pod] = linesOf(items, "m1", now);
    expect(mine!.machine).toBe("m1");
    expect(mine!.under.map((d) => d.id)).toEqual(["a", "b"]);
    expect(mine!.next.map((d) => d.id)).toEqual(["x", "c"]);
    expect(mine!.done.map((d) => d.id)).toEqual(["new"]);
    expect(mine!.failed.map((d) => d.id)).toEqual(["bad"]);
    // b's size is not known: what is left is at least the rest
    expect(mine!.left).toBe(GB * 0.75 + 2 * GB);
    expect(mine!.unsized).toBe(true);
    expect(mine!.rate).toBe(2 * 2 ** 20);
    expect(pod!.machine).toBe("pod1");
  });

  it("says when a waiting file starts from what is ahead of it, once all but one of those ahead are done", () => {
    const [line] = linesOf([
      dl("a", { status: "downloading", turn: 1, bytes: GB / 2, rate: 50 * 2 ** 20 }),
      dl("b", { status: "downloading", turn: 2, bytes: 0, total: 2 * GB, rate: 50 * 2 ** 20 }),
      dl("c", { waiting: "behind a and b", turn: 3 }),
      dl("d", { waiting: "behind a and b", turn: 4 }),
    ], "m1");
    // c: a's half GB left, b still coming; d: a's half and c's whole GB, b still coming
    expect(startsIn(line!, line!.next[0]!)).toBeCloseTo(((GB / 2) / (100 * 2 ** 20)) * 1000);
    expect(startsIn(line!, line!.next[1]!)).toBeCloseTo(((GB / 2 + GB) / (100 * 2 ** 20)) * 1000);
    // nothing measured: no time said
    const [still] = linesOf([dl("a", { status: "downloading", turn: 1 }), dl("c", { waiting: "behind a", turn: 2 })], "m1");
    expect(startsIn(still!, still!.next[0]!)).toBeNull();
  });
});
