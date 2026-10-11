import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { inspect, recipeFromWorkflow, type WorkflowDef } from "../src";
import { wiring } from "../src/types";
import { catalog, sdxl } from "./fixtures";

const defOf = (graph: Graph, bindings: WorkflowDef["bindings"], w?: WorkflowDef["wiring"]): WorkflowDef =>
  ({ id: "w", title: "T", model: "SDXL", source: "t.json", graph: graph as WorkflowDef["graph"], bindings, ...(w ? { wiring: w } : {}) });

/**
 * Wan's sampler says "to the end" with end_step -1. Imported while its pack is missing, the range used to
 * be 0..100: the first parse filled -1 in, and every later parse of the stored inputs refused it.
 */
describe("an imported setting keeps its value inside its range", () => {
  // a model patch of a pack this ComfyUI lacks, in the model's way: only the file's own socket types are known
  const graph: Graph = {
    ...sdxl,
    "50": { class_type: "WanVideoPatch", inputs: { model: ["4", 0], end_step: -1 } },
    "3": { ...sdxl["3"]!, inputs: { ...sdxl["3"]!.inputs, model: ["50", 0] } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: { "50": { in: [["model", "MODEL"], ["end_step", "INT"]], out: ["MODEL"] } }, packs: { WanVideoPatch: "wanvideo" } });
  const parsedTwice = (def: WorkflowDef, id: string) => {
    const recipe = recipeFromWorkflow(def);
    const once = parseInput(recipe, {}) as Record<string, unknown>;
    expect(once[id]).toBe(-1);
    // what a job stores is read again by the timeline plan and Render again
    const again = parseInput(recipe, JSON.parse(JSON.stringify(once))) as Record<string, unknown>;
    expect(again[id]).toBe(-1);
    recipe.build(again, dryContext());
  };

  it("from a node of a kind this ComfyUI lacks", () => {
    const found = inspect(graph, catalog, w);
    const c = found.candidates.find((x) => x.target.node === "50" && x.target.input === "end_step");
    expect(c).toBeDefined();
    expect(c!.min).toBeLessThanOrEqual(-1);
    const { classType: _c, title: _t, suggested: _s, byAuthor: _a, off: _o, offers: _f, ...control } = c!;
    parsedTwice(defOf(graph, { ...found.suggested!, controls: [...found.suggested!.controls, control] }, w), control.id);
  });

  it("from a catalog range far below the value", () => {
    const listed = { ...catalog, WanVideoPatch: { input: { required: { model: ["MODEL"], end_step: ["INT", { default: -1, min: -10000, max: 10000 }] } }, output: ["MODEL"], output_name: ["MODEL"], name: "WanVideoPatch", display_name: "WanVideoPatch", category: "x" } } as typeof catalog;
    const c = inspect(graph, listed).candidates.find((x) => x.target.node === "50" && x.target.input === "end_step");
    expect(c!.min).toBeLessThanOrEqual(-1);
  });

  it("heals a workflow saved with the old range when it is built", () => {
    const found = inspect(graph, catalog, w);
    const control = { id: "ctl_50_end_step", label: "end step", target: { node: "50", input: "end_step" }, kind: "number" as const, default: -1, min: 0, max: 100, step: 1 };
    parsedTwice(defOf(graph, { ...found.suggested!, controls: [...found.suggested!.controls, control] }, w), control.id);
  });
});
