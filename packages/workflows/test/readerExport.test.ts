import { describe, expect, it } from "vitest";
import type { NodeCatalog } from "@afflatus/core";
import { fromEditor } from "../src";
import { catalog } from "./fixtures";

/** What comparing the reader with ComfyUI's own "Export (API)" over the corpus found (comfyExport.test.ts). */

const sampler = (id: number, model: number | null, values: unknown[] = [1, "fixed", 20, 7, "euler", "normal", 1]) => ({
  id, type: "KSampler", pos: [400, 0], mode: 0,
  inputs: [
    { name: "model", type: "MODEL", link: model }, { name: "positive", type: "CONDITIONING", link: null }, { name: "negative", type: "CONDITIONING", link: null }, { name: "latent_image", type: "LATENT", link: null },
    ...["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"].map((name) => ({ name, type: "INT", link: null, widget: { name } })),
  ],
  outputs: [{ name: "LATENT", type: "LATENT", links: null }],
  widgets_values: values,
});
const checkpoint = (links: number[]) => ({
  id: 4, type: "CheckpointLoaderSimple", pos: [0, 0], mode: 0, inputs: [], widgets_values: ["m.safetensors"],
  outputs: [{ name: "MODEL", type: "MODEL", links }, { name: "CLIP", type: "CLIP", links: null }, { name: "VAE", type: "VAE", links: null }],
});

describe("rgthree's reroute", () => {
  it("hands on what comes into it, as ComfyUI's own does", () => {
    const file = {
      nodes: [
        checkpoint([1]),
        { id: 5, type: "Reroute (rgthree)", pos: [100, 0], mode: 0, inputs: [{ name: "", type: "*", link: 1 }], outputs: [{ name: "MODEL", type: "MODEL", links: [2] }] },
        { id: 6, type: "Reroute", pos: [200, 0], mode: 0, inputs: [{ name: "", type: "*", link: 2 }], outputs: [{ name: "MODEL", type: "MODEL", links: [3] }] },
        sampler(3, 3),
      ],
      links: [[1, 4, 0, 5, 0, "MODEL"], [2, 5, 0, 6, 0, "MODEL"], [3, 6, 0, 3, 0, "MODEL"]],
    };
    expect(fromEditor(file, catalog).graph["3"]!.inputs.model).toEqual(["4", 0]);
  });
});

describe("the front of a group node that lists what it shows (proxyWidgets)", () => {
  // two widgets of a node inside come first on the front (a seed and what to do with it after a run), then the
  // group's own fields: the values are in that order, not the group's inputs' order
  const GROUP = "aaaaaaaa-0000-0000-0000-000000000001";
  const file = {
    nodes: [{
      id: 1, type: GROUP, pos: [0, 0], mode: 0,
      inputs: [{ name: "steps", type: "INT", link: null, widget: { name: "steps" } }, { name: "denoise", type: "FLOAT", link: null, widget: { name: "denoise" } }],
      outputs: [], widgets_values: [null, null, 30, 0.6],
      properties: { proxyWidgets: [["10", "seed"], ["10", "control_after_generate"], ["-1", "steps"], ["-1", "denoise"]] },
    }],
    links: [],
    definitions: {
      subgraphs: [{
        id: GROUP, name: "Sampling", inputNode: { id: -10 }, outputNode: { id: -20 },
        inputs: [{ name: "anything", type: "INT", linkIds: [] }, { name: "steps", type: "INT", linkIds: [1] }, { name: "denoise", type: "FLOAT", linkIds: [2] }],
        outputs: [],
        nodes: [{ ...sampler(10, null, [5, "fixed", 20, 7, "euler", "normal", 1]), inputs: sampler(10, null).inputs.map((s) => (s.name === "steps" ? { ...s, link: 1 } : s.name === "denoise" ? { ...s, link: 2 } : s)) }],
        links: [
          { id: 1, origin_id: -10, origin_slot: 1, target_id: 10, target_slot: 5, type: "INT" },
          { id: 2, origin_id: -10, origin_slot: 2, target_id: 10, target_slot: 9, type: "FLOAT" },
        ],
      }],
    },
  };
  it("is read by the list: each value on the field it names, a widget of a node inside keeping its own", () => {
    expect(fromEditor(file, catalog).graph["1:10"]!.inputs).toMatchObject({ seed: 5, steps: 30, denoise: 0.6 });
  });
});

