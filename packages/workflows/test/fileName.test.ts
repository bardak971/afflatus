import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { inspect, recipeFromWorkflow, type WorkflowDef } from "../src";
import { catalog, sdxl } from "./fixtures";

/**
 * The default text-to-image workflow, its save node's file name built by a chain of nodes of packs this
 * ComfyUI lacks (the seed as text, the date, joined), a sound when done from another missing pack, and a
 * preview of its own. The seed node feeds the sampler too, so it stays.
 */
const graph: Graph = {
  ...sdxl,
  "3": { ...sdxl["3"]!, inputs: { ...sdxl["3"]!.inputs, seed: ["30", 0] } },
  "30": { class_type: "PrimitiveInt", inputs: { value: 7 } },
  "31": { class_type: "CR Integer To String", inputs: { int_: ["30", 0] } },
  "32": { class_type: "Get Date Time String (JPS)", inputs: { current_date: "yyyy-MM-dd" } },
  "33": { class_type: "JoinStringMulti", inputs: { string_a: ["31", 0], string_b: ["32", 0], delimiter: "_" } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: ["33", 0], images: ["8", 0] } },
  "40": { class_type: "PlaySound|pysssss", inputs: { any: ["8", 0], mode: "always", volume: 0.5, file: "notify.mp3" } },
  "41": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
};

describe("a file name built by a chain of nodes", () => {
  const found = inspect(graph, catalog);

  it("is not asked for: the chain's packs are not missing, and a sound when done is left out", () => {
    expect(found.missingNodes).toEqual([]);
    expect(found.missingUnneeded).toEqual(["PlaySound|pysssss"]);
    expect(found.suggested!.result).toMatchObject({ node: "9", kind: "image" });
    // the seed node feeds the sampler: it is still there, and still the seed
    expect(found.suggested!.seeds).toEqual([{ node: "30", input: "value" }]);
  });

  it("is given a plain name at build, the chain gone, the rest as it was", () => {
    const def: WorkflowDef = { id: "w", title: "Two Dogs", model: "SDXL", source: "t.json", graph: graph as WorkflowDef["graph"], bindings: found.suggested! };
    const recipe = recipeFromWorkflow(def);
    const built = recipe.build(parseInput(recipe, { prompt: "a dog" }), dryContext({ has: (c) => c in catalog }));
    expect(built.graph["9"]!.inputs.filename_prefix).toBe("two-dogs");
    for (const id of ["31", "32", "33"]) expect(built.graph[id]).toBeUndefined();
    expect(built.graph["30"]).toBeDefined();
    expect(built.graph["41"]).toBeDefined();
    // the sound node's kind is missing and the result does not need it: left out
    expect(built.graph["40"]).toBeUndefined();
    expect(recipe.nodes(parseInput(recipe, {}))).not.toContain("JoinStringMulti");
  });
});
