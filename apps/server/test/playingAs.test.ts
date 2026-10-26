import { describe, expect, it } from "vitest";
import { carried, markJoins, playingAs, plays, seamless, visible, type AssetRow, type ClipRow, type Placed, type TakeRow } from "../src/timelineModel";

/**
 * A take that does not play, measured as it would play: the joins panel's figures of every take, and its "smoothest", must
 * not change with the take picked. Rows built in memory; nothing is read from a database.
 */

const asset = (id: string, over: Partial<AssetRow> = {}) => ({ id, duration_ms: 5000, fps: 48, latent_frames: null, ...over }) as AssetRow;
const take = (id: string, clip: string, assetId: string, over: Partial<TakeRow> = {}) =>
  ({ id, clip_id: clip, asset_id: assetId, head_ms: 0, tail_ms: 0, trim_start_ms: 0, trim_end_ms: 0, prev_take_id: null, prev_at_ms: null, next_take_id: null, next_at_ms: null, finished_from: null, join_kind: null, ...over }) as TakeRow;
const clip = (id: string, joined: "continue" | "cut") => ({ id, kind: "video", joined }) as ClipRow;

function timeline(playing: "b1" | "b2"): Placed[] {
  const a = { take: take("a1", "A", "va"), asset: asset("va") };
  const end = plays(a).end;
  // b1 was decoded with a1 as it ends now (seamless: a plain cut); b2 too, but after a take that is not there
  const b1 = { take: take("b1", "B", "vb1", { join_kind: "seamless", prev_take_id: "a1", prev_at_ms: end }), asset: asset("vb1") };
  const b2 = { take: take("b2", "B", "vb2", { join_kind: "seamless", prev_take_id: "gone", prev_at_ms: end }), asset: asset("vb2") };
  return [
    { clip: clip("A", "cut"), takes: [a], active: a, still: null, sound: null, pictures: [] },
    { clip: clip("B", "continue"), takes: [b1, b2], active: playing === "b1" ? b1 : b2, still: null, sound: null, pictures: [] },
  ] as Placed[];
}

describe("playingAs", () => {
  it("marks the joins for the take asked, whichever plays", () => {
    // b2 plays; b1 measured as if it did: a seamless join, and the clip before gives back its frame
    const as = playingAs(timeline("b2"), 1, "b1");
    expect(as[1]!.active!.take.id).toBe("b1");
    expect(seamless(as[1]!.active)).toBe(true);
    expect(as[0]!.active!.give).toBeGreaterThan(0);
    // the same as when b1 really plays
    const real = playingAs(timeline("b1"), 1, "b1");
    expect(visible(as[0]!.active!)).toEqual(visible(real[0]!.active!));
    expect(visible(as[1]!.active!)).toEqual(visible(real[1]!.active!));
  });

  it("leaves the timeline it was given as it was", () => {
    const placed = timeline("b2");
    playingAs(placed, 1, "b1");
    expect(placed[1]!.active!.take.id).toBe("b2");
    expect(placed[1]!.takes[0]!.seamed).toBeUndefined();
    expect(placed[0]!.active!.give).toBeUndefined();
  });

  it("a take after another take than its own is no seamless join", () => {
    const as = playingAs(timeline("b1"), 1, "b2");
    expect(seamless(as[1]!.active)).toBe(false);
  });
});

describe("a join that carries the clip before's sound (LTX)", () => {
  const placedWith = (prev: string, trimStart = 0): Placed[] => {
    const a = { take: take("a1", "A", "va", { head_ms: 0 }), asset: asset("va", { fps: 25 }) };
    const b = { take: take("b1", "B", "vb", { head_ms: 1000, join_kind: "carried", prev_take_id: prev, prev_at_ms: plays(a).end, trim_start_ms: trimStart }), asset: asset("vb", { fps: 25 }) };
    return [
      { clip: clip("A", "cut"), takes: [a], active: a, still: null, sound: null, pictures: [] },
      { clip: clip("B", "continue"), takes: [b], active: b, still: null, sound: null, pictures: [] },
    ] as Placed[];
  };
  it("is carried only after the very take it was made from, untrimmed; never seamless, and the clip before gives nothing up", () => {
    const placed = placedWith("a1");
    markJoins(placed);
    expect(carried(placed[1]!.active)).toBe(true);
    expect(seamless(placed[1]!.active)).toBe(false);
    expect(placed[0]!.active!.give ?? 0).toBe(0);
    const other = placedWith("gone");
    markJoins(other);
    expect(carried(other[1]!.active)).toBe(false);
    const trimmed = placedWith("a1", 200);
    markJoins(trimmed);
    expect(carried(trimmed[1]!.active)).toBe(false);
  });
});

describe("a landing under a transition (B8)", () => {
  const placedWith = (transition: string | null): Placed[] => {
    const b = { take: take("b1", "B", "vb"), asset: asset("vb") };
    const a = { take: take("a1", "A", "va", { tail_ms: 500, next_take_id: "b1", next_at_ms: plays(b).start }), asset: asset("va") };
    return [
      { clip: clip("A", "cut"), takes: [a], active: a, still: null, sound: null, pictures: [] },
      { clip: { ...clip("B", "cut"), transition }, takes: [b], active: b, still: null, sound: null, pictures: [] },
    ] as Placed[];
  };
  it("is a landing on a plain cut: the clip before plays into its tail, the clip after starts as much later", () => {
    const placed = placedWith(null);
    markJoins(placed);
    expect(placed[1]!.active!.landed).toBeGreaterThan(0);
    expect(placed[0]!.active!.give).toBeLessThan(0);
  });
  it("is a plain cut under a transition: the shared moments are not shown twice, nor the join made longer", () => {
    const placed = placedWith(JSON.stringify({ kind: "dissolve", ms: 500, sound: "on" }));
    const before = { a: visible(placed[0]!.active!), b: visible(placed[1]!.active!) };
    markJoins(placed);
    expect(placed[1]!.active!.landed).toBeUndefined();
    expect(placed[0]!.active!.give ?? 0).toBe(0);
    expect(visible(placed[0]!.active!)).toEqual(before.a);
    expect(visible(placed[1]!.active!)).toEqual(before.b);
  });
});
