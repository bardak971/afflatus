import { describe, expect, it } from "vitest";
import { PAD } from "../src/timeline/model";
import { edgeGive, follow, releaseSpeed, resisted, rubberband, stepSpring, type Trail } from "../src/timeline/track/spring";
import { leftsOf, orderWhileDragged } from "../src/timeline/track/useClipDrag";

describe("the clip drag's spring", () => {
  it("reaches its target without passing it, from rest or carrying a speed towards it", () => {
    for (const v of [0, 800, 3000]) {
      const s = { x: 0, v, to: 200 };
      let most = -Infinity;
      let frames = 0;
      while (!stepSpring(s, 1 / 60) && frames < 600) {
        most = Math.max(most, s.x);
        frames++;
      }
      // critically damped: never past 200, and at rest within about a second
      expect(most).toBeLessThanOrEqual(200);
      expect(s.x).toBe(200);
      expect(s.v).toBe(0);
      expect(frames).toBeLessThan(60);
    }
  });

  it("takes a speed away from its target and comes back without a bounce past it", () => {
    const s = { x: 100, v: -1500, to: 100 };
    const seen: number[] = [];
    while (!stepSpring(s, 1 / 60)) seen.push(s.x);
    expect(Math.min(...seen)).toBeLessThan(100);
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
  });

  it("stays put on a long frame rather than overshooting", () => {
    const s = { x: 0, v: 0, to: 300 };
    stepSpring(s, 2);
    expect(s.x).toBe(300);
  });

  it("reads the release speed from the last moves only, and none once the pointer stopped", () => {
    const trail: Trail = [];
    for (let t = 0; t <= 300; t += 16) follow(trail, t * 2, t);
    // 2 px a millisecond: 2000 px a second
    expect(releaseSpeed(trail, 300)).toBeCloseTo(2000, 0);
    expect(trail.length).toBeLessThan(10);
    // held still for longer than the trail before letting go: no throw
    expect(releaseSpeed(trail, 600)).toBe(0);
  });

  it("resists past a bound, less and less the further it is pulled", () => {
    const a = rubberband(20, 200);
    const b = rubberband(200, 200);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(20);
    expect(b - a).toBeLessThan(200 - 20);
  });

  it("holds a trim's edge within its limits as drawn: past them it gives less and less, never more than its size", () => {
    // within: where it is asked
    expect(resisted(50, 0, 100, 80)).toBe(50);
    // past either bound, by the skill's curve (constant 0.55): 20 px past an 80 px give is drawn 9.7 px past
    expect(resisted(120, 0, 100, 80)).toBeCloseTo(100 + (20 * 80 * 0.55) / (80 + 0.55 * 20), 6);
    expect(resisted(-20, 0, 100, 80)).toBeCloseTo(-(20 * 80 * 0.55) / (80 + 0.55 * 20), 6);
    expect(resisted(120, 0, 100, 80)).toBeCloseTo(109.67, 2);
    // the further, the less it follows, and never as far as its give, however far the pointer goes
    const overs = [10, 50, 200, 1000, 100_000];
    const drawn = overs.map((over) => resisted(100 + over, 0, 100, 80) - 100);
    for (let k = 1; k < overs.length; k++) expect((drawn[k]! - drawn[k - 1]!) / (overs[k]! - overs[k - 1]!)).toBeLessThan((drawn[k - 1]! - (drawn[k - 2] ?? 0)) / (overs[k - 1]! - (overs[k - 2] ?? 0)));
    expect(drawn.at(-1)!).toBeLessThan(80);
    // under reduced motion it stops at the bound, as it always did
    expect(resisted(120, 0, 100, 80, false)).toBe(100);
    expect(resisted(-20, 0, 100, 80, false)).toBe(0);
    // a pair of equal bounds is a point it resists toward from either side (an end onto a rendered window)
    expect(resisted(90, 100, 100, 80)).toBeLessThan(100);
    expect(resisted(90, 100, 100, 80)).toBeGreaterThan(90);
  });

  it("gives an edge as much as its width, from 40 px to 240", () => {
    expect(edgeGive(10)).toBe(40);
    expect(edgeGive(120)).toBe(120);
    expect(edgeGive(5000)).toBe(240);
  });
});

describe("the order while a clip is dragged", () => {
  const widths = new Map([["a", 100], ["b", 200], ["c", 100]]);
  const order = ["a", "b", "c"];

  it("lays the clips edge to edge from the track's start", () => {
    expect([...leftsOf(["b", "a", "c"], widths)]).toEqual([["b", PAD], ["a", PAD + 200], ["c", PAD + 300]]);
  });

  it("swaps a clip with the next once its middle passes the next one's middle", () => {
    // a at PAD + 99: its middle at PAD + 149, short of b's (PAD + 200)
    expect(orderWhileDragged(order, "a", PAD + 99, widths)).toEqual(order);
    expect(orderWhileDragged(order, "a", PAD + 151, widths)).toEqual(["b", "a", "c"]);
    // past c's middle too: last
    expect(orderWhileDragged(order, "a", PAD + 400, widths)).toEqual(["b", "c", "a"]);
  });

  it("puts a clip first only once its middle is before the first one's", () => {
    expect(orderWhileDragged(order, "c", PAD + 20, widths)).toEqual(["a", "c", "b"]);
    expect(orderWhileDragged(order, "c", PAD - 10, widths)).toEqual(["c", "a", "b"]);
    expect(orderWhileDragged(order, "c", PAD - 80, widths)).toEqual(["c", "a", "b"]);
  });
});
