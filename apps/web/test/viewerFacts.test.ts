import { describe, expect, it } from "vitest";
import type { Asset, ClipOf } from "../src/api";
import { factsOf, placesOf } from "../src/viewer/facts";

const asset = (id: string, over: Partial<Asset> = {}): Asset => ({
  id, kind: "image", origin: "generated", name: "", mime: "image/png", bytes: 3 * 1024 * 1024, width: 1536, height: 864, durationMs: null, fps: null, hasSound: false,
  kept: false, inBin: false, folderId: null, generationId: null, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), path: null, ...over,
});
const clip = (timeline: string, n: number): ClipOf => ({ timeline, timelineName: `Timeline ${timeline}`, clip: n, take: 1, takes: 1, playing: true, upscaledBy: null });
const g = { id: "g", recipe: "r", family: "f", inputs: {}, resolved: {}, tookMs: 21_000 };

describe("the viewer's facts line", () => {
  it("says what made a picture, its size, its file, when and how long it took", () => {
    expect(factsOf(asset("a"), g, "Model · Text to image")).toBe("Model · Text to image · 1536×864 · PNG 3 MB · 5 min ago · rendered in 21 s");
  });
  it("leaves the title out when it is the name already, and says nothing of a render it did not have", () => {
    expect(factsOf(asset("a"), null, "")).toBe("1536×864 · PNG 3 MB · 5 min ago");
  });
  it("gives a video its length, speed and whether it is silent", () => {
    const v = asset("v", { kind: "video", mime: "video/mp4", durationMs: 5000, fps: 24, hasSound: false, bytes: 2048 });
    expect(factsOf(v, null, "")).toBe("1536×864 · 5.0 s · 24 fps · silent · MP4 2 KB · 5 min ago");
  });
  it("gives a sound its length and no size", () => {
    const s = asset("s", { kind: "audio", mime: "audio/wav", width: null, height: null, durationMs: 75_000, bytes: 2048 });
    expect(factsOf(s, null, "Uploaded")).toBe("Uploaded · 1:15 · WAV 2 KB · 5 min ago");
  });
});

describe("the timeline clips it is in", () => {
  it("lists its own clip first, then those of what was made from it, once each", () => {
    const used = [asset("u1", { clipOf: clip("x", 2) }), asset("u2", { clipOf: clip("x", 2) }), asset("u3"), asset("u4", { clipOf: clip("y", 1) })];
    expect(placesOf(clip("z", 3), used).map((p) => `${p.of.timeline}:${p.of.clip}:${p.own}`)).toEqual(["z:3:true", "x:2:false", "y:1:false"]);
  });
  it("is empty for an item on no timeline", () => {
    expect(placesOf(null, [asset("u")])).toEqual([]);
  });
});
