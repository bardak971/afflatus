import { describe, expect, it } from "vitest";
import type { Clip } from "../src/api";
import type { Slot } from "../src/timeline/model";
import { clipTarget } from "../src/timeline/track/useTrackDrop";
import { joinCovered } from "../src/timeline/track/TrackClip";
import { sourceDropClip } from "../src/timeline/track/SourceLane";
import type { RecipeInfo, Timeline } from "../src/api";
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
  it("takes a sound on a rendered clip for its audio, and on a clip not rendered yet for a recording to make Lip sync clips from", () => {
    expect(clipTarget("sound", slot(clips[1]!, 1), 0.5, 250, clips, none)).toEqual({ kind: "sound", clip: "b" });
    expect(clipTarget("sound", slot(clips[1]!, 1, true), 0.5, 250, clips, none)).toEqual({ kind: "recording", clip: "b" });
    // a still keeps taking it as its sound
    const still = clip("s", { kind: "still" } as Partial<Clip>);
    expect(clipTarget("sound", slot(still, 1, true), 0.5, 250, [still], none)).toEqual({ kind: "sound", clip: "s" });
    // nothing on one queued or rendering: made into Lip sync clips in its place, its render would run on with no clip to land in
    const rendering = clip("r", { take: null, job: { id: "zz-test-job", status: "running" } } as unknown as Partial<Clip>);
    expect(clipTarget("sound", slot(rendering, 1, true), 0.5, 250, [rendering], none)).toBeNull();
  });
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

describe("the join's + between two clips", () => {
  const slots = clips.map((c, k) => slot(c, k));
  it("is left out where the selected clip's edge is drawn under it: its start, or the end of the clip before", () => {
    expect(joinCovered(slots, slots[1]!, null)).toBe(false);
    expect(joinCovered(slots, slots[1]!, "b")).toBe(true);
    expect(joinCovered(slots, slots[1]!, "a")).toBe(true);
    expect(joinCovered(slots, slots[2]!, "a")).toBe(false);
    // no edges on a clip not rendered yet, or one in the queue
    const planned = [slots[0]!, slot(clips[1]!, 1, true)];
    expect(joinCovered(planned, planned[1]!, "b")).toBe(false);
    const queued = [slot(clip("a", { job: { id: "zz-test-job", status: "queued" } } as unknown as Partial<Clip>), 0), slots[1]!];
    expect(joinCovered(queued, queued[1]!, "a")).toBe(false);
  });
});

describe("a video dropped on the source lane", () => {
  const swap = { id: "zz-test.swap", inputs: [{ id: "driving", type: "clip", role: "source", window: { start: "start", seconds: "seconds" } }], traits: { windows: {} } } as unknown as RecipeInfo;
  const empty = (id: string, inputs: Record<string, unknown> = {}) => clip(id, { take: null, recipe: swap.id, inputs } as unknown as Partial<Clip>);
  const windowOf = (id: string) => empty(id, { driving: { asset: "zz-test-old" }, start: 0, seconds: 5 });
  it("goes in place of an empty clip given the source's model, the selected one first", () => {
    const t = { clips: [windowOf("w1"), empty("e1"), empty("e2")], source: { asset: "zz-test-old" } } as unknown as Timeline;
    expect(sourceDropClip(t, [swap], null)?.id).toBe("e1");
    expect(sourceDropClip(t, [swap], t.clips[2])?.id).toBe("e2");
  });
  it("never in place of a window of the source the lane has now", () => {
    const t = { clips: [windowOf("w1"), windowOf("w2")], source: { asset: "zz-test-old" } } as unknown as Timeline;
    expect(sourceDropClip(t, [swap], t.clips[1])).toBeUndefined();
  });
});
