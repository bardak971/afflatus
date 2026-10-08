import { describe, expect, it } from "vitest";
import type { Asset } from "../src/api";
import { tileName } from "../src/screens/Library";

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: "a", kind: "image", origin: "generated", name: "", mime: "image/png", bytes: 1, width: 832, height: 1216, durationMs: null, fps: null, hasSound: false,
  kept: true, inBin: false, folderId: null, generationId: null, createdAt: "2026-10-06T10:00:00Z", path: null, clipOf: null, draftOf: null, ...over,
});

describe("what a tile is called", () => {
  it("its own name; the name worked out from where it came from when its own says nothing; else the draft, the clip, what it is", () => {
    expect(tileName(asset({ name: "Harbor walk 01" }))).toBe("Harbor walk 01");
    expect(tileName(asset({ name: "video · finished ×2 (upscale model)", shownName: "Big Air · c2 · t5 · finished ×2" }))).toBe("Big Air · c2 · t5 · finished ×2");
    expect(tileName(asset({ shownName: "Big Air · c2 · t5 · frame" }))).toBe("Big Air · c2 · t5 · frame");
    expect(tileName(asset({ draftOf: { id: "d", name: "two gulls on a post" } }))).toBe("two gulls on a post");
    expect(tileName(asset({ kind: "video", clipOf: { timeline: "t", timelineName: "Big Air", clip: 2, take: 1, takes: 1, playing: true, upscaledBy: null } }))).toBe("Big Air · clip 2");
    expect(tileName(asset())).toBe("Picture");
  });
});
