import { describe, expect, it } from "vitest";
import type { Graph } from "@afflatus/core";
import {
  ancestors, fromEditor, graph as graphSchema, inspect, isEditorFormat, isSamplingPass, isWidget, MAX_DEPTH, MAX_OPENED, recipeFromWorkflow, splitCaptions, suggestSections,
  titleParts, UnreadableWorkflow, wiring as wiringSchema, workflowDef, type WorkflowDef,
} from "../src";
import { catalog } from "./fixtures";

/**
 * Files written by hand to hold what a shared workflow can hold that ComfyUI's editor would never write, and what
 * the corpus showed being misread. The corpus itself is not published: these are what CI sees of it.
 */
type Socket = { name: string; type: string; link?: number | null; widget?: { name: string }; label?: string };
const socket = (name: string, type: string, link: number | null = null): Socket => ({ name, type, link });
const field = (name: string, type: string, link: number | null = null): Socket => ({ name, type, link, widget: { name } });
const node = (id: number | string, type: string, more: Record<string, unknown> = {}) => ({ id, type, pos: [0, 0], mode: 0, inputs: [] as Socket[], outputs: [] as unknown[], ...more });
const file = (nodes: unknown[], links: unknown[] = [], more: Record<string, unknown> = {}) => ({ nodes, links, ...more });

