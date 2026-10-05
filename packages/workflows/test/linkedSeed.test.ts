import { describe, expect, it } from "vitest";
import type { NodeCatalog } from "@afflatus/core";
import { fromEditor } from "../src";

/**
 * A seed fed by a link (a seed generator node) keeps two slots in the saved values: its own and the
 * "after a run" one, which the editor saves as null rather than "fixed". Every value after it was read
 * one place early (steps lost, "heun" taken for the scheduler) until this was known.
 */
const catalog: NodeCatalog = {
  Seed: { input: { required: { seed: ["INT", { default: 0 }] } }, output: ["INT"], output_name: ["INT"] },
  "KSampler (Efficient)": {
    input: {
      required: {
        model: ["MODEL"], seed: ["INT", { default: 0, control_after_generate: true }], steps: ["INT", { default: 20 }], cfg: ["FLOAT", { default: 7 }],
        sampler_name: [["euler", "heun", "euler_ancestral"]], scheduler: [["simple", "karras"]], denoise: ["FLOAT", { default: 1 }],
        preview_method: [["auto", "none"]], vae_decode: [["true", "false"]],
      },
    },
    output: ["MODEL"], output_name: ["MODEL"],
  },
};

const widget = (name: string, type: string, link: number | null = null) => ({ name, type, link, widget: { name } });

const file = {
  version: 0.4, last_node_id: 80, last_link_id: 1,
  nodes: [
    { id: 9, type: "Seed", pos: [0, 0], mode: 0, inputs: [widget("seed", "INT")], outputs: [{ name: "INT", type: "INT", links: [1] }], widgets_values: [42, "randomize"] },
    {
      id: 80, type: "KSampler (Efficient)", pos: [300, 0], mode: 0,
      inputs: [
        { name: "model", type: "MODEL", link: null },
        widget("seed", "INT", 1), widget("steps", "INT"), widget("cfg", "FLOAT"), widget("sampler_name", "COMBO"), widget("scheduler", "COMBO"),
        widget("denoise", "FLOAT"), widget("preview_method", "COMBO"), widget("vae_decode", "COMBO"),
      ],
      outputs: [{ name: "MODEL", type: "MODEL", links: [] }],
      widgets_values: [1083472477040331, null, 6, 2, "heun", "simple", 1, "none", "true"],
    },
  ],
  links: [[1, 9, 0, 80, 1, "INT"]],
};

describe("a seed fed by a link", () => {
  it("keeps the values after it in their places", () => {
    const read = fromEditor(file, catalog);
    expect(read.graph["80"]!.inputs).toEqual({ seed: ["9", 0], steps: 6, cfg: 2, sampler_name: "heun", scheduler: "simple", denoise: 1, preview_method: "none", vae_decode: "true" });
    expect(read.notes.filter((n) => /read wrong/.test(n))).toEqual([]);
  });
});
