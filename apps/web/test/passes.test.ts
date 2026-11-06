import { describe, expect, it } from "vitest";
import type { RecipeInfo } from "../src/api";
import { ACTIONS } from "../src/itemActions";
import { jobOfPass, modePass, PASSES, passOf, type PassKey } from "../src/passes";

// the passes on a picture said once (card #290): what was OPS, PASS_KEYS, VERSION_PASSES and MODE_PASS
const tool = { id: "zz-test.paint-over", family: "zz-test", output: "image", op: "inpaint", title: "Inpaint", inputs: [] } as unknown as RecipeInfo;

describe("the passes table", () => {
  it("runs each pass by an item's action, and finds the pass of each action back", () => {
    for (const k of Object.keys(PASSES) as PassKey[]) {
      expect(ACTIONS[PASSES[k].action], k).toBeDefined();
      expect(passOf(PASSES[k].action)).toBe(k);
    }
    expect(passOf("variation")).toBeUndefined();
  });

  it("lands Face, Hand, Inpaint, Edit and Outpaint as versions; Upscale and Remove background as new items", () => {
    const versions = (Object.keys(PASSES) as PassKey[]).filter((k) => PASSES[k].version);
    expect(versions).toEqual(["f", "h", "i", "e", "r"]);
    expect(jobOfPass("i", tool, { source: "zz-test-pic" }, "zz-test-pic")).toEqual({ recipe: tool, stored: { source: "zz-test-pic" }, label: "Inpaint", from: "zz-test-pic", versionOf: "zz-test-pic" });
    expect(jobOfPass("u", tool, {}, "zz-test-pic")).not.toHaveProperty("versionOf");
  });

  it("drives each Stage mode by its pass", () => {
    expect([modePass("paint"), modePass("outpaint"), modePass("edit")]).toEqual(["i", "r", "e"]);
  });
});
