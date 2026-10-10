import { describe, expect, it } from "vitest";
import { fromEditor, toEditor } from "../src";
import { catalog, sdxl, wan } from "./fixtures";

describe("a graph Afflatus runs, as the editor's own file", () => {
  const file = toEditor(sdxl, catalog);
  const node = (type: string) => file.nodes.find((n) => n.type === type)!;

  it("keeps every node, numbered as Afflatus numbered them", () => {
    expect(file.nodes.map((n) => n.id).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(file.last_node_id).toBe(9);
    expect(file.version).toBe(0.4);
  });

  it("writes the widgets in the node list's order, with the seed's control value after the seed", () => {
    // KSampler: seed, control, steps, cfg, sampler_name, scheduler, denoise
    expect(node("KSampler").widgets_values).toEqual([156680208700286, "fixed", 20, 8, "euler", "normal", 1]);
    expect(node("EmptyLatentImage").widgets_values).toEqual([1024, 1024, 1]);
    expect(node("CLIPTextEncode").widgets_values).toEqual(["beautiful scenery, a glass bottle on a beach"]);
  });

  it("links every fed input from the right output slot", () => {
    const sampler = node("KSampler");
    const names = sampler.inputs.map((i) => i.name);
    expect(names).toEqual(["model", "positive", "negative", "latent_image"]);
    const clipLink = file.links.find((l) => l[3] === node("CLIPTextEncode").id)!;
    expect(clipLink[1]).toBe(4); // from the checkpoint loader
    expect(clipLink[2]).toBe(1); // its CLIP output
    expect(clipLink[5]).toBe("CLIP");
    expect(node("CheckpointLoaderSimple").outputs[1]!.links).toHaveLength(2);
    // every link id is given to exactly one input
    const held = file.nodes.flatMap((n) => n.inputs.map((i) => i.link)).filter((l) => l !== null);
    expect(held.sort()).toEqual(file.links.map((l) => l[0]).sort());
  });

  it("lays the nodes out left to right by how far they are from the inputs", () => {
    const x = (type: string) => node(type).pos[0];
    expect(x("CheckpointLoaderSimple")).toBeLessThan(x("CLIPTextEncode"));
    expect(x("CLIPTextEncode")).toBeLessThan(x("KSampler"));
    expect(x("KSampler")).toBeLessThan(x("VAEDecode"));
    expect(x("VAEDecode")).toBeLessThan(x("SaveImage"));
  });

  it("adds the upload button after an image to load, and keeps VHS values by name", () => {
    const video = toEditor(wan, catalog);
    const load = video.nodes.find((n) => n.type === "LoadImage")!;
    expect(load.widgets_values).toEqual(["first.png", "image"]);
    const combine = video.nodes.find((n) => n.type === "VHS_VideoCombine");
    if (combine) {
      expect(Array.isArray(combine.widgets_values)).toBe(false);
      expect((combine.widgets_values as Record<string, unknown>).frame_rate).toBeDefined();
    }
  });

  it("reads back as the same graph through the editor reader", () => {
    const back = fromEditor(toEditor(sdxl, catalog), catalog);
    const plain = (g: typeof sdxl) => Object.fromEntries(Object.entries(g).map(([id, n]) => [id, { class_type: n.class_type, inputs: n.inputs }]));
    expect(plain(back.graph)).toEqual(plain(sdxl));
  });
});

describe("a graph with a node of a kind this ComfyUI lacks, as the editor's file", () => {
  // an API workflow whose pack is not installed: an output used at slot 2 only, and typed-in values the node list cannot name
  const graph = {
    "1": { class_type: "SomePackLoader", inputs: { path: "x.safetensors", strength: 0.5, steps: 4, on: true } },
    "2": { class_type: "VAEDecode", inputs: { samples: ["1", 2], vae: ["1", 0] } },
  };
  const file = toEditor(graph, catalog);
  it("has a slot at every output place, none empty", () => {
    const outs = file.nodes.find((n) => n.type === "SomePackLoader")!.outputs;
    expect(outs).toHaveLength(3);
    expect(outs.every((o) => o && typeof o.slot_index === "number")).toBe(true);
    expect(outs[1]).toEqual({ name: "*", type: "*", links: [], slot_index: 1 });
  });
  it("keeps its typed-in values, and reads back as the same graph", () => {
    const back = fromEditor(JSON.parse(JSON.stringify(file)), catalog);
    expect(back.graph["1"]).toMatchObject({ class_type: "SomePackLoader", inputs: graph["1"].inputs });
    expect(back.graph["2"]!.inputs).toEqual(graph["2"].inputs);
  });
});
