import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { windowsReaching, type SourcePlan } from "../src/timelineSource";
import type { AssetRow } from "../src/timelineModel";
import { makeApp, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

const plan = (windowMs: number): SourcePlan => ({ asset: "zz-v", atMs: 0, fromMs: 0, toMs: 20000, recipe: "h3.swap", windowMs, inputs: {}, snap: false, clip: null });
const video = { id: "zz-v" } as AssetRow;
const scenes = async () => ({ cuts: [] });
const frame = 1000 / 24;

describe("the windows that must reach a part kept removed (card #114)", () => {
  it("shares the stretch so that the last window ends on the part's start when the grid allows it", async () => {
    const recipe = t.services.registry.recipe("h3.swap")!;
    // 226 frames (17k + 5): one window of 107 and one of 141 carrying 22 meet it, though 3 s windows were asked for
    const w = (await windowsReaching(plan(3000), recipe, video, scenes, { fromMs: 0, edgeMs: 226 * frame, limitMs: 20000 }))!;
    expect(Math.abs(w.at(-1)!.toMs - 226 * frame)).toBeLessThanOrEqual(frame / 2);
  });

  it("runs past the part's start by the least the grid leaves when it cannot end there", async () => {
    const recipe = t.services.registry.recipe("h3.swap")!;
    // 100 frames: no count on H3's 17k + 5 grid ends there; 107 runs past by 7
    const w = (await windowsReaching(plan(4000), recipe, video, scenes, { fromMs: 0, edgeMs: 100 * frame, limitMs: 20000 }))!;
    expect(Math.round((w.at(-1)!.toMs - 100 * frame) / frame)).toBe(7);
  });
});
