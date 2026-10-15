import { describe, expect, it } from "vitest";
import { roughly } from "@afflatus/core";
import { batchAbout, batchMs } from "../src/advice";
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

describe("what Generate says a batch takes with several machines", () => {
  const advice = { ms: 70_000, loadMs: 0, on: { m1: 40_000, m2: 70_000, m3: 40_000 }, loadOn: { m1: 0, m2: 30_000, m3: 0 } };
  it("on Auto, shares the batch between the machines Auto may give it to, each loading the model once", () => {
    // two machines holding the model take four renders in two renders' time
    expect(batchMs({ ...advice, ms: 40_000, auto: ["m1", "m3"] }, 4)).toBe(80_000);
    // one that must load it first takes a render only when it ends it sooner
    expect(batchMs({ ...advice, ms: 40_000, auto: ["m1", "m2"] }, 3)).toBe(80_000);
    expect(batchMs({ ...advice, ms: 40_000, auto: ["m1", "m2"] }, 5)).toBe(120_000);
    // one machine (or none said): in a row on it
    expect(batchMs({ ...advice, ms: 40_000, auto: ["m1"] }, 4)).toBe(160_000);
    expect(batchAbout({ ms: 40_000, loadMs: 0, on: advice.on, loadOn: advice.loadOn, auto: ["m1", "m3"] }, 4)).toBe(aboutMs(80_000));
  });

  it("on a machine picked by hand, its own render and its own load", () => {
    expect(batchMs(advice, 2, { id: "m2", pace: 1 })).toBe(30_000 + 2 * 40_000);
    // one with no figure of its own: the common one at its pace
    expect(batchMs({ ms: 40_000, loadMs: 10_000, on: {} }, 2, { id: "m9", pace: 2 })).toBe(10_000 + 2 * (80_000 - 10_000));
  });
});
