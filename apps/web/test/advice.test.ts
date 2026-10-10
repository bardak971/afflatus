import { describe, expect, it } from "vitest";
import { roughly } from "@afflatus/core";
import { batchAbout } from "../src/advice";
import { aboutMs } from "../src/format";

describe("what Generate says it will take", () => {
  it("is the form's forecast, rounded as the Output line rounds it, the model loaded once for the batch", () => {
    // the Output line is "About <roughly(ms)>, …" (the server's forecast.said): one render says the same figure
    for (const ms of [3_000, 44_000, 46_000, 89_000, 91_000, 14 * 60_000]) expect(batchAbout({ ms, loadMs: 0 }, 1)).toBe(`about ${roughly(ms)}`);
    expect(batchAbout({ ms: 70_000, loadMs: 30_000 }, 1)).toBe(aboutMs(70_000));
    // four renders, a model to load first: the load once, the render four times
    expect(batchAbout({ ms: 70_000, loadMs: 30_000 }, 4)).toBe(aboutMs(30_000 + 4 * 40_000));
    expect(batchAbout(null, 3)).toBe("");
  });
});
