import { describe, expect, it } from "vitest";
import { boxFrom, frameOf, percentOf, roomToPicture } from "../src/stageLayer/geometry";
import { fitted, placed } from "../src/viewer/zoom";

const natural = { w: 1216, h: 832 };
const room = { w: 1000, h: 800 };

describe("the room's pixels in the picture's", () => {
  it("puts the fitted picture's corner at its edge and the room's middle at its middle", () => {
    const fit = fitted(natural, room);
    const shown = placed({ zoom: 1, fx: 0.5, fy: 0.5 }, fit, room);
    const frame = frameOf(natural);
    const middle = roomToPicture({ x: room.w / 2, y: room.h / 2 }, shown, fit, frame);
    expect(middle.x).toBeCloseTo(608);
    expect(middle.y).toBeCloseTo(416);
    const corner = roomToPicture({ x: shown.left, y: shown.top }, shown, fit, frame);
    expect(corner.x).toBeCloseTo(0);
    expect(corner.y).toBeCloseTo(0);
  });

  it("zoomed in, says the pixel under the pointer", () => {
    const fit = fitted(natural, room);
    // three times closer, the picture's point at 30 %, 70 % in the room's middle
    const shown = placed({ zoom: 3, fx: 0.3, fy: 0.7 }, fit, room);
    const p = roomToPicture({ x: room.w / 2, y: room.h / 2 }, shown, fit, frameOf(natural));
    expect(p.x).toBeCloseTo(1216 * 0.3);
    expect(p.y).toBeCloseTo(832 * 0.7);
    // one screen pixel to the right is a third of a fitted pixel further
    const q = roomToPicture({ x: room.w / 2 + 1, y: room.h / 2 }, shown, fit, frameOf(natural));
    expect(q.x - p.x).toBeCloseTo(1216 / 1000 / 3);
  });

  it("in a frame grown around the picture, says the picture's own pixels (outside it below 0)", () => {
    const frame = { w: 1408, h: 960, x: 192, y: 128 };
    const fit = fitted(frame, room);
    const shown = placed({ zoom: 1, fx: 0.5, fy: 0.5 }, fit, room);
    const corner = roomToPicture({ x: shown.left, y: shown.top }, shown, fit, frame);
    expect(corner.x).toBeCloseTo(-192);
    expect(corner.y).toBeCloseTo(-128);
  });

  it("places a rect in percent of the frame", () => {
    expect(percentOf({ x: 0, y: 0, w: 608, h: 416 }, frameOf(natural))).toEqual({ left: "0%", top: "0%", width: "50%", height: "50%" });
    expect(percentOf({ x: 0, y: 0, w: 100, h: 100 }, { w: 200, h: 200, x: 100, y: 0 }).left).toBe("50%");
  });
});

describe("boxes", () => {
  it("makes a box from a drag either way round, holding a ratio when asked", () => {
    expect(boxFrom({ x: 50, y: 50 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, w: 40, h: 30 });
    expect(boxFrom({ x: 10, y: 10 }, { x: 40, y: 20 }, 1)).toEqual({ x: 10, y: 10, w: 30, h: 30 });
    expect(boxFrom({ x: 100, y: 100 }, { x: 90, y: 40 }, 2)).toEqual({ x: -20, y: 40, w: 120, h: 60 });
  });
});
