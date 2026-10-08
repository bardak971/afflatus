import { describe, expect, it } from "vitest";
import type { TimelineBrief, TimelineLeaf } from "../src/api";
import { chipsOf, factsOf, stripOf } from "../src/screens/studio/timelineCard";

const brief = (over: Partial<TimelineBrief> = {}): TimelineBrief => ({
  id: "t1", name: "Sample", projectId: null, folderId: null, width: 1024, height: 576, updatedAt: "2026-10-08T10:00:00Z",
  clips: 3, durationMs: 15_000, cover: "a1", strip: ["a1", null, "a3"], lengths: [7000, 5000, 3000], toRender: 1, staleJoins: 0, ...over,
});
const leaf = (over: Partial<TimelineLeaf> = {}): TimelineLeaf => ({
  id: "t1", name: "Sample", folderId: null, clips: 3, durationMs: 15_000, bytes: 44 * 2 ** 20, exported: false, unusedTakes: 0, unusedBytes: 0,
  createdAt: "2026-10-08T10:00:00Z", updatedAt: "2026-10-08T10:00:00Z", ...over,
});

describe("a timeline card", () => {
  it("strips the clips in order, each as wide as it plays, a clip to render without a picture", () => {
    expect(stripOf(brief())).toEqual([{ asset: "a1", grow: 7, n: 1 }, { asset: null, grow: 5, n: 2 }, { asset: "a3", grow: 3, n: 3 }]);
    // an older server says nothing per clip: equal widths
    expect(stripOf(brief({ lengths: undefined })).map((f) => f.grow)).toEqual([1, 1, 1]);
    expect(stripOf(brief({ strip: [], cover: null }))).toEqual([]);
  });

  it("says its facts, whatever of them is known", () => {
    expect(factsOf(brief(), leaf())).toBe("3 clips · 0:15 · 1024×576 · 44 MB");
    expect(factsOf(brief({ width: null, height: null, clips: 1 }), undefined)).toBe("1 clip · 0:15");
    expect(factsOf(brief({ clips: 0 }), leaf())).toBe("Empty");
  });

  it("chips what needs doing, the estimate only when the server learned one", () => {
    expect(chipsOf(brief({ toRender: 6 }), leaf(), 29 * 60_000).map((c) => [c.label, c.tone])).toEqual([["6 to render · ~29 min", "warn"]]);
    expect(chipsOf(brief(), leaf(), null)[0]!.label).toBe("1 to render");
    expect(chipsOf(brief({ toRender: 0 }), leaf({ unusedTakes: 12, unusedBytes: 61 * 2 ** 20, exported: true }), null).map((c) => [c.label, c.tone])).toEqual([
      ["12 unused · 61 MB", "neutral"],
      ["exported", "good"],
    ]);
    expect(chipsOf(brief({ toRender: 0, staleJoins: 2 }), undefined, undefined).map((c) => c.label)).toEqual(["2 joins to redo"]);
  });
});
