import { describe, expect, it } from "vitest";
import type { NodeCatalog } from "@afflatus/core";
import { leftoverNames, stripFileLists } from "../src";

describe("stripFileLists", () => {
  it("empties lists of files in both encodings and keeps fixed choices", () => {
    const catalog: NodeCatalog = {
      Loader: {
        input: {
          required: { ckpt_name: [["mine.safetensors", "other.ckpt"], { default: "mine.safetensors" }] },
          optional: { model_name: ["COMBO", { options: ["RealESRGAN_x4plus.pth"], default: "RealESRGAN_x4plus.pth", tooltip: "t" }] },
        },
        output: ["MODEL"],
      },
      Sampler: { input: { required: { method: [["euler", "heun"]], mode: ["COMBO", { options: ["fast"] }], steps: ["INT", { default: 20 }] } }, output: [] },
      LoadImage: { input: { required: { image: [["holiday.png"]] } }, output: ["IMAGE"] },
      Picker: {
        // custom nodes also keep file lists outside required / optional
        input: { required: { formats: ["STRING", { extensions: [".png", ".jpg"] }] }, hidden: { available_loras: [["None", "private.safetensors"]] } } as never,
        output: [],
      },
    };
    expect(stripFileLists(catalog)).toBe(4);
    expect(JSON.stringify(catalog)).not.toMatch(/mine|other|RealESRGAN|holiday|private/);
    // a list of extensions is not a list of files
    expect(catalog.Picker!.input.required!.formats).toEqual(["STRING", { extensions: [".png", ".jpg"] }]);
    expect(catalog.Loader!.input.optional!.model_name).toEqual(["COMBO", { options: [], tooltip: "t" }]);
    expect(catalog.Sampler!.input.required).toEqual({ method: [["euler", "heun"]], mode: ["COMBO", { options: ["fast"] }], steps: ["INT", { default: 20 }] });
  });

  it("empties a list that names the same model files without folder or extension", () => {
    const catalog: NodeCatalog = {
      LoraLoader: { input: { required: { lora_name: [["styles\\my_private_lora.safetensors", "another-one_v2.safetensors", "third.safetensors"]] } }, output: ["MODEL"] },
      PowerPrompt: {
        input: {
          optional: {
            insert_lora: [["CHOOSE", "DISABLE LORAS", "my_private_lora", "another-one_v2", "third"], { default: "my_private_lora" }],
            mode: [["CHOOSE", "simple", "third"]],
          },
        },
        output: [],
      },
    };
    expect(stripFileLists(catalog)).toBe(2);
    expect(JSON.stringify(catalog)).not.toMatch(/my_private_lora|another-one/);
    // one entry that happens to be a file's name does not make a list of files
    expect(catalog.PowerPrompt!.input.optional!.mode).toEqual([["CHOOSE", "simple", "third"]]);
    expect(leftoverNames(catalog, ["styles\\my_private_lora.safetensors", "another-one_v2.safetensors"])).toEqual([]);
    expect(leftoverNames({ X: { input: { required: { note: ["STRING", { default: "made with My_Private_Lora" }] } }, output: [] } }, ["my_private_lora.safetensors"])).toEqual(["my_private_lora"]);
  });

  it("drops a tooltip that names a file, and keeps the others", () => {
    const catalog: NodeCatalog = {
      Track: {
        input: {
          optional: {
            fallback: [["none", "segm\\person_yolov8m-seg.pt"], { default: "none", tooltip: "A body model such as segm\\person_yolov8m-seg.pt finds the head." }],
            window: ["INT", { default: 21, tooltip: "Frames of smoothing." }],
          },
        },
        output: [],
      },
    };
    stripFileLists(catalog);
    expect(JSON.stringify(catalog)).not.toMatch(/person_yolov8m/);
    expect(catalog.Track!.input.optional!.window).toEqual(["INT", { default: 21, tooltip: "Frames of smoothing." }]);
    expect(leftoverNames(catalog, ["segm\\person_yolov8m-seg.pt"])).toEqual([]);
  });
});
