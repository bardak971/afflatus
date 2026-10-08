import { describe, expect, it } from "vitest";
import type { Asset } from "../src/api";
import { fitFrame, frameUrl, Lru, onFrame, peekHeight, pinCompare, pinnedNote, pinTitle, placeCard, takeLabel } from "../src/timeline/track/peek";

describe("the hover cards over the track", () => {
  it("draws a frame that lies as wide as the card, and one that stands as tall as it allows", () => {
    expect(fitFrame(1024, 576, { w: 320, h: 240 })).toEqual({ w: 320, h: 180 });
    expect(fitFrame(576, 1024, { w: 320, h: 240 })).toEqual({ w: 135, h: 240 });
    expect(fitFrame(512, 512, { w: 320, h: 240 })).toEqual({ w: 240, h: 240 });
    // a size not known yet: drawn as a wide picture
    expect(fitFrame(null, null, { w: 380, h: 380 })).toEqual({ w: 380, h: 214 });
  });

  it("centres the card on the pointer, keeps it between the edges, and its arrow on the pointer off its corners", () => {
    expect(placeCard(500, 338, 8, 1432)).toEqual({ left: 331, arrow: 169 });
    // near the left edge: the card stops, the arrow moves along it
    expect(placeCard(40, 338, 8, 1432)).toEqual({ left: 8, arrow: 32 });
    expect(placeCard(1430, 338, 8, 1432)).toEqual({ left: 1094, arrow: 322 });
    // the pointer past the edge: the arrow stays off the rounded corner
    expect(placeCard(0, 338, 8, 1432).arrow).toBe(16);
    // no room for it: it starts at the left edge
    expect(placeCard(100, 338, 8, 200).left).toBe(8);
  });

  it("asks for a frame twice as tall as it is drawn, within what the peek route gives", () => {
    expect(peekHeight(180)).toBe(360);
    expect(peekHeight(240)).toBe(480);
    expect(peekHeight(300)).toBe(480);
    expect(peekHeight(10)).toBe(48);
  });

  it("puts a moment on the video's frames, so that one frame is asked for once", () => {
    expect(onFrame(1010, 25)).toBe(1000);
    expect(onFrame(1039, 25)).toBe(1000);
    expect(onFrame(1040, 25)).toBe(1040);
    // never past the moment: 20 ms before the end of a 48 fps video stays inside its last frame
    expect(onFrame(85313, 48)).toBeLessThanOrEqual(85313);
    expect(onFrame(1000, null)).toBe(1000);
    expect(onFrame(-5, 24)).toBe(0);
    const a = { id: "v1", fps: 25, bytes: 10, createdAt: "2026-10-08T00:00:00Z" } as Asset;
    expect(frameUrl(a, 1013, 180)).toBe(`/api/assets/v1/peek?at=1000&h=360&v=10-${Date.parse("2026-10-08T00:00:00Z")}`);
  });

  it("says what is pinned to a clip not rendered yet", () => {
    expect(pinnedNote({})).toBeNull();
    expect(pinnedNote({ end: true })).toBe("last frame pinned");
    expect(pinnedNote({ start: true })).toBe("first frame pinned");
    expect(pinnedNote({ start: true, end: true })).toBe("first and last frames pinned");
    expect(pinnedNote({ start: true, mid: true })).toBe("first frame and keyframe pinned");
    expect(pinnedNote({ start: true, mid: true, end: true })).toBe("first, key and last frames pinned");
  });

  it("names a pinned picture by its place and its clip", () => {
    expect(pinTitle("end", 4)).toBe("Last frame · clip 4");
    expect(pinTitle("start", 1)).toBe("First frame · clip 1");
    expect(pinTitle("mid", 4, 2.5)).toBe("Keyframe at 2.5 s · clip 4");
  });

  it("stands the take's first, last or keyframe moment against the picture pinned there", () => {
    const take = { headMs: 400, startMs: 400, endMs: 7700 };
    expect(pinCompare(take, "start")).toEqual({ atMs: 400, shownMs: 0 });
    expect(pinCompare(take, "end")).toEqual({ atMs: 7640, shownMs: 7300 });
    // the keyframe: its moment of what the model made, after the run-up
    expect(pinCompare(take, "mid", 2.5)).toEqual({ atMs: 2900, shownMs: 2500 });
    // trimmed away: the frame is still there to see, but it does not play
    expect(pinCompare({ headMs: 0, startMs: 3000, endMs: 5000 }, "mid", 2.5)).toEqual({ atMs: 2500, shownMs: null });
    expect(takeLabel(2, 7300)).toBe("take 2 · 0:07.3");
    expect(takeLabel(1, null)).toBe("take 1 · trimmed off");
  });

  it("keeps the pictures used last, letting go of the one used longest ago", () => {
    const lru = new Lru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("a")).toBe(true);
    lru.set("a", 4);
    lru.set("d", 5);
    expect(lru.has("c")).toBe(false);
    expect(lru.get("a")).toBe(4);
    expect(lru.count).toBe(2);
  });
});
