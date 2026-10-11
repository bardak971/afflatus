import { describe, expect, it } from "vitest";
import { recipes } from "../src";

/**
 * A picture, clip, sound or reference slot shows its "?" from the input's note: a slot without one is the only field of
 * its form with nothing to explain it (the Keyframe, an Image or a Mask once were).
 */
describe("every built-in recipe's media slots", () => {
  for (const recipe of recipes) {
    it(`${recipe.id}: each has a note for its "?"`, () => {
      const bare = recipe.inputs.filter((i) => ["image", "clip", "sound", "references"].includes(i.type) && !("note" in i && i.note)).map((i) => i.id);
      expect(bare).toEqual([]);
    });
  }
});
