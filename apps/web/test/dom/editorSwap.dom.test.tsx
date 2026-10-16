import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { inspect } from "@afflatus/workflows";
import { useMapping, type Editing } from "../../src/screens/workflowEditor/useMapping";
import { editorWithSwaps } from "../../src/screens/workflowEditor/editorFile";
import type { NodeCatalog } from "@afflatus/core";
import objectInfo from "../../../../reference/comfy-object-info.json";

/**
 * A model file replaced on the import screen ("Replace with one you have", review S-9): the editor's own file saved with
 * the workflow names the new file too, so that Open in ComfyUI shows what Afflatus renders with.
 */

const catalog = objectInfo as unknown as NodeCatalog;
/** ComfyUI's default text-to-image workflow, as "Export (API)" writes it (the workflows package's fixture). */
const sdxl: Editing["graph"] = {
  "3": { class_type: "KSampler", inputs: { seed: 156680208700286, steps: 20, cfg: 8, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "beautiful scenery, a glass bottle on a beach", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "text, watermark", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
};

const editorFile = {
  nodes: [
    { id: 4, type: "CheckpointLoaderSimple", widgets_values: ["sd_xl_base_1.0.safetensors"] },
    { id: 3, type: "KSampler", widgets_values: [156680208700286, "randomize", 20, 8, "euler", "normal", 1] },
  ],
  links: [],
};

function start(editor: unknown = editorFile): Editing {
  const inspection = inspect(sdxl, catalog);
  return { id: null, source: "zz-test.json", title: "zz-test", model: "SDXL", graph: sdxl, editor, inspection, bindings: inspection.suggested! };
}

describe("a model file replaced on the import screen", () => {
  it("is written into the editor's own file that is saved", () => {
    const { result } = renderHook(() => useMapping(start()));
    expect(result.current.editor).toBe(editorFile);
    act(() => result.current.replaceFile({ node: "4", input: "ckpt_name" }, "zz-test-model.safetensors"));
    act(() => result.current.replaceFile({ node: "4", input: "ckpt_name" }, "zz-test-other.safetensors"));
    expect(result.current.graph["4"]!.inputs.ckpt_name).toBe("zz-test-other.safetensors");
    const saved = result.current.editor as typeof editorFile;
    expect(saved.nodes[0]!.widgets_values).toEqual(["zz-test-other.safetensors"]);
    expect(saved.nodes[1]).toEqual(editorFile.nodes[1]);
    // the file the import read is left as it came: Cancel keeps nothing of it
    expect(editorFile.nodes[0]!.widgets_values).toEqual(["sd_xl_base_1.0.safetensors"]);
    expect(result.current.dirty).toBe(true);
  });

  it("drops the editor's file when the replacement cannot be placed in it, so the server writes one from the graph", () => {
    expect(editorWithSwaps({ nodes: [{ id: "12:4", widgets_values: ["a.safetensors"] }] }, [{ node: "4", from: "a.safetensors", to: "b.safetensors" }])).toBeUndefined();
    expect(editorWithSwaps({ nodes: [{ id: 4, widgets_values: ["other.safetensors"] }] }, [{ node: "4", from: "a.safetensors", to: "b.safetensors" }])).toBeUndefined();
    expect(editorWithSwaps({ nodes: [{ id: 4, widgets_values: ["a.safetensors"] }] }, [{ node: "4", from: null, to: "b.safetensors" }])).toBeUndefined();
    expect(editorWithSwaps(undefined, [{ node: "4", from: "a.safetensors", to: "b.safetensors" }])).toBeUndefined();
    expect(editorWithSwaps(undefined, [])).toBeUndefined();
  });

  it("writes a widget kept by name, as Video Helper Suite's loaders keep theirs", () => {
    const file = { nodes: [{ id: 7, widgets_values: { video: "a.mp4", model: "a.safetensors" } }] };
    expect(editorWithSwaps(file, [{ node: "7", from: "a.safetensors", to: "b.safetensors" }])).toEqual({ nodes: [{ id: 7, widgets_values: { video: "a.mp4", model: "b.safetensors" } }] });
  });
});
