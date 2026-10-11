import { describe, expect, it } from "vitest";
import { familyOf, inspect, recipeFromWorkflow, slug, workflowDef } from "../src";
import { catalog, sdxl } from "./fixtures";

// the slug of the old formula, as every workflow imported until now had its ids made with it
const before = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workflow";

describe("a workflow's slugs", () => {
  // the one before last: 48 characters that end in a dash, which the old slug kept
  const names = ["Krea2", "Krea 2 turbo", "Crème brûlée", "夜の街", "  --  ", "abc ".repeat(14).trim(), "Wan 2.2 · I2V (14B)"];

  it("keeps the family id of the workflows already imported, accents and long names too", () => {
    for (const model of names) {
      const def = workflowDef.parse({ id: "workflow.x", title: "x", model, source: "test.json", graph: sdxl, bindings: inspect(sdxl, catalog).suggested });
      expect(familyOf(def).id).toBe(`workflow-${before(model)}`);
    }
  });

  it("keeps a saved workflow's recipe id as it was saved, whatever its title gives today", () => {
    const def = workflowDef.parse({ id: "workflow.cr-me-br-l-e", title: "Crème brûlée", model: "SDXL", source: "test.json", graph: sdxl, bindings: inspect(sdxl, catalog).suggested });
    expect(recipeFromWorkflow(def).id).toBe("workflow.cr-me-br-l-e");
  });

  it("folds accents for a new one; the same as before for a plain title", () => {
    expect(slug("Crème brûlée")).toBe("creme-brulee");
    expect(slug("夜の街")).toBe("workflow");
    for (const plain of ["Krea2", "Krea 2 turbo", "Wan 2.2 · I2V (14B)"]) expect(slug(plain)).toBe(before(plain));
  });
});