describe("values saved by place", () => {
  it("a field the file shows as one keeps its place, even when this ComfyUI's kind takes it by a link only", () => {
    const local: NodeCatalog = {
      ...catalog,
      Replace: { ...catalog.KSampler!, input: { required: { prompt: ["STRING", { forceInput: true }] }, optional: { find1: ["STRING", {}], replace1: ["STRING", {}] } } },
      Text: { ...catalog.KSampler!, input: { required: { text: ["STRING", {}] } }, output: ["STRING"] },
    };
    const file = {
      nodes: [
        { id: 1, type: "Text", pos: [0, 0], mode: 0, inputs: [], outputs: [{ name: "STRING", type: "STRING", links: [1] }], widgets_values: ["a photo"] },
        { id: 2, type: "Replace", pos: [200, 0], mode: 0, inputs: [{ name: "prompt", type: "STRING", link: 1, widget: { name: "prompt" } }], outputs: [], widgets_values: ["", "photo", "video"] },
      ],
      links: [[1, 1, 0, 2, 0, "STRING"]],
    };
    expect(fromEditor(file, local).graph["2"]!.inputs).toEqual({ prompt: ["1", 0], find1: "photo", replace1: "video" });
  });

  it("a choice that brings fields of its own (SaveVideo's format → codec → encoding) gives them the values after it", () => {
    const sub = (key: string, inputs: Record<string, unknown> = {}) => ({ key, inputs: { required: inputs } });
    const encoding = ["COMFY_DYNAMICCOMBO_V3", { options: [sub("auto"), sub("re-encode", { crf: ["FLOAT", { default: 23 }] })] }];
    const codec = ["COMFY_DYNAMICCOMBO_V3", { options: [sub("auto"), { key: "h264", inputs: { required: {}, optional: { encoding } } }] }];
    const local: NodeCatalog = {
      ...catalog,
      SaveVideo: {
        ...catalog.SaveVideo!,
        input: { required: { video: ["VIDEO", {}], filename_prefix: ["STRING", { default: "video/ComfyUI" }], format: ["COMFY_DYNAMICCOMBO_V3", { options: [sub("auto", { codec }), sub("mp4", { codec })] }] }, optional: { codec } },
      },
    };
    const save = (values: unknown[]) => ({ nodes: [{ id: 1, type: "SaveVideo", pos: [0, 0], mode: 0, inputs: [], outputs: [], widgets_values: values }], links: [] });
    // saved before the format brought its own fields: the codec after it is the format's
    expect(fromEditor(save(["v/x", "mp4", "h264"]), local).graph["1"]!.inputs).toEqual({ filename_prefix: "v/x", format: "mp4", "format.codec": "h264", "format.codec.encoding": "auto", codec: "auto" });
    expect(fromEditor(save(["v/x", "auto", "auto"]), local).graph["1"]!.inputs).toEqual({ filename_prefix: "v/x", format: "auto", "format.codec": "auto", codec: "auto" });
  });

  it("rgthree's primitive gives its type and its value, by the names it reads them by", () => {
    const file = { nodes: [{ id: 1, type: "Power Primitive (rgthree)", pos: [0, 0], mode: 0, inputs: [{ name: "value", type: "*", link: null, widget: { name: "value" } }], outputs: [], widgets_values: ["INT", 81] }], links: [] };
    expect(fromEditor(file, catalog).graph["1"]!.inputs).toEqual({ type: "INT", value: 81 });
  });
});
