import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import { workOf } from "../src/forecast";

/**
 * Edit in box sends its boxes as one job, each box sampled after the one before (card #284). What it costs on a pod is
 * forecast from its work, the steps of every box added up (the 2026-11-05 review, M6): forecast as one box, an 8-box edit
 * would be priced an eighth of what it runs, and its pod's "stuck" rule would come at an eighth of its time.
 */
const box = (i: number) => ({ id: `b${i}`, box: { x: (i % 4) * 0.25, y: Math.floor(i / 4) * 0.5, w: 0.2, h: 0.4 }, prompt: `zz-test change ${i}` });

describe("an Edit in box job's forecast", () => {
  for (const id of ["klein.edit-in-box", "qwen.edit-in-box"]) {
    it(`${id}: eight boxes are eight boxes' steps, on the same pixels`, () => {
      const recipe = recipeById(id)!;
      // the graph checker's own sample (its family's files, its picture), with the boxes asked
      const v = recipe.variants[0]!;
      const work = (n: number) => {
        const input = parseInput(recipe, { ...(v.input as object), boxes: Array.from({ length: n }, (_, i) => box(i)) });
        return workOf(recipe.build(input, dryContext({ slots: v.slots ?? {}, uploads: v.uploads ?? {}, media: v.media ?? {} })));
      };
      const one = work(1);
      const eight = work(8);
      expect(eight.steps).toBe(8 * one.steps);
      expect(eight.pixels).toBe(one.pixels);
    });
  }
});
