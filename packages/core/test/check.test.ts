import { describe, expect, it } from "vitest";
import { checkGraph, choicesOf, GraphBuilder, relocateFiles, sameFile, type BuiltGraph, type NodeCatalog } from "../src";

const catalog: NodeCatalog = {
  Loader: { input: { required: { file: [["a.safetensors", "b.safetensors"]] } }, output: ["MODEL"] },
  Sampler: {
    input: {
      required: { model: ["MODEL", {}], steps: ["INT", {}], method: [["euler", "heun"]], mode: ["COMBO", { options: ["fast", "slow"] }] },
      optional: { note: ["STRING", {}] },
    },
    output: ["LATENT"],
  },
  Grow: { input: { optional: { refs: ["COMFY_AUTOGROW_V3", { template: { prefix: "ref_", max: 2 } }] } }, output: [] },
};

function built(make: (g: GraphBuilder) => string): BuiltGraph {
  const g = new GraphBuilder();
  const out = make(g);
  return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads: [] };
}

describe("choicesOf", () => {
  it("reads both encodings of a list of choices", () => {
    expect(choicesOf([["a", "b"]])).toEqual(["a", "b"]);
    expect(choicesOf(["COMBO", { options: ["a", "b"] }])).toEqual(["a", "b"]);
    expect(choicesOf(["INT", {}])).toBeNull();
  });
});

describe("checkGraph", () => {
  it("accepts a valid graph", () => {
    const b = built((g) => g.add("Sampler", { model: g.out("Loader", { file: "mine.safetensors" }), steps: 8, method: "euler", mode: "fast" }));
    expect(checkGraph(b, catalog)).toEqual([]);
  });

  it("reports unknown nodes, missing and unknown inputs, bad links and bad choices", () => {
    const b = built((g) => {
      g.add("Nope", {});
      const loader = g.add("Loader", { file: "x.safetensors" });
      return g.add("Sampler", { model: [loader, 3], method: "dpm", mode: "medium", extra: 1 });
    });
    const problems = checkGraph(b, catalog).join("\n");
    expect(problems).toContain("Nope: unknown node");
    expect(problems).toContain('missing required "steps"');
    expect(problems).toContain('unknown input "extra"');
    expect(problems).toContain("Loader has no output 3");
    expect(problems).toContain('"dpm" is not a choice of "method"');
    expect(problems).toContain('"medium" is not a choice of "mode"');
  });

  it("checks what the outputs are made from: a problem in a side branch does not stop the result", () => {
    const b = built((g) => {
      // a second sampler nothing reads, missing its model: ComfyUI would skip it and run the rest
      g.add("Sampler", { steps: 8, method: "euler", mode: "fast" });
      return g.add("Sampler", { model: g.out("Loader", { file: "a.safetensors" }), steps: 8, method: "euler", mode: "fast" });
    });
    expect(checkGraph(b, catalog)).toEqual([]);
    // a node ComfyUI does not have is another matter: it refuses the whole graph
    b.graph["9"] = { class_type: "Nope", inputs: {} };
    expect(checkGraph(b, catalog)).toEqual(["9 Nope: unknown node"]);
  });

  it("does not check file names against the catalog's files", () => {
    const b = built((g) => g.add("Loader", { file: "someone-elses.safetensors" }));
    expect(checkGraph(b, catalog)).toEqual([]);
    // the saved reference catalog has its file lists emptied
    const emptied: NodeCatalog = { ...catalog, Loader: { input: { required: { file: [[]] } }, output: ["MODEL"] } };
    expect(checkGraph(b, emptied)).toEqual([]);
  });

  it("checks file names when asked to, against the ComfyUI that will run the graph", () => {
    const missing = built((g) => g.add("Loader", { file: "someone-elses.safetensors" }));
    expect(checkGraph(missing, catalog, { files: true })).toEqual(['1 Loader: ComfyUI has no file "someone-elses.safetensors" for "file"']);
    expect(checkGraph(built((g) => g.add("Loader", { file: "a.safetensors" })), catalog, { files: true })).toEqual([]);
    // what was uploaded for this very graph is not in a list read earlier
    expect(checkGraph(missing, catalog, { files: true, uploaded: ["someone-elses.safetensors"] })).toEqual([]);
  });

  it("accepts autogrow inputs within their limit", () => {
    expect(checkGraph(built((g) => g.add("Grow", { "refs.ref_0": 1, "refs.ref_1": 1 })), catalog)).toEqual([]);
    expect(checkGraph(built((g) => g.add("Grow", { "refs.ref_2": 1 })), catalog)).toHaveLength(1);
  });

  it("reports an output that is not in the graph", () => {
    const b = built((g) => g.add("Loader", { file: "a.safetensors" }));
    b.outputs[0]!.node = "99";
    expect(checkGraph(b, catalog)).toEqual(["output result: node 99 is not in the graph"]);
  });
});

