import { describe, expect, it } from "vitest";
import { forecastFrom, said, workOf, workOfRow } from "../src/forecast";

describe("what a render will take, learned from the renders before it", () => {
  // a card at its usual pace up to 130 M units of work, then streaming its weights: three times the cost per unit
  const points = [
    { work: 100e6, stepMs: 12_000 }, { work: 120e6, stepMs: 14_500 }, { work: 128e6, stepMs: 16_000 }, { work: 130e6, stepMs: 16_500 },
    { work: 160e6, stepMs: 50_000 }, { work: 165e6, stepMs: 53_000 },
  ];

  it("places a render among the usual ones, beyond them, or past the cliff, and prices each from its neighbours", () => {
    const usual = forecastFrom(points, 110e6, 15, 60_000)!;
    expect(usual.pace).toBe("usual");
    expect(usual.fitsUpTo).toBe(130e6);
    // between 12 s and 14.5 s a step, 15 steps, plus the minute around the sampling
    expect(usual.ms).toBeGreaterThan(15 * 12_000 + 60_000);
    expect(usual.ms).toBeLessThan(15 * 14_500 + 60_000);
    const over = forecastFrom(points, 162e6, 15, 60_000)!;
    expect(over.pace).toBe("over");
    expect(over.ms).toBeGreaterThan(15 * 48_000);
    // larger than any usual render, short of the cliff: the usual pace assumed, said as untested
    expect(forecastFrom(points, 150e6, 15, 0)!.pace).toBe("untested");
  });

  it("says nothing without renders or without work, and never blames a card that never slowed down", () => {
    expect(forecastFrom([], 100e6, 15, 0)).toBeNull();
    expect(forecastFrom(points, 0, 15, 0)).toBeNull();
    const steady = forecastFrom(points.slice(0, 4), 200e6, 15, 0)!;
    expect(steady.pace).toBe("untested");
  });

  it("takes one slow render for no cliff: two are needed, both larger than the largest at the usual pace", () => {
    const usual = points.slice(0, 4);
    // one render that was slow for some other reason (the machine busy, a cold disk): larger forms keep the usual pace
    const once = [...usual, { work: 140e6, stepMs: 60_000 }];
    expect(forecastFrom(once, 150e6, 15, 0)!.pace).toBe("untested");
    expect(forecastFrom(once, 200e6, 15, 0)!.pace).toBe("untested");
    // a slow render among usual ones of its size says nothing of the card either
    const among = [...usual, { work: 110e6, stepMs: 40_000 }, { work: 112e6, stepMs: 40_000 }];
    expect(forecastFrom(among, 150e6, 15, 0)!.pace).toBe("untested");
    // two past the largest usual one: that is where the card slows down
    const twice = [...once, { work: 150e6, stepMs: 60_000 }];
    expect(forecastFrom(twice, 145e6, 15, 0)!.pace).toBe("over");
    expect(forecastFrom(twice, 135e6, 15, 0)!.pace).not.toBe("over");
  });

  it("is said as a line, with the setting's word only past the cliff", () => {
    const shape = { pixels: 768 * 1344, frames: 158 };
    const over = said({ ms: 14 * 60_000, pace: "over", fitsUpTo: 768 * 1344 * 141, samples: 6, loadMs: 0 }, shape);
    expect(over.text).toContain("About 14 min");
    expect(over.text).toContain("up to 141 frames at this size");
    expect(over.hint).toContain("141 frames");
    expect(said({ ms: 45_000, pace: "usual", fitsUpTo: 1e6, samples: 3, loadMs: 0 }, { pixels: 1e6, frames: 1 })).toEqual({ text: "About 45 s, from your renders with this model.", hint: null });
    expect(said({ ms: 200_000, pace: "untested", fitsUpTo: 1e6, samples: 3, loadMs: 0 }, { pixels: 2e6, frames: 1 }).hint).toBeNull();
  });

  it("reads a graph's work off its nodes: the largest canvas, the frame count, the steps", () => {
    const built = {
      graph: {
        "1": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
        "2": { class_type: "MiniMaxH3ImageToVideo", inputs: { width: 768, height: 1344, length: 141 } },
        "3": { class_type: "KSampler", inputs: { steps: 15 } },
      },
      phases: {}, outputs: [], totalSteps: 15, loads: [],
    };
    expect(workOf(built)).toEqual({ pixels: 1024 * 1024, frames: 141, steps: 15 });
  });
});

describe("the work of a render whose nodes do not say its frames", () => {
  it("takes the frames the recipe says: a continuation window counts them in its own terms, a latent loaded from a file not at all", () => {
    const window = {
      graph: {
        "1": { class_type: "MiniMaxH3GuidedContinuationWindow", inputs: { overlap_frames: 22, extension_frames: 153 } },
        "2": { class_type: "MiniMaxH3ImageToVideo", inputs: { width: 576, height: 1024, length: ["1", 1] } },
      },
      phases: {}, outputs: [], totalSteps: 8, loads: [],
    };
    // read off the nodes alone, one frame: the render was put on record a hundred times too small
    expect(workOf(window).frames).toBe(1);
    expect(workOf({ ...window, frames: 175 })).toEqual({ pixels: 576 * 1024, frames: 175, steps: 8 });
  });

  it("reads a render recorded before that with its frames, from its length, and leaves the row itself as it was", () => {
    const fps = (id: string) => (id === "h3.video" ? 24 : undefined);
    const old = { recipe_id: "h3.video", kind: "video" as const, width: 576, height: 1024, duration_ms: 5854, work: 576 * 1024 };
    // 141 frames at 24 a second, said 5854 ms long (half a frame short)
    expect(workOfRow(old, fps)).toBe(576 * 1024 * 141);
    expect(old.work).toBe(576 * 1024);
    // upscaled after it: a quarter of its shown size, still one frame
    expect(workOfRow({ ...old, width: 1152, height: 2048 }, fps)).toBe(576 * 1024 * 141);
    // a video whose work counted its frames, and a picture, are read as they are
    expect(workOfRow({ ...old, work: 576 * 1024 * 141 }, fps)).toBe(576 * 1024 * 141);
    expect(workOfRow({ ...old, kind: "image", duration_ms: null }, fps)).toBe(576 * 1024);
    // a recipe whose speed is not known: left out rather than taken a hundred times too small
    expect(workOfRow({ ...old, recipe_id: "workflow.zz-test-clip" }, fps)).toBeNull();
    expect(workOfRow({ ...old, work: null }, fps)).toBeNull();
  });
});

