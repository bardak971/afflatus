import { describe, expect, it } from "vitest";
import { frameAt, frameSpan, lastFrame, rangeEnds, stepFrames } from "../src/frameStep";

describe("frame stepping", () => {
  it("steps by the index of the frame shown, to the middle of the next one", () => {
    // 24 fps: frame 1 starts at 41.67 ms; a step from frame 0 lands inside frame 1, not on its edge
    expect(stepFrames(0, 1, 24, 4000)).toBeCloseTo(62.5, 6);
    expect(frameAt(stepFrames(0, 1, 24, 4000), 24)).toBe(1);
    // every step shows a new frame, at 24 and at 16 fps, forward and back
    for (const fps of [24, 16, 30, 48]) {
      let at = 0;
      const seen = [frameAt(at, fps)];
      for (let i = 0; i < 40; i++) {
        at = stepFrames(at, 1, fps, 4000);
        seen.push(frameAt(at, fps));
      }
      expect(seen).toEqual(Array.from({ length: 41 }, (_, k) => k));
      for (let i = 0; i < 40; i++) at = stepFrames(at, -1, fps, 4000);
      expect(frameAt(at, fps)).toBe(0);
    }
  });

  it("reads a moment on a frame's edge as that frame, even with the rounding of k / fps", () => {
    expect(frameAt(1000 / 24, 24)).toBe(1);
    expect(frameAt((5 * 1000) / 24, 24)).toBe(5);
    expect(frameAt(62.5, 16)).toBe(1);
  });

  it("stays inside the file: no frame before the first, none past the last", () => {
    expect(lastFrame(4000, 24)).toBe(95);
    expect(frameAt(stepFrames(100, -10, 24, 4000), 24)).toBe(0);
    expect(frameAt(stepFrames(3990, 10, 24, 4000), 24)).toBe(95);
  });

  it("sets In on the frame shown and Out after it", () => {
    // the middle of frame 3 at 24 fps: In at its start, Out at its end (frame 3 is the last one in)
    const span = frameSpan(145.8, 24);
    expect(span.startMs).toBeCloseTo(125, 6);
    expect(span.endMs).toBeCloseTo(166.67, 2);
  });
});

describe("a range's first and last frame (Generate between)", () => {
  it("takes the last frame inside Out, not the one after it", () => {
    // In on frame 10, Out after frame 20 (where frame 21 starts), as Trim's I and O set them
    for (const fps of [24, 16, 30]) {
      const range = { startMs: frameSpan(10 * (1000 / fps) + 1, fps).startMs, endMs: frameSpan(20 * (1000 / fps) + 1, fps).endMs };
      const { firstMs, lastMs } = rangeEnds(range, fps);
      expect(frameAt(firstMs, fps)).toBe(10);
      expect(frameAt(lastMs, fps)).toBe(20);
    }
  });
  it("gives one frame twice for a range of one frame", () => {
    const { firstMs, lastMs } = rangeEnds(frameSpan(100, 24), 24);
    expect(frameAt(firstMs, 24)).toBe(2);
    expect(frameAt(lastMs, 24)).toBe(2);
  });
});