describe("a model kept in another sub-folder than the one a graph names", () => {
  it("is the same file: found by its name, whatever the folder and the capitals", () => {
    const offered = ["Wan\\wan_2.1_vae.safetensors", "flux2-vae.safetensors"];
    expect(sameFile(offered, "wan_2.1_vae.safetensors")).toBe("Wan\\wan_2.1_vae.safetensors");
    expect(sameFile(offered, "vae/WAN_2.1_VAE.safetensors")).toBe("Wan\\wan_2.1_vae.safetensors");
    expect(sameFile(offered, "flux2-vae.safetensors")).toBe("flux2-vae.safetensors");
    expect(sameFile(offered, "wan_2.2_vae.safetensors")).toBeUndefined();
  });

  it("is named in the graph as this ComfyUI lists it, and nothing else is touched", () => {
    const listed: NodeCatalog = { ...catalog, Loader: { input: { required: { file: [["sub\\a.safetensors", "b.safetensors"]] } }, output: ["MODEL"] } };
    const graph = {
      "1": { class_type: "Loader", inputs: { file: "a.safetensors" } },
      "2": { class_type: "Loader", inputs: { file: "b.safetensors" } },
      "3": { class_type: "Loader", inputs: { file: "gone.safetensors" } },
      "4": { class_type: "Sampler", inputs: { model: ["1", 0], steps: 20, method: "euler", mode: "fast" } },
    };
    expect(relocateFiles(graph, listed)).toEqual([{ node: "1", input: "file", from: "a.safetensors", to: "sub\\a.safetensors" }]);
    expect(graph["1"].inputs.file).toBe("sub\\a.safetensors");
    expect(graph["3"].inputs.file).toBe("gone.safetensors");
  });
});

describe("checkGraph on someone's own workflow", () => {
  // Impact's switch takes input2, input3… it does not declare; ComfyUI hands a node only what it declares and never refuses the rest
  const g = () => built((b) => b.add("Sampler", { model: b.out("Loader", { file: "a.safetensors" }), steps: 20, method: "euler", mode: "fast", input2: 1 }));
  it("lets an input the node does not declare through", () => {
    expect(checkGraph(g(), catalog, { looseInputs: true })).toEqual([]);
  });
  it("Afflatus's own recipes still have it caught (a renamed input)", () => {
    expect(checkGraph(g(), catalog).join()).toMatch(/unknown input "input2"/);
  });
});

describe("node kinds named like what every object has", () => {
  it("are unknown nodes, not a crash", () => {
    const g: BuiltGraph = { graph: { "1": { class_type: "toString", inputs: {} }, "2": { class_type: "Sampler", inputs: { model: ["1", 0], steps: 1, method: "euler", mode: "fast", constructor: 1 } } }, phases: {}, outputs: [], totalSteps: 1, loads: [] } as unknown as BuiltGraph;
    const problems = checkGraph(g, catalog);
    expect(problems).toContain("1 toString: unknown node");
    expect(problems.join()).toMatch(/unknown input "constructor"/);
    expect(relocateFiles({ "1": { class_type: "constructor", inputs: { a: "x.safetensors" } } }, catalog)).toEqual([]);
  });
});
