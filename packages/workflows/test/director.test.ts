import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { fillDirector, inspect, recipeFromWorkflow, type WorkflowDef } from "../src";
import { catalog } from "./fixtures";

/** The DaSiWa H3 Director takes its frames in its own canvas (timeline_data), not from a Load Image. */
const director = (mode: string, items: unknown[] = []): Graph => ({
  "1": { class_type: "MiniMaxH3Director", inputs: { mode, prompt: "a boat on a lake", width: 512, height: 384, duration: 2, ref_image_size: "match", timeline_data: JSON.stringify({ version: 1, items, prompt_blocks: [] }), builder_state: "", frame_rate: 24 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } },
});
const itemsOf = (g: Graph) => JSON.parse(String(g["1"]!.inputs.timeline_data)).items as Array<{ type: string; value: string; slot: number }>;

describe("the Director's picture slots", () => {
  it("take the start image in slot 0 and the end image in slot 1, in the shape its editor writes, replacing the author's", () => {
    const g = director("FL2VA", [{ type: "image", value: "author/first.png", slot: 0 }, { type: "audio", value: "voice.wav", slot: 0 }]);
    fillDirector(g, "1", { start: "afflatus/a.png", end: "afflatus/b.png" });
    expect(itemsOf(g)).toEqual([
      { type: "audio", value: "voice.wav", slot: 0 },
      { id: "afflatus_image_0", type: "image", value: "afflatus/a.png", slot: 0, start: 0, duration: 1, enabled: true, order: 1 },
      { id: "afflatus_image_1", type: "image", value: "afflatus/b.png", slot: 1, start: 1, duration: 1, enabled: true, order: 2 },
    ]);
    expect(g["1"]!.inputs.mode).toBe("FL2VA");
  });

  it("make a mode that would not read the picture given one that does, and leave one that reads it", () => {
    const t2va = director("T2VA");
    fillDirector(t2va, "1", { start: "afflatus/a.png" });
    expect(t2va["1"]!.inputs.mode).toBe("I2VA");
    const last = director("T2VA");
    fillDirector(last, "1", { end: "afflatus/b.png" });
    expect(last["1"]!.inputs.mode).toBe("L2VA");
    const fl = director("FL2VA");
    fillDirector(fl, "1", { start: "afflatus/a.png" });
    expect(fl["1"]!.inputs.mode).toBe("FL2VA");
    const plain = director("T2VA");
    fillDirector(plain, "1", {});
    expect(plain["1"]!.inputs.mode).toBe("T2VA");
    expect(itemsOf(plain)).toEqual([]);
  });

  it("say so in plain words when a picture mode has no picture, or when its data is not what Afflatus knows", () => {
    expect(() => fillDirector(director("I2VA"), "1", {})).toThrow(/give it a start image, or set it to T2VA/);
    expect(() => fillDirector(director("L2VA"), "1", {})).toThrow(/give it an end image/);
    const odd = director("I2VA");
    odd["1"]!.inputs.timeline_data = JSON.stringify({ items: { first: "x.png" } });
    expect(() => fillDirector(odd, "1", { start: "a.png" })).toThrow(/not supported yet/);
  });

  it("are the form's Start and End image, uploaded to ComfyUI's input folder; a clip on a timeline can open on a frame", () => {
    const g = director("I2VA");
    const found = inspect(g, catalog);
    const b = found.suggested!;
    expect(b.director).toEqual({ node: "1" });
    expect(b.startImage).toBeUndefined();
    const def: WorkflowDef = { id: "w", title: "t", model: "H3", source: "t.json", graph: g as WorkflowDef["graph"], bindings: b };
    const recipe = recipeFromWorkflow(def);
    expect(recipe.inputs.find((i) => i.id === "startImage")).toMatchObject({ type: "image", role: "start", folder: "input", optional: true });
    expect(recipe.inputs.find((i) => i.id === "endImage")).toMatchObject({ type: "image", role: "end", folder: "input" });
    const built = recipe.build(parseInput(recipe, { startImage: "a" }), dryContext({ uploads: { startImage: "afflatus/a.png" } }));
    expect(itemsOf(built.graph).map((i) => [i.slot, i.value])).toEqual([[0, "afflatus/a.png"]]);
  });
});
