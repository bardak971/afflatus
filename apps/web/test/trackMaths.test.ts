import { describe, expect, it } from "vitest";
import type { Clip } from "../src/api";
import type { Slot } from "../src/timeline/model";
import { clipTarget } from "../src/timeline/track/useTrackDrop";
import { pulledLength, pullRoom, trimOf } from "../src/timeline/track/useStretch";

/** A clip of the track: a rendered video 5 s long unless told, its take playing 1 s to 6 s of a file with 0.5 s of room past each end. */
function clip(id: string, o: Partial<Clip> = {}): Clip {
  return {
    id, kind: "video", joined: "cut", lengthMs: 5000, atMs: 0,
    take: { id: `t-${id}`, headMs: 500, tailMs: 500, startMs: 1000, endMs: 6000, roomMs: 6500 },
    ...o,
  } as unknown as Clip;
}
const slot = (c: Clip, index: number, planned = false): Slot => ({ clip: c, index, startMs: index * 5000, lengthMs: c.lengthMs, left: index * 250, width: 250, planned });

const clips = [clip("a"), clip("b"), clip("c")];
const all = { start: "first", end: "last", mid: "key", midAt: "keyAt" };
const none = { start: undefined, end: undefined, mid: undefined, midAt: undefined };

describe("what a drop on a clip does", () => {
  it("pins a picture as the first frame on the left half, the last on the right, a keyframe in the middle third", () => {
    const s = slot(clips[1]!, 1);
    expect(clipTarget("picture", s, 0.25, 250, clips, all)).toEqual({ kind: "pin", clip: "b", where: "start" });
    expect(clipTarget("picture", s, 0.75, 250, clips, all)).toEqual({ kind: "pin", clip: "b", where: "end" });
    // 0.5 of 5 s: the keyframe at 2.5 s, to the half second
    expect(clipTarget("picture", s, 0.5, 250, clips, all)).toEqual({ kind: "pin", clip: "b", where: "mid", atS: 2.5 });
    expect(clipTarget("picture", s, 0.41, 250, clips, all)).toEqual({ kind: "pin", clip: "b", where: "mid", atS: 2 });
  });

  it("puts it in beside the clip near an edge, on a still, or where the model has no such pin", () => {
    const s = slot(clips[1]!, 1);
    // 18 px of a 250 px clip from either edge
    expect(clipTarget("picture", s, 0.05, 250, clips, all)).toEqual({ kind: "insert", index: 1 });
    expect(clipTarget("picture", s, 0.95, 250, clips, all)).toEqual({ kind: "insert", index: 2 });
    // a narrow clip keeps a fifth of its width on each side
    expect(clipTarget("picture", s, 0.15, 40, clips, all)).toEqual({ kind: "insert", index: 1 });
    expect(clipTarget("picture", s, 0.25, 250, clips, none)).toEqual({ kind: "insert", index: 1 });
    expect(clipTarget("picture", s, 0.75, 250, clips, none)).toEqual({ kind: "insert", index: 2 });
    expect(clipTarget("picture", slot(clip("s", { kind: "still" }), 1), 0.25, 250, clips, all)).toEqual({ kind: "insert", index: 1 });
    expect(clipTarget("video", s, 0.6, 250, clips, all)).toEqual({ kind: "insert", index: 2 });
    expect(clipTarget("clip", s, 0.4, 250, clips, all)).toEqual({ kind: "insert", index: 1 });
  });

  it("gives no first frame to a clip that carries on from the one before", () => {
    const carries = slot(clip("b", { joined: "continue" }), 1);
    expect(clipTarget("picture", carries, 0.25, 250, clips, all)).toEqual({ kind: "insert", index: 1 });
    // the first clip carries on from nothing
    expect(clipTarget("picture", slot(clip("a", { joined: "continue" }), 0), 0.25, 250, clips, all)).toEqual({ kind: "pin", clip: "a", where: "start" });
  });

  it("puts a transition on the nearer join, never before the first clip or after the last", () => {
    expect(clipTarget("transition", slot(clips[1]!, 1), 0.3, 250, clips, all)).toEqual({ kind: "join", clip: "b" });
    expect(clipTarget("transition", slot(clips[1]!, 1), 0.7, 250, clips, all)).toEqual({ kind: "join", clip: "c" });
    expect(clipTarget("transition", slot(clips[0]!, 0), 0.3, 250, clips, all)).toBeNull();
    expect(clipTarget("transition", slot(clips[2]!, 2), 0.7, 250, clips, all)).toBeNull();
  });

  it("gives a sound to a clip that plays, or to a still, not to a clip not rendered yet", () => {
    expect(clipTarget("sound", slot(clips[1]!, 1), 0.5, 250, clips, all)).toEqual({ kind: "sound", clip: "b" });
    expect(clipTarget("sound", slot(clip("p", { take: null }), 1, true), 0.5, 250, clips, all)).toBeNull();
    expect(clipTarget("sound", slot(clip("s", { kind: "still" }), 1, true), 0.5, 250, clips, all)).toEqual({ kind: "sound", clip: "s" });
  });
});

describe("a clip's edge dragged", () => {
  it("reaches as far as the take holds past what is seen, and down to 0.4 s", () => {
    // start: 1 s seen from, 0.5 s of head shared with the clip before → 0.5 s more; end: 0.5 + 6.5 - 6 = 1 s more
    expect(pullRoom(clips[0]!, "start")).toEqual({ least: 400, most: 5500 });
    expect(pullRoom(clips[0]!, "end")).toEqual({ least: 400, most: 6000 });
    expect(pullRoom(clip("s", { kind: "still", take: null, lengthMs: 3000 }), "end")).toEqual({ least: 400, most: 60_000 });
    // a clip already shorter than 0.4 s can keep its length, not grow to it
    expect(pullRoom(clip("short", { lengthMs: 300 }), "end").least).toBe(300);
  });

  it("follows the pointer on tenths of a second, within that room, the start edge the other way", () => {
    const room = { base: 5000, least: 400, most: 6000 };
    expect(pulledLength(room, "end", 432)).toBe(5400);
    expect(pulledLength(room, "start", 432)).toBe(4600);
    expect(pulledLength(room, "end", 5000)).toBe(6000);
    expect(pulledLength(room, "start", 9000)).toBe(400);
  });

  it("asks for the trim by what is seen, a still for its length, nothing when it is back where it was", () => {
    const c = clips[0]!;
    expect(trimOf(c, "start", 5000, 4600)).toEqual({ shownFromMs: 1400 });
    expect(trimOf(c, "end", 5000, 5400)).toEqual({ shownToMs: 6400 });
    expect(trimOf(c, "end", 5000, 5000)).toBeNull();
    expect(trimOf(clip("s", { kind: "still", take: null }), "end", 5000, 2000)).toEqual({ stillMs: 2000 });
  });
});
