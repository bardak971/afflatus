import { describe, expect, it } from "vitest";
import type { Asset, Clip, Take } from "../src/api";
import { fileVersion, moveAfter, playSignature, roomOf } from "../src/timeline/model";
import { blendOf, crossingOf, dissolveOf, fadeIn } from "../src/timeline/useHandover";

/** A clip with only what these sums read. */
const clip = (over: Partial<Clip> & { id: string }): Clip =>
  ({ kind: "video", recipe: "h3.video", inputs: {}, atMs: 0, lengthMs: 3000, takes: [], pictures: [], joined: "continue", join: null, sound: "own", volume: 100, fill: false, soundAsset: null, still: null, take: null, ...over }) as unknown as Clip;
const take = (over: Partial<Take> = {}): Take => ({ id: "t", headMs: 917, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 917, endMs: 3000, asset: { id: "v", durationMs: 3000 } as Asset, ...over }) as Take;

describe("the fade the player shows at a join, the export's", () => {
  const before = clip({ id: "a", take: take({ headMs: 0, startMs: 0 }) });
  it("dissolves a continuation in over the clip before held on its last frame", () => {
    expect(fadeIn(clip({ id: "b", take: take() }), before)).toEqual({ ms: 170, mode: "hold" });
    expect(dissolveOf(clip({ id: "b", take: take() }), before)).toBe(170);
  });
  it("fades a take landed on over the moments both show, within both clips", () => {
    expect(blendOf(clip({ id: "b", take: take({ landedMs: 167 }) }), before)).toBe(167);
    expect(blendOf(clip({ id: "b", take: take({ landedMs: 167 }) }), clip({ id: "a", lengthMs: 100, take: take() }))).toBe(0);
  });
  it("cuts plainly at a seamless join, a cut, after a still, or with too little shared", () => {
    expect(fadeIn(clip({ id: "b", take: take({ seamless: true }) }), before)).toBeNull();
    expect(fadeIn(clip({ id: "b", joined: "cut", take: take() }), before)).toBeNull();
    expect(fadeIn(clip({ id: "b", take: take() }), clip({ id: "s", kind: "still" }))).toBeNull();
    expect(fadeIn(clip({ id: "b", take: take({ headMs: 60 }) }), before)).toBeNull();
  });
});

describe("a clip moved one place", () => {
  const clips = ["a", "b", "c", "d"].map((id) => clip({ id }));
  it("earlier: after the clip two before it, or first", () => {
    expect(moveAfter(clips, "c", -1)).toBe("a");
    expect(moveAfter(clips, "b", -1)).toBeNull();
    expect(moveAfter(clips, "a", -1)).toBeUndefined();
  });
  it("later: after the clip after it; not past the end", () => {
    expect(moveAfter(clips, "b", 1)).toBe("c");
    expect(moveAfter(clips, "d", 1)).toBeUndefined();
  });
});

describe("what the player follows", () => {
  it("keeps its signature when the timeline is read again with nothing that plays changed", () => {
    const one = [clip({ id: "a", take: take() })];
    const again = [clip({ id: "a", take: take(), inputs: { description: "typed" } })];
    expect(playSignature(again)).toBe(playSignature(one));
    expect(playSignature([clip({ id: "a", take: take({ startMs: 1000 }) })])).not.toBe(playSignature(one));
  });
  it("names a file's version, which changes when the file is written again; and a take's room", () => {
    const a = { bytes: 10, createdAt: "2026-10-07T10:00:00.000Z" } as Asset;
    expect(fileVersion(a)).not.toBe(fileVersion({ ...a, bytes: 11 }));
    // the server always says it (takeView.roomMs)
    expect(roomOf({ ...take(), roomMs: 4250 } as Take)).toBe(4250);
  });
});

describe("a cut's transition in the player, the export's", () => {
  const before = clip({ id: "a", take: take({ headMs: 0, startMs: 0 }) });
  const dissolve = { kind: "dissolve" as const, ms: 500, sound: "fade" as const };
  it("plays on a cut, mixing both pictures for a dissolve, through a colour for a dip", () => {
    expect(crossingOf(clip({ id: "b", joined: "cut", transition: dissolve, take: take() }), before)).toEqual({ ms: 500, both: true, fadeSound: true });
    expect(crossingOf(clip({ id: "b", joined: "cut", transition: { kind: "dip-black", ms: 600, sound: "on" }, take: take() }), before)).toEqual({ ms: 600, both: false, fadeSound: false });
  });
  it("not on a join that extends, nor first, and within both clips", () => {
    expect(crossingOf(clip({ id: "b", joined: "continue", transition: dissolve, take: take() }), before)).toBeNull();
    expect(crossingOf(clip({ id: "b", joined: "cut", transition: dissolve, take: take() }), undefined)).toBeNull();
    expect(crossingOf(clip({ id: "b", joined: "cut", transition: dissolve, take: take() }), clip({ id: "a", lengthMs: 200, take: take() }))?.ms).toBe(320);
  });
  it("is part of what the player follows: a new transition is played at once", () => {
    const plain = [before, clip({ id: "b", joined: "cut", take: take() })];
    const faded = [before, clip({ id: "b", joined: "cut", transition: dissolve, take: take() })];
    expect(playSignature(faded)).not.toBe(playSignature(plain));
  });
});
