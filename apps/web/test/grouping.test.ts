import { describe, expect, it } from "vitest";
import type { Asset } from "../src/api";
import { groupItems } from "../src/screens/studio/grouping";

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: "video", origin: "generated", name: id, mime: "video/mp4", bytes: 1, width: 1, height: 1, durationMs: 1000, fps: 24, hasSound: false,
  kept: true, inBin: false, folderId: null, generationId: null, createdAt: "2026-10-06T10:00:00Z", path: null, clipOf: null, draftOf: null, ...over,
});
const take = (id: string, timeline: string, clip: number, takeNo: number, takes: number, playing: boolean) =>
  asset(id, { clipOf: { timeline, timelineName: `T ${timeline}`, clip, take: takeNo, takes, playing, upscaledBy: null } });

describe("the grid in sections", () => {
  const items = [
    take("a2", "x", 2, 1, 1, true),
    take("a1t2", "x", 1, 2, 2, true),
    take("a1t1", "x", 1, 1, 2, false),
    asset("loose"),
    take("b1", "y", 1, 1, 1, true),
  ];

  it("groups by timeline in clip order, stacks the takes of a clip with the playing one on top, and leaves out what is on no timeline", () => {
    const s = groupItems(items, "timeline", new Set());
    expect(s.map((x) => [x.label, x.note])).toEqual([["T x", "2 clips"], ["T y", "1 clip"]]);
    expect(s[0]!.entries.map((e) => [e.asset.id, e.takes?.length ?? 1])).toEqual([["a1t2", 2], ["a2", 1]]);
    // opened, the stack shows every take in place
    const opened = groupItems(items, "timeline", new Set(["x:1"]));
    expect(opened[0]!.entries.map((e) => e.asset.id)).toEqual(["a1t2", "a1t1", "a2"]);
  });

  it("shows nothing when nothing is of the kind asked for, and everything when asked for none", () => {
    expect(groupItems([asset("p"), asset("q")], "draft", new Set())).toEqual([]);
    expect(groupItems(items, "none", new Set())[0]!.entries).toHaveLength(5);
  });

  it("groups by draft and by day", () => {
    const d = groupItems([asset("m", { draftOf: { id: "d1", name: "Woman burger" } }), asset("n")], "draft", new Set());
    expect(d.map((x) => x.label)).toEqual(["Woman burger"]);
    const today = new Date().toISOString();
    expect(groupItems([asset("t", { createdAt: today })], "day", new Set())[0]!.label).toBe("Today");
  });

  it("names the days, counts the items of a section, and keeps their order", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const s = groupItems([asset("n1", { createdAt: yesterday }), asset("n2", { createdAt: yesterday })], "day", new Set());
    expect(s.map((x) => [x.label, x.note])).toEqual([["Yesterday", "2 items"]]);
    expect(s[0]!.entries.map((e) => e.asset.id)).toEqual(["n1", "n2"]);
  });

  it("links a timeline's section to it, and puts the lowest take on top when none plays", () => {
    const s = groupItems([take("t2", "z", 1, 2, 2, false), take("t1", "z", 1, 1, 2, false)], "timeline", new Set());
    expect(s[0]!.timeline).toBe("z");
    expect(s[0]!.entries[0]!.asset.id).toBe("t1");
    expect(s[0]!.entries[0]!.stack).toBe("z:1");
  });
});
