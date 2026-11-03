import { describe, expect, it } from "vitest";
import { FIT, fitted, held, oneToOne, panBy, placed, shownPercent, toggled, wheelFactor, zoomAround, type Size, type Zoom } from "../src/viewer/zoom";

/** A picture's view (viewer/zoom.ts): wheel zoom around the pointer, pan, fit / 1:1, one view for two panes. */

const room: Size = { w: 800, h: 600 };
const square: Size = { w: 1024, h: 1024 };

/** The point of the picture (in parts of it) shown at `at` of the room, for a view. */
const under = (v: Zoom, fit: Size, at: { x: number; y: number }) => {
  const p = placed(v, fit, room);
  return { x: (at.x - p.left) / (fit.w * p.scale), y: (at.y - p.top) / (fit.h * p.scale) };
};

describe("a picture's zoom", () => {
  it("fits whole at its own shape, never past its pixels unless asked", () => {
    expect(fitted(square, room)).toEqual({ w: 600, h: 600 });
    expect(fitted({ w: 300, h: 200 }, room)).toEqual({ w: 300, h: 200 });
    expect(fitted({ w: 300, h: 200 }, room, true)).toEqual({ w: 800, h: 800 * (200 / 300) });
    expect(fitted({ w: 0, h: 0 }, room)).toEqual({ w: 0, h: 0 });
  });

  it("keeps the point under the pointer where it is as the wheel zooms", () => {
    const fit = fitted(square, room);
    const at = { x: 610, y: 120 };
    const before = under(FIT, fit, at);
    const v = zoomAround(FIT, 3, at, fit, room, 8);
    expect(v.zoom).toBe(3);
    const after = under(v, fit, at);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("never leaves an empty edge zoomed in, and is fitted again below 1", () => {
    const fit = fitted(square, room);
    const v = panBy({ zoom: 2, fx: 0.5, fy: 0.5 }, 5000, -5000, fit, room);
    const p = placed(v, fit, room);
    // dragged far right and up: the picture's left edge stops at the room's, its bottom at the room's bottom
    expect(p.left).toBeCloseTo(0, 6);
    expect(p.top + fit.h * 2).toBeCloseTo(room.h, 6);
    expect(held({ zoom: 0.5, fx: 0.1, fy: 0.9 }, fit, room)).toEqual(FIT);
    expect(held({ zoom: 99, fx: 0.5, fy: 0.5 }, fit, room, 8).zoom).toBe(8);
  });

  it("goes to 1:1 at the point double-clicked, and back to fitted", () => {
    const fit = fitted(square, room);
    const one = toggled(FIT, { x: 400, y: 300 }, square, fit, room);
    expect(one.zoom).toBeCloseTo(oneToOne(square, fit), 6);
    expect(shownPercent(one, square, fit)).toBe(100);
    expect(toggled(one, { x: 10, y: 10 }, square, fit, room)).toEqual(FIT);
    // a small picture is at its pixels already: nowhere to go
    const small = { w: 200, h: 100 };
    expect(toggled(FIT, { x: 400, y: 300 }, small, fitted(small, room), room)).toEqual(FIT);
  });

  it("shows the same part of two pictures of different sizes at one view: Compare's two sides in step", () => {
    // an Upscale 2x beside its source, in panes of different sizes
    const source = fitted(square, room);
    const otherRoom = { w: 700, h: 600 };
    const big = { w: 2048, h: 2048 };
    const result = fitted(big, otherRoom);
    const v = zoomAround(FIT, 4, { x: 200, y: 150 }, source, room, 16);
    const a = placed(held(v, source, room, 16), source, room);
    const b = placed(held(v, result, otherRoom, 16), result, otherRoom);
    // the picture's point at the middle of each pane is the same one
    const mid = (p: { left: number; top: number; scale: number }, fit: Size, r: Size) => ({ x: (r.w / 2 - p.left) / (fit.w * p.scale), y: (r.h / 2 - p.top) / (fit.h * p.scale) });
    expect(mid(b, result, otherRoom).x).toBeCloseTo(mid(a, source, room).x, 6);
    expect(mid(b, result, otherRoom).y).toBeCloseTo(mid(a, source, room).y, 6);
    // and at the same size against its pane; the readout says the result's pixels are half as large
    expect(shownPercent(v, big, result)).toBe(Math.round(shownPercent(v, square, source) / 2));
  });

  it("zooms a mouse's notch by about a fifth either way, a trackpad's small steps by little", () => {
    expect(wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeCloseTo(Math.exp(0.2), 6);
    expect(wheelFactor({ deltaY: 100, deltaMode: 0 })).toBeLessThan(1);
    expect(wheelFactor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(Math.exp(0.198), 6);
    expect(wheelFactor({ deltaY: -4, deltaMode: 0 })).toBeLessThan(1.01);
    // a flung wheel is one big step, not a jump to the end
    expect(wheelFactor({ deltaY: -5000, deltaMode: 0 })).toBeCloseTo(Math.exp(0.4), 6);
  });
});
