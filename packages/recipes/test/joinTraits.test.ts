import { describe, expect, it } from "vitest";
import { clockFits, H3_CLOCK, joinFrames, joinWay, LATENT_FPS, LATENT_GRID, type Recipe } from "@afflatus/core";
import { recipeById, recipes } from "../src/index";

/**
 * What the timeline reads of a recipe to join its clips, rather than H3's own ids and figures: the frames a join takes come
 * from the input its clip input names, and a recipe that joins in a kept latent is on that latent's rate and grid.
 */
describe("the frames a join takes", () => {
  const h3 = recipeById("h3.video")!;
  it("the count the form asks", () => {
    expect(joinFrames(h3, "previous", { context: "39" })).toBe(39);
    expect(joinFrames(h3, "next", { landing: "5" })).toBe(5);
  });
  it("else the input's default", () => {
    expect(joinFrames(h3, "previous")).toBe(22);
    expect(joinFrames(h3, "next")).toBe(22);
  });
  it("a recipe with no such clip: none", () => {
    expect(joinFrames(recipeById("scail.motion"), "next")).toBe(0);
    expect(joinFrames(undefined, "previous")).toBe(0);
  });
  it("a clip input with no count of its own to choose: its first count (LTX's 25)", () => {
    expect(joinFrames(recipeById("ltx.video"), "previous")).toBe(25);
  });
});

describe("recipes that join in a kept latent", () => {
  const latent = recipes.filter((r: Recipe<any>) => r.traits?.latentNodes?.length);
  it("every H3 form, and LTX 2.3 and 2.5 with their Lip sync (pack 0.37.0)", () => {
    expect(latent.map((r) => r.id).sort()).toEqual(["h3.lipsync", "h3.motion", "h3.swap", "h3.video", "ltx.lipsync", "ltx.video", "ltx25.lipsync", "ltx25.video"]);
  });
  it.each(latent.filter((r) => r.family === "h3").map((r) => [r.id, r] as const))("%s: on H3's kept latent's rate and grid, with the node that cuts it", (_id, r) => {
    expect(r.traits!.fps).toBe(LATENT_FPS);
    expect(r.traits!.frameGrid).toEqual(LATENT_GRID);
    expect(r.traits!.latentTrim).toBeTruthy();
    // a latent kept without a clock is H3's, which every H3 form continues
    expect(clockFits(H3_CLOCK, r)).toBe(true);
  });
  it("LTX on its own model's rate and grid: a latent of one LTX continued by that LTX only", () => {
    const [ltx, ltx25] = [recipeById("ltx.video")!, recipeById("ltx25.video")!];
    for (const r of [ltx, ltx25]) expect(r.traits).toMatchObject({ frameGrid: { step: 8, offset: 1 }, latentTrim: "AfflatusTrimLTXLatent" });
    const clock = { family: "ltx", fps: 25, grid: { step: 8, offset: 1 } };
    expect(clockFits(clock, ltx)).toBe(true);
    expect(clockFits(clock, ltx25)).toBe(false);
    expect(clockFits(clock, recipeById("h3.video"))).toBe(false);
    expect(clockFits(H3_CLOCK, ltx)).toBe(false);
  });
});

describe("how a clip meets the one before it, by default (the join rule)", () => {
  const r = (id: string) => recipeById(id)!;
  it("seamless between any two H3 forms: they carry on in one kept latent", () => {
    for (const [a, b] of [["h3.video", "h3.lipsync"], ["h3.lipsync", "h3.video"], ["h3.motion", "h3.video"], ["h3.swap", "h3.motion"], ["h3.motion", "h3.swap"], ["h3.video", "h3.swap"], ["h3.motion", "h3.motion"]]) {
      expect(joinWay(r(a!), r(b!))).toBe("seamless");
    }
  });
  it("on frames within a family that keeps no latent: SCAIL-2's windows", () => {
    expect(joinWay(r("scail.motion"), r("scail.motion"))).toBe("frames");
    // SCAIL-2 at 16 fps then at 24 (review H-12): the frames handed over are another rate's, met as a cut
    expect(joinWay(r("scail.motion"), r("scail.motion24"))).toBe("cut");
    expect(joinWay(r("scail.motion24"), r("scail.motion24"))).toBe("frames");
  });
  it("seamless between two clips of one LTX: it carries on in its kept latent; a cut across LTX 2.3 and 2.5", () => {
    expect(joinWay(r("ltx.video"), r("ltx.video"))).toBe("seamless");
    expect(joinWay(r("ltx25.video"), r("ltx25.video"))).toBe("seamless");
    expect(joinWay(r("ltx.video"), r("ltx25.video"))).toBe("cut");
  });
  it("a cut when the model changes, or when nothing is before it", () => {
    expect(joinWay(r("h3.video"), r("ltx.video"))).toBe("cut");
    expect(joinWay(r("scail.motion"), r("h3.video"))).toBe("cut");
    expect(joinWay(r("h3.motion"), r("scail.motion"))).toBe("cut");
    expect(joinWay(undefined, r("h3.video"))).toBe("cut");
  });
  it("a cut after anything for a model that cannot carry on", () => {
    expect(joinWay(r("h3.video"), { family: "h3", traits: { continues: false } })).toBe("cut");
  });
});

describe("recipes whose takes a finish can Face refine", () => {
  it("every H3 form and SCAIL-2 at 24 fps say so in their traits, naming an input they have; no other recipe", () => {
    const refining = recipes.filter((r: Recipe<any>) => r.traits?.faceRefine);
    expect(refining.map((r) => r.id).sort()).toEqual(["h3.lipsync", "h3.motion", "h3.swap", "h3.video", "scail.motion24"]);
    for (const r of refining) expect(r.inputs.some((i) => i.id === r.traits!.faceRefine), r.id).toBe(true);
  });
});
