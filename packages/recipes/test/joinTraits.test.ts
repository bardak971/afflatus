import { describe, expect, it } from "vitest";
import { joinFrames, LATENT_FPS, LATENT_GRID, type Recipe } from "@afflatus/core";
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
  it("every H3 form", () => {
    expect(latent.map((r) => r.id).sort()).toEqual(["h3.lipsync", "h3.motion", "h3.swap", "h3.swapMotion", "h3.video"]);
  });
  it.each(latent.map((r) => [r.id, r] as const))("%s: on the kept latent's rate and grid, with the node that cuts it", (_id, r) => {
    expect(r.traits!.fps).toBe(LATENT_FPS);
    expect(r.traits!.frameGrid).toEqual(LATENT_GRID);
    expect(r.traits!.latentTrim).toBeTruthy();
  });
});