describe("a file that names what reaches an object's prototype", () => {
  // a node of a kind this ComfyUI lacks, its input both linked and typed: the reader once wrote its typed value under the node's id
  const polluting = (id: string, input = "polluted") => file([
    node(2, "Source", { outputs: [{ type: "STRING", links: [1] }] }),
    node(id, "Sink", { inputs: [field(input, "STRING", 1)], widgets_values: ["PWNED"] }),
  ], [[1, 2, 0, id, 0, "STRING"]]);

  it("is refused, and nothing reaches Object.prototype", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      expect(() => fromEditor(polluting(id), catalog), id).toThrow(UnreadableWorkflow);
    }
    expect(() => fromEditor(polluting("5", "__proto__"), catalog)).toThrow(/Afflatus does not take/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads a kind of node named like a member of Object as a kind this ComfyUI lacks, not as Object's", () => {
    const read = fromEditor(file([
      node(1, "constructor", { outputs: [{ type: "IMAGE", links: [1] }] }),
      node(2, "SaveImage", { inputs: [socket("images", "IMAGE", 1), field("filename_prefix", "STRING")], widgets_values: ["out"] }),
    ], [[1, 1, 0, 2, 0, "IMAGE"]]), catalog);
    expect(read.graph["1"]!.class_type).toBe("constructor");
    const found = inspect(read.graph, catalog, read.wiring, read.notes);
    expect(found.missingNodes).toEqual(["constructor"]);
    // and a graph held as Afflatus keeps it, with a kind named so, is read the same way
    const held: Graph = { "1": { class_type: "toString", inputs: {} }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "x" } } };
    expect(inspect(held, catalog).missingNodes).toEqual(["toString"]);
  });

  it("is refused, or left out, in a graph or a wiring that Afflatus keeps", () => {
    // "__proto__" as a key is dropped by the schema; the other names are refused
    const held = graphSchema.parse(JSON.parse('{"__proto__": {"class_type": "SaveImage", "inputs": {}}}'));
    expect(Object.keys(held)).toEqual([]);
    expect(Object.getPrototypeOf(held)).toBe(Object.prototype);
    expect(graphSchema.safeParse({ "1": { class_type: "SaveImage", inputs: JSON.parse('{"constructor": 1}') } }).success).toBe(false);
    expect(graphSchema.safeParse(JSON.parse('{"prototype": {"class_type": "SaveImage", "inputs": {}}}')).success).toBe(false);
    const base = { modes: {}, slots: {}, fallback: {} };
    expect(Object.keys(wiringSchema.parse({ ...base, fallback: JSON.parse('{"__proto__": {"polluted": 1}}') }).fallback)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a group node whose links do not arrive where their slot says", () => {
  const DEF = "aaaaaaaa-0000-4000-8000-000000000001";
  const read = fromEditor(file([
    node(4, "CheckpointLoaderSimple", { inputs: [field("ckpt_name", "COMBO")], outputs: [{ type: "MODEL", links: [1] }], widgets_values: ["m.safetensors"] }),
    node(3, DEF, { title: "Sampling", inputs: [socket("model", "MODEL", 1)], widgets_values: [20, 7] }),
  ], [[1, 4, 0, 3, 0, "MODEL"]], {
    definitions: { subgraphs: [{
      id: DEF, name: "Sampling", inputNode: { id: -10 }, outputNode: { id: -20 },
      inputs: [{ name: "model", type: "MODEL", linkIds: [11] }, { name: "steps", type: "INT", linkIds: [12] }, { name: "cfg", type: "FLOAT", linkIds: [13] }],
      outputs: [],
      nodes: [node(10, "KSampler", {
        inputs: [socket("model", "MODEL", 11), field("seed", "INT"), field("steps", "INT", 12), field("cfg", "FLOAT", 13), field("sampler_name", "COMBO"), field("scheduler", "COMBO"), field("denoise", "FLOAT")],
        widgets_values: [1, "fixed", 30, 8, "euler", "normal", 1],
      })],
      // the link into "steps" says slot 0, which is the model's socket: the socket that names the link is the one
      links: [
        { id: 11, origin_id: -10, origin_slot: 0, target_id: 10, target_slot: 0 },
        { id: 12, origin_id: -10, origin_slot: 1, target_id: 10, target_slot: 0 },
        { id: 13, origin_id: -10, origin_slot: 2, target_id: 10, target_slot: 3 },
      ],
    }] },
  }), catalog);

  it("reads the values on its front onto the fields they belong to", () => {
    expect(read.graph["3:10"]!.inputs).toMatchObject({ steps: 20, cfg: 7, model: ["4", 0] });
    expect(read.notes).toEqual([]);
  });
});

describe("a node of a pack this ComfyUI lacks, saved with more values than its file names fields for", () => {
  const read = (values: unknown[], inputs: Socket[]) => fromEditor(file([
    node(1, "PackResize", { title: "Resize", inputs, outputs: [{ type: "IMAGE", links: [1] }], widgets_values: values }),
    node(2, "SaveImage", { inputs: [socket("images", "IMAGE", 1), field("filename_prefix", "STRING")], widgets_values: ["out"] }),
  ], [[1, 1, 0, 2, 0, "IMAGE"]]), catalog);

  it("is not read by place when the values would land on fields of another type, and says so", () => {
    // the file names three fields; the two values of a mode it does not name sit between them
    const r = read(["Total Pixels", 1280, 768, "bicubic", 1], [field("scale_mode", "COMBO"), field("upscale_method", "COMBO"), field("megapixels", "FLOAT")]);
    expect(r.graph["1"]!.inputs).toEqual({});
    expect(r.notes).toEqual([expect.stringMatching(/"Resize" is from a node pack this ComfyUI does not have, and holds 5 values for the 3 fields .*read once its pack is installed/)]);
  });

  it("is read by place when every value fits its field (a trailing value of the editor's own), a linked seed's slot is stepped over, and the note names it", () => {
    const r = read([7, null, "euler", 1.5, "preview"], [field("seed", "INT", null), field("sampler", "COMBO"), field("scale", "FLOAT")]);
    expect(r.graph["1"]!.inputs).toEqual({ seed: 7, sampler: "euler", scale: 1.5 });
    // read, but said: the places are a guess until the pack is in (HIGH 7)
    expect(r.notes).toEqual(['The values of "Resize" were read by position because its pack is missing: check them once the pack is installed.']);
  });
});

describe("a file that would open its group nodes for ever", () => {
  const group = (id: string, inside: unknown[]) => ({ id, name: id, inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [], outputs: [], nodes: inside, links: [] });

  it("is refused when a group node holds itself", () => {
    const f = file([node(1, "loop")], [], { definitions: { subgraphs: [group("loop", [node(1, "loop")])] } });
    expect(() => fromEditor(f, catalog)).toThrow(/holds itself/);
  });

  it(`is refused past ${MAX_DEPTH} levels`, () => {
    const defs = Array.from({ length: MAX_DEPTH + 2 }, (_, i) => group(`g${i}`, i < MAX_DEPTH + 1 ? [node(1, `g${i + 1}`)] : [node(1, "KSampler")]));
    expect(() => fromEditor(file([node(1, "g0")], [], { definitions: { subgraphs: defs } }), catalog)).toThrow(/more than 8 deep/);
    // eight levels are read
    const fine = Array.from({ length: MAX_DEPTH }, (_, i) => group(`g${i}`, i < MAX_DEPTH - 1 ? [node(1, `g${i + 1}`)] : [node(1, "EmptyLatentImage", { widgets_values: [512, 512, 1] })]));
    expect(Object.keys(fromEditor(file([node(1, "g0")], [], { definitions: { subgraphs: fine } }), catalog).graph)).toEqual([`${"1:".repeat(MAX_DEPTH)}1`]);
  });

  it(`is refused, quickly, when opening it would make more than ${MAX_OPENED} nodes`, () => {
    // ten of the next level in each, five levels: a hundred thousand nodes
    const defs = Array.from({ length: 5 }, (_, i) => group(`f${i}`, Array.from({ length: 10 }, (_, k) => node(k + 1, i < 4 ? `f${i + 1}` : "EmptyLatentImage"))));
    const t = performance.now();
    expect(() => fromEditor(file([node(1, "f0")], [], { definitions: { subgraphs: defs } }), catalog)).toThrow(UnreadableWorkflow);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("a file whose texts are made to be slow to read", () => {
  it("keeps 80 links of a note, and reads a long note in one pass", () => {
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"-".repeat(50)} https://example.org/${i}`).join("\n");
    const t = performance.now();
    const read = fromEditor(file([node(1, "Note", { widgets_values: [text] })]), catalog);
    expect(read.wiring.links).toHaveLength(80);
    expect(read.wiring.links[0]).toEqual({ label: `line 0 ${"-".repeat(50)}`.replace(/[- ]+$/, ""), url: "https://example.org/0" });
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("cuts titles and labels, and reads runs of spaces and dashes in linear time", () => {
    const long = `A${" -".repeat(50_000)}x`;
    const read = fromEditor(file([node(1, "EmptyLatentImage", { title: long, widgets_values: [512, 512, 1], groups: [] })], [], { groups: [{ title: long, bounding: [-10, -10, 100, 100] }] }), catalog);
    expect((read.graph["1"] as unknown as { _meta: { title: string } })._meta.title.length).toBeLessThanOrEqual(200);
    expect(read.wiring.frames[0]!.title.length).toBeLessThanOrEqual(200);
    const t = performance.now();
    titleParts(`a${" ".repeat(100_000)}b`);
    titleParts(`a${"-".repeat(100_000)}b`);
    titleParts(`${"(".repeat(50_000)}x`);
    splitCaptions(`a${" ".repeat(100_000)}true =${" ".repeat(100_000)}x`);
    splitCaptions(`${":".repeat(100_000)}true = A ${" ".repeat(100_000)}| false = B`);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(splitCaptions("WAN22: True = I2V | False = FLF2V")).toEqual({ label: "WAN22", captions: { on: "I2V", off: "FLF2V" } });
  });
});

describe("a file whose shape is not the editor's", () => {
  it("is refused in plain words, not with a TypeError", () => {
    for (const bad of [file([null]), file([node(1, 5 as unknown as string)]), file([node(1, "SaveImage", { inputs: [{ name: 3 }] })]), { nodes: "x", links: [] }]) {
      expect(() => fromEditor(bad, catalog)).toThrow(/could not be read as a workflow of ComfyUI's editor/);
    }
  });
});

describe("where a file says its packs come from", () => {
  it("takes an id of ComfyUI's registry, and not an address the file chose", () => {
    const read = fromEditor(file([
      node(1, "PackA", { properties: { cnr_id: "comfyui-pack-a" } }),
      node(2, "PackB", { properties: { cnr_id: "https://github.com/someone/anything" } }),
      node(3, "PackC", { properties: { cnr_id: "../../x" } }),
    ]), catalog);
    expect({ ...read.wiring.packs }).toEqual({ PackA: "comfyui-pack-a" });
  });
});

describe("what crosses the edge of a group node", () => {
  const DEF = "bbbbbbbb-0000-4000-8000-000000000002";
  const read = fromEditor(file([
    node(1, "EmptyLatentImage", { outputs: [{ type: "LATENT", links: [1] }], widgets_values: [512, 512, 1] }),
    node(2, "SetNode", { inputs: [socket("LATENT", "LATENT", 1)], widgets_values: ["latent"] }),
    node(5, "VAEDecode", { inputs: [socket("samples", "LATENT", null), socket("vae", "VAE", null)], outputs: [{ type: "IMAGE", links: [] }] }),
    node(3, DEF, { title: "Inside", inputs: [socket("target", "*", 5)] }),
  ], [[1, 1, 0, 2, 0, "LATENT"], [5, 5, 0, 3, 0, "*"]], {
    definitions: { subgraphs: [{
      id: DEF, name: "Inside", inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [{ name: "target", type: "*", linkIds: [21] }], outputs: [],
      nodes: [
        node(10, "GetNode", { outputs: [{ type: "LATENT", links: [20] }], widgets_values: ["latent"] }),
        node(11, "LatentUpscaleBy", { inputs: [socket("samples", "LATENT", 20), field("upscale_method", "COMBO"), field("scale_by", "FLOAT")], widgets_values: ["nearest-exact", 1.5] }),
        node(12, "GetNode", { outputs: [{ type: "LATENT", links: [22] }], widgets_values: ["nobody"] }),
        node(13, "LatentUpscaleBy", { inputs: [socket("samples", "LATENT", 22), field("upscale_method", "COMBO"), field("scale_by", "FLOAT")], widgets_values: ["nearest-exact", 2] }),
        node(14, "DaSiWa_NodeStatusSwitch", { title: "Decode", inputs: [field("enabled", "BOOLEAN"), field("trigger_on", "COMBO"), field("action", "COMBO"), socket("target_01", "*", 21)], widgets_values: [false, "true → active", "bypass"] }),
      ],
      links: [
        { id: 20, origin_id: 10, origin_slot: 0, target_id: 11, target_slot: 0 },
        { id: 22, origin_id: 12, origin_slot: 0, target_id: 13, target_slot: 0 },
        { id: 21, origin_id: -10, origin_slot: 0, target_id: 14, target_slot: 3 },
      ],
    }] },
  }), catalog);

  it("reads a Get node inside a group node from the Set node outside, and says so of one that has none", () => {
    expect(read.graph["3:11"]!.inputs.samples).toEqual(["1", 0]);
    expect(read.graph["3:13"]!.inputs.samples).toBeUndefined();
    expect(read.notes).toContain('The "Get" node "nobody" reads "nobody", which no "Set" node of this file sets: what it would hand on is left out.');
  });

  it("follows a switch inside a group node to the node it switches outside", () => {
    expect(read.wiring.toggles.map((t) => [t.label, t.effects[0]!.nodes])).toEqual([["Decode", ["5"]]]);
  });
});

describe("the front of a group node", () => {
  const DEF = "cccccccc-0000-4000-8000-000000000003";
  const withFront = (values: unknown[], properties: Record<string, unknown> = {}) => fromEditor(file([node(3, DEF, { widgets_values: values, properties })], [], {
    definitions: { subgraphs: [{
      id: DEF, name: "Latent", inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [{ name: "width", type: "INT", linkIds: [11] }], outputs: [],
      nodes: [node(5, "EmptyLatentImage", { inputs: [field("width", "INT", 11), field("height", "INT"), field("batch_size", "INT")], widgets_values: [512, 512, 1] })],
      links: [{ id: 11, origin_id: -10, origin_slot: 0, target_id: 5, target_slot: 0 }],
    }] },
  }), catalog);

  it("says nothing was read wrong when the file names each value it shows, and names the group node when it does", () => {
    // a newer editor names each value the front shows: two values for one field of its own, nothing guessed
    expect(withFront([768, 640], { proxyWidgets: [["-1", "width"], ["5", "height"]] }).notes).toEqual([]);
    expect(withFront([768, 640, 1]).notes).toEqual(['"Latent" holds 3 values for 1 fields on its front: some of them may have been read wrong.']);
  });
});

describe("a group node used twice", () => {
  const DEF = "dddddddd-0000-4000-8000-000000000004";
  const read = fromEditor(file([node(1, DEF, { pos: [0, 0] }), node(2, DEF, { pos: [500, 0] })], [], {
    definitions: { subgraphs: [{
      id: DEF, name: "Pair", inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [], outputs: [],
      groups: [{ title: "Inside", bounding: [-10, -10, 400, 400] }],
      nodes: [
        node(5, "EmptyLatentImage", { outputs: [{ type: "LATENT", links: [] }], widgets_values: [512, 512, 1] }),
        node(6, "LatentUpscaleBy", { pos: [10, 10], inputs: [socket("samples", "LATENT", null), field("upscale_method", "COMBO"), field("scale_by", "FLOAT")], widgets_values: ["nearest-exact", 1.5] }),
      ],
      links: [],
      extra: { ue_links: [{ upstream: 5, upstream_slot: 0, downstream: 6, downstream_slot: 0 }] },
    }] },
  }), catalog);

  it("opens each use on its own: links and frames of one are not the other's", () => {
    expect(read.graph["1:6"]!.inputs.samples).toEqual(["1:5", 0]);
    expect(read.graph["2:6"]!.inputs.samples).toEqual(["2:5", 0]);
    expect(read.wiring.frames.map((f) => [f.title, f.nodes])).toEqual([["Inside", ["1:5", "1:6"]], ["Inside", ["2:5", "2:6"]]]);
  });
});

describe("what runs as is, wherever it is told", () => {
  it("is said at import: a path outside ComfyUI's folders, a kind that runs code", () => {
    const g: Graph = {
      "1": { class_type: "LoadImage", inputs: { image: "C:\\Users\\someone\\secret.png" } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "../../outside/x" } },
      "3": { class_type: "Evaluate Integers", inputs: { python_expression: "a + b" } },
      "4": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "fine/x" } },
    };
    const notes = inspect(g, catalog).notes;
    expect(notes).toEqual([
      expect.stringMatching(/^"LoadImage" names a place outside ComfyUI's folders in image/),
      expect.stringMatching(/^"SaveImage" names a place outside ComfyUI's folders in filename prefix \(\.\.\/\.\.\/outside\/x\)/),
      expect.stringMatching(/^"Evaluate Integers" \(Evaluate Integers\) runs code it is given/),
    ]);
  });
});

describe("shapes that once looped or overflowed", () => {
  it("works out what a node needs along a very long chain", () => {
    const g: Graph = { "0": { class_type: "EmptyLatentImage", inputs: {} } };
    for (let i = 1; i < 50_000; i++) g[String(i)] = { class_type: "LatentUpscaleBy", inputs: { samples: [String(i - 1), 0] } };
    expect(ancestors(g, "49999").size).toBe(50_000);
  });

  it("arranges frames whose file says they hold each other", () => {
    const g: Graph = { "1": { class_type: "KSampler", inputs: { steps: 20 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } };
    const frames = [{ title: "A", nodes: ["1"], parent: 1 }, { title: "B", nodes: ["2"], parent: 0 }];
    expect(() => suggestSections(g, undefined, "2", [{ id: "ctl_1_steps", node: "1" }], frames)).not.toThrow();
  });

  it("keeps only web addresses among the links a held workflow carries", () => {
    const w = wiringSchema.parse({ modes: {}, slots: {}, fallback: {}, links: [{ label: "x", url: "javascript:alert(1)" }, { label: "y", url: "https://example.org" }], downloads: { "a.safetensors": "file:///etc/passwd", "b.safetensors": "https://example.org/b" } });
    expect(w.links).toEqual([{ label: "y", url: "https://example.org" }]);
    expect(w.downloads).toEqual({ "b.safetensors": "https://example.org/b" });
  });
});

describe("one reading of a model file, a pass of sampling and a widget", () => {
  it("counts a pack's sampler with a step count as a pass, not a scheduler", () => {
    expect(isSamplingPass({ class_type: "WanVideoSampler", inputs: { steps: 6 } })).toBe(true);
    expect(isSamplingPass({ class_type: "KSampler", inputs: {} })).toBe(true);
    expect(isSamplingPass({ class_type: "BasicScheduler", inputs: { steps: 20 } })).toBe(false);
    // the helpers of a custom sampler hand a sampler or a schedule on: they sample nothing (W-4)
    for (const helper of ["KSamplerSelect", "KarrasScheduler", "ExponentialScheduler", "PolyexponentialScheduler", "KSampler Config (rgthree)", "KSamplerProvider"]) {
      expect(isSamplingPass({ class_type: helper, inputs: { steps: 20, sampler_name: "euler" } }), helper).toBe(false);
    }
    expect(isSamplingPass({ class_type: "SamplerCustomAdvanced", inputs: {} })).toBe(true);
    expect(isSamplingPass({ class_type: "SamplerCustom", inputs: {} })).toBe(true);
    expect(isWidget(["IMAGEUPLOAD"])).toBe(true);
    expect(isWidget(["INT", { forceInput: true }])).toBe(false);
  });

  it("lists every model file a recipe needs, and builds nothing before it is asked", () => {
    const def = workflowDef.parse({
      id: "workflow.t", title: "t", model: "m",
      graph: {
        "1": { class_type: "UpscaleModelLoader", inputs: { model_name: "4x.engine" } },
        "2": { class_type: "LoadImage", inputs: { image: "a.png" } },
        "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["1", 0], image: ["2", 0] } },
        "4": { class_type: "MiniMaxH3Director", inputs: { timeline_data: "not json", mode: "T2VA" } },
        "5": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "x" } },
      },
      bindings: { result: { node: "5", kind: "image" }, startImage: { target: { node: "2", input: "image" }, detach: [], required: true } },
    }) as WorkflowDef;
    expect(recipeFromWorkflow(def).files).toEqual([{ classType: "UpscaleModelLoader", input: "model_name", file: "4x.engine" }]);
    // a Director whose data this version cannot read: the recipe is made, and only building it says so
    const broken = recipeFromWorkflow({ ...def, bindings: { ...def.bindings, startImage: undefined, director: { node: "4" }, result: { node: "5", kind: "image", sound: false } } } as WorkflowDef);
    expect(() => broken.files).toThrow(/Director/);
  });
});

describe("node ids the editor should not have written", () => {
  it("a second node with an id already taken is read as the editor reads it: a new id, the links to the id go to the first", () => {
    // older versions of the editor saved such files: the text node 3 and the save node 3
    const f = file([
      node(4, "CheckpointLoaderSimple", { outputs: [{ type: "MODEL", links: [] }, { type: "CLIP", links: [1] }, { type: "VAE", links: [] }], widgets_values: ["a.safetensors"] }),
      node(3, "CLIPTextEncode", { inputs: [socket("clip", "CLIP", 1)], outputs: [{ type: "CONDITIONING", links: [] }], widgets_values: ["hello"] }),
      node(3, "SaveImage", { inputs: [socket("images", "IMAGE")], widgets_values: ["x"] }),
    ], [[1, 4, 1, 3, 0, "CLIP"]], { last_node_id: 4 });
    const read = fromEditor(f, catalog);
    expect(read.graph["3"]).toMatchObject({ class_type: "CLIPTextEncode", inputs: { text: "hello", clip: ["4", 1] } });
    expect(read.graph["5"]).toMatchObject({ class_type: "SaveImage", inputs: { filename_prefix: "x" } });
    expect(read.notes.join()).toMatch(/Two nodes have the id 3/);
  });
  it("an id with a \":\" is renumbered, with its links, and does not collide with a node inside a group node", () => {
    const f = file([
      node("1:2", "CLIPTextEncode", { inputs: [socket("clip", "CLIP", 1)], outputs: [{ type: "CONDITIONING", links: [] }], widgets_values: ["top"] }),
      node(1, "CheckpointLoaderSimple", { outputs: [{ type: "MODEL", links: [] }, { type: "CLIP", links: [1] }, { type: "VAE", links: [] }], widgets_values: ["a.safetensors"] }),
    ], [[1, 1, 1, "1:2", 0, "CLIP"]]);
    const read = fromEditor(f, catalog);
    expect(read.graph["1:2"]).toBeUndefined();
    expect(read.graph["2"]).toMatchObject({ class_type: "CLIPTextEncode", inputs: { text: "top", clip: ["1", 1] } });
    expect(read.notes.join()).toMatch(/":"/);
  });
});

describe("an editor file without a list of links", () => {
  it("is still the editor's (nothing wired yet)", () => {
    const f = { nodes: [node(1, "CheckpointLoaderSimple", { widgets_values: ["a.safetensors"] })], version: 0.4 };
    expect(isEditorFormat(f)).toBe(true);
    expect(fromEditor(f, catalog).graph["1"]).toMatchObject({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } });
  });
});
