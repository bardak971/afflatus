import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { fromEditor, inspect, recipeFromWorkflow, type WorkflowDef } from "../src";
import { wiring } from "../src/types";
import { catalog, sdxl } from "./fixtures";

const titled = (title: string) => ({ _meta: { title } });
const defOf = (graph: Graph, bindings: NonNullable<ReturnType<typeof inspect>["suggested"]>, w?: WorkflowDef["wiring"]): WorkflowDef =>
  ({ id: "w", title: "T", model: "SDXL", source: "t.json", graph: graph as WorkflowDef["graph"], bindings, ...(w ? { wiring: w } : {}) });

describe("the model file is the form's Model picker", () => {
  const found = inspect(sdxl, catalog);
  it("binds the loader's file, keeps it out of the widgets, and the form picks it from ComfyUI's folder", () => {
    expect(found.suggested!.model).toEqual({ target: { node: "4", input: "ckpt_name" }, folder: "checkpoints" });
    expect(found.candidates.some((c) => c.target.node === "4")).toBe(false);
    const recipe = recipeFromWorkflow(defOf(sdxl, found.suggested!));
    const model = recipe.inputs.find((i) => i.id === "model");
    expect(model).toMatchObject({ type: "model", folder: "checkpoints", default: "sd_xl_base_1.0.safetensors" });
    expect(model!.advanced).toBeFalsy();
    const built = recipe.build(parseInput(recipe, { model: "other.safetensors" }), dryContext());
    expect(built.graph["4"]!.inputs.ckpt_name).toBe("other.safetensors");
  });
  it("still says when the file is not in ComfyUI's list", () => {
    const listed = { ...catalog, CheckpointLoaderSimple: { ...catalog.CheckpointLoaderSimple!, input: { required: { ckpt_name: [["other.safetensors"]] } } } };
    expect(inspect(sdxl, listed).missingFiles.map((f) => f.file)).toEqual(["sd_xl_base_1.0.safetensors"]);
  });
});

describe("a preview beside the way is a point to stop at", () => {
  // two passes, the picture shown after each by a preview that hangs off the decoder (not in line with it)
  const graph: Graph = {
    ...sdxl,
    "10": { class_type: "PreviewImage", inputs: { images: ["8", 0] } },
    "21": { class_type: "LatentUpscaleBy", inputs: { samples: ["3", 0], upscale_method: "nearest-exact", scale_by: 1.5 } },
    "31": { class_type: "KSampler", inputs: { seed: 2, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 0.5, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["21", 0] } },
    "32": { class_type: "VAEDecode", inputs: { samples: ["31", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["32", 0] } },
  };
  it("is found, and stopping there leaves the second pass out", () => {
    const found = inspect(graph, catalog);
    expect(found.stages).toEqual([{ node: "10", label: "Hires fix off" }, { node: "9", label: "Hires fix on" }]);
    const recipe = recipeFromWorkflow(defOf(graph, found.suggested!));
    const base = recipe.build(parseInput(recipe, { stage: false }), dryContext());
    expect(base.graph["31"]).toBeUndefined();
    expect(base.outputs[0]!.node).toBe("10");
  });
});

describe("a size and a length typed into named number nodes behind arithmetic", () => {
  const graph: Graph = {
    ...sdxl,
    "40": { class_type: "PrimitiveInt", inputs: { value: 832 }, ...titled("Width") },
    "41": { class_type: "PrimitiveInt", inputs: { value: 480 }, ...titled("Height") },
    "42": { class_type: "ComfyMathExpression", inputs: { expression: "round(a / 16) * 16", "values.a": ["40", 0] } },
    "43": { class_type: "ComfyMathExpression", inputs: { expression: "round(a / 16) * 16", "values.a": ["41", 0] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: ["42", 0], height: ["43", 0], batch_size: 1 } },
  };
  it("takes those nodes as the size", () => {
    const s = inspect(graph, catalog).suggested!;
    expect(s.size).toMatchObject({ width: { node: "40", input: "value" }, height: { node: "41", input: "value" } });
  });
  it("takes a Seconds node as the length, in seconds", () => {
    const video: Graph = {
      "37": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_i2v_14B.safetensors", weight_dtype: "default" } },
      "38": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl.safetensors", type: "wan", device: "default" } },
      "39": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "a", clip: ["38", 0] } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: "b", clip: ["38", 0] } },
      "60": { class_type: "PrimitiveInt", inputs: { value: 5 }, ...titled("Seconds") },
      "61": { class_type: "ComfyMathExpression", inputs: { expression: "a * 16 + 1", "values.a": ["60", 0] } },
      "50": { class_type: "WanImageToVideo", inputs: { positive: ["6", 0], negative: ["7", 0], vae: ["39", 0], width: 832, height: 480, length: ["61", 0], batch_size: 1 } },
      "57": { class_type: "KSampler", inputs: { model: ["37", 0], seed: 42, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["50", 0], negative: ["50", 1], latent_image: ["50", 2], denoise: 1 } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["57", 0], vae: ["39", 0] } },
      "63": { class_type: "VHS_VideoCombine", inputs: { images: ["8", 0], frame_rate: 16, loop_count: 0, filename_prefix: "wan", format: "video/h264-mp4", pingpong: false, save_output: true } },
    };
    const found = inspect(video, catalog);
    // the same with a frame count typed into a node named "Frames": a length, read at the video's rate
    const framed: Graph = { ...video, "60": { class_type: "PrimitiveInt", inputs: { value: 81 }, ...titled("Frames") }, "61": { class_type: "ComfyMathExpression", inputs: { expression: "a", "values.a": ["60", 0] } } };
    expect(inspect(framed, catalog).suggested!.length).toMatchObject({ target: { node: "60", input: "value" }, fps: 16 });
    const seconds = found.candidates.find((c) => c.target.node === "60");
    expect(seconds).toMatchObject({ kind: "number", suggested: true });
    expect(found.suggested!.controls.some((c) => c.target.node === "60")).toBe(true);
  });
});

describe("a patch node of a pack this ComfyUI lacks", () => {
  const graph: Graph = {
    ...sdxl,
    "2": { class_type: "ApplyFBCacheOnModel", inputs: { model: ["4", 0], object_to_patch: "diffusion_model", residual_diff_threshold: 0.1 } },
    "3": { ...sdxl["3"]!, inputs: { ...sdxl["3"]!.inputs, model: ["2", 0] } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: { "2": { in: [["model", "MODEL"], ["object_to_patch", "STRING"], ["residual_diff_threshold", "FLOAT"]], out: ["MODEL"] } }, packs: { ApplyFBCacheOnModel: "wavespeed" } });
  const found = inspect(graph, catalog, w);
  it("is bypassed, with a switch that is off, and does not block a render", () => {
    expect(found.missingNodes).toEqual([]);
    expect(found.missingWhenOn).toEqual(["ApplyFBCacheOnModel"]);
    expect(found.suggested!.toggles).toMatchObject([{ id: "sw_2", default: false, effects: [{ nodes: ["2"], activeWhen: true, mode: "bypass" }] }]);
    expect(found.suggested!.toggles[0]!.help).toContain("wavespeed");
  });
  it("is passed by at build, and back when the switch is on", () => {
    const recipe = recipeFromWorkflow(defOf(graph, found.suggested!, w));
    const off = recipe.build(parseInput(recipe, {}), dryContext());
    expect(off.graph["2"]).toBeUndefined();
    expect(off.graph["3"]!.inputs.model).toEqual(["4", 0]);
    const on = recipe.build(parseInput(recipe, { sw_2: true }), dryContext());
    expect(on.graph["3"]!.inputs.model).toEqual(["2", 0]);
    expect(recipe.nodes(parseInput(recipe, {}))).not.toContain("ApplyFBCacheOnModel");
  });
});

describe("the front of a group node", () => {
  // the group's inputs are steps, model, cfg; the node that stands for it lists cfg before steps, and the values
  // are in the group's order: steps 20, cfg 7
  const SETTINGS = "11111111-2222-3333-4444-555555555555";
  const editorFile = {
    nodes: [
      { id: 4, type: "CheckpointLoaderSimple", pos: [0, 0], mode: 0, inputs: [{ name: "ckpt_name", type: "COMBO", link: null, widget: { name: "ckpt_name" } }], outputs: [{ name: "MODEL", type: "MODEL", links: [50] }, { name: "CLIP", type: "CLIP", links: null }, { name: "VAE", type: "VAE", links: null }], widgets_values: ["m.safetensors"] },
      {
        id: 1, type: SETTINGS, title: "Settings", pos: [300, 0], mode: 0,
        inputs: [{ name: "cfg", type: "FLOAT", link: null, widget: { name: "cfg" } }, { name: "steps", type: "INT", link: null, widget: { name: "steps" } }, { name: "model", type: "MODEL", link: 50 }],
        outputs: [{ name: "LATENT", type: "LATENT", links: null }],
        widgets_values: [20, 7],
      },
    ],
    links: [[50, 4, 0, 1, 2, "MODEL"]],
    definitions: {
      subgraphs: [{
        id: SETTINGS, name: "Settings", inputNode: { id: -10 }, outputNode: { id: -20 },
        inputs: [{ name: "steps", type: "INT", linkIds: [1] }, { name: "model", type: "MODEL", linkIds: [2] }, { name: "cfg", type: "FLOAT", linkIds: [3] }],
        outputs: [{ name: "LATENT", type: "LATENT", linkIds: [] }],
        nodes: [{
          id: 10, type: "KSampler", pos: [0, 0], mode: 0,
          inputs: [
            { name: "model", type: "MODEL", link: 2 }, { name: "positive", type: "CONDITIONING", link: null }, { name: "negative", type: "CONDITIONING", link: null }, { name: "latent_image", type: "LATENT", link: null },
            { name: "seed", type: "INT", link: null, widget: { name: "seed" } }, { name: "steps", type: "INT", link: 1, widget: { name: "steps" } }, { name: "cfg", type: "FLOAT", link: 3, widget: { name: "cfg" } },
            { name: "sampler_name", type: "COMBO", link: null, widget: { name: "sampler_name" } }, { name: "scheduler", type: "COMBO", link: null, widget: { name: "scheduler" } }, { name: "denoise", type: "FLOAT", link: null, widget: { name: "denoise" } },
          ],
          outputs: [{ name: "LATENT", type: "LATENT", links: null }],
          widgets_values: [1, "fixed", 25, 2, "euler", "normal", 1],
        }],
        links: [
          { id: 1, origin_id: -10, origin_slot: 0, target_id: 10, target_slot: 5, type: "INT" },
          { id: 2, origin_id: -10, origin_slot: 1, target_id: 10, target_slot: 0, type: "MODEL" },
          { id: 3, origin_id: -10, origin_slot: 2, target_id: 10, target_slot: 6, type: "FLOAT" },
        ],
      }],
    },
  };
  it("is read in the group's own order, whatever order the node lists its sockets in", () => {
    const read = fromEditor(editorFile, catalog);
    expect(read.graph["1:10"]!.inputs).toMatchObject({ steps: 20, cfg: 7, model: ["4", 0] });
    expect(read.notes.filter((n) => /holds/.test(n))).toEqual([]);
  });
});

describe("links the Anything Everywhere pack makes without drawing them", () => {
  const editorFile = {
    nodes: [
      { id: 4, type: "CheckpointLoaderSimple", pos: [0, 0], mode: 0, inputs: [{ name: "ckpt_name", type: "COMBO", link: null, widget: { name: "ckpt_name" } }], outputs: [{ name: "MODEL", type: "MODEL", links: [7] }, { name: "CLIP", type: "CLIP", links: null }, { name: "VAE", type: "VAE", links: null }], widgets_values: ["m.safetensors"] },
      { id: 99, type: "Anything Everywhere", pos: [0, 200], mode: 0, inputs: [{ name: "anything", type: "MODEL", link: 7 }], outputs: [], widgets_values: [] },
      {
        id: 3, type: "KSampler", pos: [400, 0], mode: 0,
        inputs: [
          { name: "model", type: "MODEL", link: null }, { name: "positive", type: "CONDITIONING", link: null }, { name: "negative", type: "CONDITIONING", link: null }, { name: "latent_image", type: "LATENT", link: null },
          { name: "seed", type: "INT", link: null, widget: { name: "seed" } }, { name: "steps", type: "INT", link: null, widget: { name: "steps" } }, { name: "cfg", type: "FLOAT", link: null, widget: { name: "cfg" } },
          { name: "sampler_name", type: "COMBO", link: null, widget: { name: "sampler_name" } }, { name: "scheduler", type: "COMBO", link: null, widget: { name: "scheduler" } }, { name: "denoise", type: "FLOAT", link: null, widget: { name: "denoise" } },
        ],
        outputs: [{ name: "LATENT", type: "LATENT", links: null }],
        widgets_values: [1, "fixed", 20, 7, "euler", "normal", 1],
      },
    ],
    links: [[7, 4, 0, 99, 0, "MODEL"]],
    extra: { ue_links: [{ downstream: 3, downstream_slot: 0, upstream: "4", upstream_slot: 0, controller: 99, type: "MODEL" }] },
  };
  it("are read as links: the sampler gets its model", () => {
    const read = fromEditor(editorFile, catalog);
    expect(read.graph["3"]!.inputs.model).toEqual(["4", 0]);
  });
});

describe("a save node of a pack this ComfyUI lacks", () => {
  const graph: Graph = {
    ...sdxl,
    "9": { class_type: "Image Saver", inputs: { images: ["8", 0], steps: ["3", 0], filename: "%time_%seed", extension: "png" } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: { "9": { in: [["images", "IMAGE"], ["steps", "INT"], ["filename", "STRING"], ["extension", "COMBO"]], out: ["STRING", "STRING"] } }, packs: { "Image Saver": "comfyui-image-saver" } });
  it("is replaced by ComfyUI's own saver, fed the same picture, so the workflow has an output and its pack is not asked for", () => {
    const found = inspect(graph, catalog, w);
    expect(found.replaced).toEqual([{ node: "9", from: "Image Saver", to: "SaveImage" }]);
    expect(graph["9"]).toEqual({ class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "afflatus" } });
    expect(found.suggested!.result).toMatchObject({ node: "9", kind: "image" });
    expect(found.missingNodes).toEqual([]);
  });
});

describe("prompts and loaders on nodes of kinds this ComfyUI lacks", () => {
  const graph: Graph = {
    ...sdxl,
    "4": { class_type: "WanVideoModelLoader", inputs: { model: "Wan2_2-I2V-A14B-HIGH_fp8.safetensors", base_precision: "bf16", quantization: "disabled" } },
    "6": { class_type: "WanVideoTextEncode", inputs: { positive_prompt: "a cat on a wall", negative_prompt: "blurry, static", mode: "T2V", t5: ["30", 0] } },
    "7": { class_type: "WanVideoTextEncode", inputs: { positive_prompt: "", negative_prompt: "", t5: ["30", 0] } },
    "30": { class_type: "LoadWanVideoT5TextEncoder", inputs: { model_name: "umt5-xxl-enc-bf16.safetensors", precision: "bf16" } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: {
    "4": { in: [["model", "COMBO"], ["base_precision", "COMBO"], ["quantization", "COMBO"]], out: ["WANVIDEOMODEL"] },
    "6": { in: [["t5", "WANTEXTENCODER"], ["positive_prompt", "STRING"], ["negative_prompt", "STRING"], ["mode", "COMBO"]], out: ["WANVIDEOTEXTEMBEDS"] },
    "7": { in: [["t5", "WANTEXTENCODER"], ["positive_prompt", "STRING"], ["negative_prompt", "STRING"]], out: ["WANVIDEOTEXTEMBEDS"] },
    "30": { in: [["model_name", "COMBO"], ["precision", "COMBO"]], out: ["WANTEXTENCODER"] },
  } });
  const found = inspect(graph, catalog, w);
  it("takes the texts named as prompts, and the loader whose socket gives a model as the Model", () => {
    expect(found.suggested!.prompt).toEqual({ node: "6", input: "positive_prompt" });
    expect(found.suggested!.negative).toEqual({ node: "6", input: "negative_prompt" });
    expect(found.loraPoints.map((p) => p.node)).toEqual(["4"]);
    expect(found.suggested!.model).toEqual({ target: { node: "4", input: "model" }, folder: "diffusion_models" });
  });
});

describe("value nodes of packs this ComfyUI lacks", () => {
  const graph: Graph = {
    ...sdxl,
    "40": { class_type: "JWInteger", inputs: { value: 30 }, ...titled("Steps") },
    "41": { class_type: "mxSlider", inputs: { value: 6.5 }, ...titled("CFG") },
    "42": { class_type: "Textbox", inputs: { text: "a glass bottle on a beach" } },
    "3": { ...sdxl["3"]!, inputs: { ...sdxl["3"]!.inputs, steps: ["40", 0], cfg: ["41", 0] } },
    "6": { ...sdxl["6"]!, inputs: { ...sdxl["6"]!.inputs, text: ["42", 0] } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: { "40": { in: [["value", "INT"]], out: ["INT"] }, "41": { in: [["value", "FLOAT"]], out: ["FLOAT"] }, "42": { in: [["text", "STRING"]], out: ["STRING"] } } });
  it("are replaced by ComfyUI's own primitives with the same value, and read as the settings they hold", () => {
    const found = inspect(graph, catalog, w);
    expect(found.replaced).toEqual([{ node: "40", from: "JWInteger", to: "PrimitiveInt" }, { node: "41", from: "mxSlider", to: "PrimitiveFloat" }, { node: "42", from: "Textbox", to: "PrimitiveString" }]);
    expect(found.missingNodes).toEqual([]);
    expect(found.suggested!.prompt).toEqual({ node: "42", input: "value" });
    expect(found.candidates.find((c) => c.target.node === "40")).toMatchObject({ kind: "number", label: "Steps" });
  });
});

describe("a group node bypassed as a whole", () => {
  const FX = "22222222-3333-4444-5555-666666666666";
  const editorFile = {
    nodes: [
      { id: 2, type: "LoadImage", pos: [0, 0], mode: 0, inputs: [{ name: "image", type: "COMBO", link: null, widget: { name: "image" } }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [50] }, { name: "MASK", type: "MASK", links: null }], widgets_values: ["a.png", "image"] },
      { id: 1, type: FX, title: "Effects", pos: [300, 0], mode: 4, inputs: [{ name: "image", type: "IMAGE", link: 50 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [51] }], widgets_values: [] },
      { id: 9, type: "SaveImage", pos: [600, 0], mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 51 }, { name: "filename_prefix", type: "STRING", link: null, widget: { name: "filename_prefix" } }], outputs: [], widgets_values: ["out"] },
    ],
    links: [[50, 2, 0, 1, 0, "IMAGE"], [51, 1, 0, 9, 0, "IMAGE"]],
    definitions: {
      subgraphs: [{
        id: FX, name: "Effects", inputNode: { id: -10 }, outputNode: { id: -20 },
        inputs: [{ name: "image", type: "IMAGE", linkIds: [1] }],
        outputs: [{ name: "IMAGE", type: "IMAGE", linkIds: [2] }],
        nodes: [{ id: 10, type: "ImageScaleBy", pos: [0, 0], mode: 0, inputs: [{ name: "image", type: "IMAGE", link: 1 }, { name: "upscale_method", type: "COMBO", link: null, widget: { name: "upscale_method" } }, { name: "scale_by", type: "FLOAT", link: null, widget: { name: "scale_by" } }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }], widgets_values: ["lanczos", 2] }],
        links: [{ id: 1, origin_id: -10, origin_slot: 0, target_id: 10, target_slot: 0, type: "IMAGE" }, { id: 2, origin_id: 10, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" }],
      }],
    },
  };
  it("hands the picture through: the saver gets the loaded picture, and nothing inside runs", () => {
    const read = fromEditor(editorFile, catalog);
    expect(read.graph["9"]!.inputs.images).toEqual(["2", 0]);
    expect(read.wiring.modes["1:10"]).toBe("mute");
  });
});

describe("widgets on nodes of kinds this ComfyUI lacks", () => {
  const graph: Graph = {
    ...sdxl,
    "3": { class_type: "WanVideoSampler", inputs: { steps: 30, cfg: 6, shift: 8, seed: 1, force_offload: true, model: ["4", 0], text_embeds: ["6", 0], image_embeds: ["5", 0] } },
    "8": { class_type: "WanVideoDecode", inputs: { samples: ["3", 0], vae: ["4", 2], enable_vae_tiling: false } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: {
    "3": { in: [["model", "WANVIDEOMODEL"], ["text_embeds", "WANVIDEOTEXTEMBEDS"], ["image_embeds", "WANVIDIMAGE_EMBEDS"], ["steps", "INT"], ["cfg", "FLOAT"], ["shift", "FLOAT"], ["seed", "INT"], ["force_offload", "BOOLEAN"]], out: ["LATENT"] },
    "8": { in: [["vae", "WANVAE"], ["samples", "LATENT"], ["enable_vae_tiling", "BOOLEAN"]], out: ["IMAGE"] },
  } });
  it("are offered by the file's socket types, the usual ones ticked", () => {
    const found = inspect(graph, catalog, w);
    expect(found.candidates.find((c) => c.target.node === "3" && c.target.input === "steps")).toMatchObject({ kind: "number", suggested: true, default: 30 });
    expect(found.candidates.find((c) => c.target.node === "3" && c.target.input === "cfg")).toMatchObject({ kind: "number", default: 6 });
    expect(found.candidates.find((c) => c.target.node === "8" && c.target.input === "enable_vae_tiling")).toMatchObject({ kind: "toggle" });
    expect(found.suggested!.seeds).toEqual([{ node: "3", input: "seed" }]);
  });
});

describe("the author's frames as switches, with a group bypasser in the workflow", () => {
  const graph: Graph = {
    ...sdxl,
    "20": { class_type: "UpscaleModelLoader", inputs: { model_name: "4x.pth" } },
    "21": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["20", 0], image: ["8", 0] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["21", 0] } },
    "90": { class_type: "Fast Groups Bypasser (rgthree)", inputs: {} },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: { "20": { in: [["model_name", "COMBO"]], out: ["UPSCALE_MODEL"] }, "21": { in: [["upscale_model", "UPSCALE_MODEL"], ["image", "IMAGE"]], out: ["IMAGE"] } }, frames: [{ title: "Upscale", nodes: ["20", "21"] }, { title: "Notes", nodes: [] }] });
  it("makes a switch of each frame, on as saved, that bypasses the frame's nodes when off", () => {
    const found = inspect(graph, catalog, w);
    expect(found.suggested!.toggles).toMatchObject([{ id: "sw_frame_upscale", label: "Upscale", default: true, effects: [{ nodes: ["20", "21"], activeWhen: true, mode: "bypass" }] }]);
    const recipe = recipeFromWorkflow(defOf(graph, found.suggested!, w));
    const off = recipe.build(parseInput(recipe, { sw_frame_upscale: false }), dryContext());
    expect(off.graph["21"]).toBeUndefined();
    expect(off.graph["9"]!.inputs.images).toEqual(["8", 0]);
  });
});

describe("easy-use get and set nodes, and a Crystools switch with its yes/no typed on it", () => {
  const editorFile = {
    nodes: [
      { id: 4, type: "CheckpointLoaderSimple", pos: [0, 0], mode: 0, inputs: [{ name: "ckpt_name", type: "COMBO", link: null, widget: { name: "ckpt_name" } }], outputs: [{ name: "MODEL", type: "MODEL", links: [60] }, { name: "CLIP", type: "CLIP", links: null }, { name: "VAE", type: "VAE", links: null }], widgets_values: ["m.safetensors"] },
      { id: 30, type: "easy setNode", title: "➡️MODEL", pos: [200, 0], mode: 0, inputs: [{ name: "MODEL", type: "MODEL", link: 60 }], outputs: [], widgets_values: ["MODEL"] },
      { id: 31, type: "easy getNode", title: "⬅️MODEL", pos: [400, 0], mode: 0, inputs: [], outputs: [{ name: "*", type: "*", links: [61] }], widgets_values: ["MODEL"] },
      { id: 2, type: "LoadImage", pos: [0, 300], mode: 0, inputs: [{ name: "image", type: "COMBO", link: null, widget: { name: "image" } }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [70] }, { name: "MASK", type: "MASK", links: null }], widgets_values: ["a.png", "image"] },
      { id: 12, type: "LoadImage", pos: [0, 500], mode: 0, inputs: [{ name: "image", type: "COMBO", link: null, widget: { name: "image" } }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [71] }, { name: "MASK", type: "MASK", links: null }], widgets_values: ["b.png", "image"] },
      { id: 40, type: "Switch any [Crystools]", title: "Use second", pos: [300, 400], mode: 0, inputs: [{ name: "on_true", type: "*", link: 71 }, { name: "on_false", type: "*", link: 70 }, { name: "boolean", type: "BOOLEAN", link: null, widget: { name: "boolean" } }], outputs: [{ name: "*", type: "*", links: [72] }], widgets_values: [false] },
      { id: 3, type: "KSampler", pos: [600, 0], mode: 0, inputs: [{ name: "model", type: "MODEL", link: 61 }, { name: "positive", type: "CONDITIONING", link: null }, { name: "negative", type: "CONDITIONING", link: null }, { name: "latent_image", type: "LATENT", link: null }, { name: "seed", type: "INT", link: null, widget: { name: "seed" } }, { name: "steps", type: "INT", link: null, widget: { name: "steps" } }, { name: "cfg", type: "FLOAT", link: null, widget: { name: "cfg" } }, { name: "sampler_name", type: "COMBO", link: null, widget: { name: "sampler_name" } }, { name: "scheduler", type: "COMBO", link: null, widget: { name: "scheduler" } }, { name: "denoise", type: "FLOAT", link: null, widget: { name: "denoise" } }], outputs: [{ name: "LATENT", type: "LATENT", links: null }], widgets_values: [1, "fixed", 20, 7, "euler", "normal", 1] },
      { id: 9, type: "SaveImage", pos: [600, 400], mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 72 }, { name: "filename_prefix", type: "STRING", link: null, widget: { name: "filename_prefix" } }], outputs: [], widgets_values: ["out"] },
    ],
    links: [[60, 4, 0, 30, 0, "MODEL"], [61, 31, 0, 3, 0, "MODEL"], [70, 2, 0, 40, 1, "IMAGE"], [71, 12, 0, 40, 0, "IMAGE"], [72, 40, 0, 9, 0, "IMAGE"]],
  };
  it("are followed as links: the sampler gets the model, the saver the picture the switch picks", () => {
    const read = fromEditor(editorFile, catalog);
    expect(read.graph["3"]!.inputs.model).toEqual(["4", 0]);
    expect(read.graph["9"]!.inputs.images).toEqual(["2", 0]);
    expect(read.graph["40"]).toBeUndefined();
  });
});

describe("a literal node whose number is written as text", () => {
  const graph: Graph = {
    ...sdxl,
    "41": { class_type: "Float", inputs: { value: "6.5" }, ...titled("CFG") },
    "3": { ...sdxl["3"]!, inputs: { ...sdxl["3"]!.inputs, cfg: ["41", 0] } },
  };
  const w = wiring.parse({ modes: {}, fallback: {}, slots: { "41": { in: [["value", "STRING"]], out: ["FLOAT"] } } });
  it("becomes a number primitive", () => {
    const found = inspect(graph, catalog, w);
    expect(found.replaced).toEqual([{ node: "41", from: "Float", to: "PrimitiveFloat" }]);
    expect(graph["41"]!.inputs.value).toBe(6.5);
  });
});

describe("the Image Saver pack's parameter nodes", () => {
  it("a selector for a list of choices has its value put in the reader; a checkpoint loader with a name becomes ComfyUI's own", () => {
    const graph: Graph = {
      ...sdxl,
      "4": { class_type: "Checkpoint Loader with Name (Image Saver)", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
      "50": { class_type: "Sampler Selector (Image Saver)", inputs: { value: "dpmpp_2m" } },
      "3": { ...sdxl["3"]!, inputs: { ...sdxl["3"]!.inputs, sampler_name: ["50", 0] } },
    };
    const w = wiring.parse({ modes: {}, fallback: {}, slots: { "4": { in: [["ckpt_name", "COMBO"]], out: ["MODEL", "CLIP", "VAE", "STRING"] }, "50": { in: [], out: ["COMBO", "STRING"] } } });
    const found = inspect(graph, catalog, w);
    expect(found.replaced).toEqual(expect.arrayContaining([{ node: "4", from: "Checkpoint Loader with Name (Image Saver)", to: "CheckpointLoaderSimple" }, { node: "50", from: "Sampler Selector (Image Saver)", to: "its value" }]));
    expect(graph["4"]).toEqual({ class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } });
    expect(graph["3"]!.inputs.sampler_name).toBe("dpmpp_2m");
    expect(found.suggested!.model).toEqual({ target: { node: "4", input: "ckpt_name" }, folder: "checkpoints" });
    expect(found.missingNodes).toEqual([]);
  });
  it("a literal with its value listed but not named is read, and becomes a primitive", () => {
    const editorFile = {
      nodes: [
        { id: 4, type: "CheckpointLoaderSimple", pos: [0, 0], mode: 0, inputs: [{ name: "ckpt_name", type: "COMBO", link: null, widget: { name: "ckpt_name" } }], outputs: [{ name: "MODEL", type: "MODEL", links: [1] }, { name: "CLIP", type: "CLIP", links: null }, { name: "VAE", type: "VAE", links: null }], widgets_values: ["m.safetensors"] },
        { id: 41, type: "Float Literal (Image Saver)", title: "CFG", pos: [0, 200], mode: 0, inputs: [], outputs: [{ name: "FLOAT", type: "FLOAT", links: [2] }], widgets_values: [6.5] },
        { id: 3, type: "KSampler", pos: [400, 0], mode: 0, inputs: [{ name: "model", type: "MODEL", link: 1 }, { name: "positive", type: "CONDITIONING", link: null }, { name: "negative", type: "CONDITIONING", link: null }, { name: "latent_image", type: "LATENT", link: null }, { name: "seed", type: "INT", link: null, widget: { name: "seed" } }, { name: "steps", type: "INT", link: null, widget: { name: "steps" } }, { name: "cfg", type: "FLOAT", link: 2, widget: { name: "cfg" } }, { name: "sampler_name", type: "COMBO", link: null, widget: { name: "sampler_name" } }, { name: "scheduler", type: "COMBO", link: null, widget: { name: "scheduler" } }, { name: "denoise", type: "FLOAT", link: null, widget: { name: "denoise" } }], outputs: [{ name: "LATENT", type: "LATENT", links: null }], widgets_values: [1, "fixed", 20, 7, "euler", "normal", 1] },
      ],
      links: [[1, 4, 0, 3, 0, "MODEL"], [2, 41, 0, 3, 6, "FLOAT"]],
    };
    const read = fromEditor(editorFile, catalog);
    expect(read.graph["41"]!.inputs).toEqual({ value: 6.5 });
    const found = inspect(read.graph, catalog, read.wiring, read.notes);
    expect(found.replaced).toEqual(expect.arrayContaining([{ node: "41", from: "Float Literal (Image Saver)", to: "PrimitiveFloat" }]));
    expect(found.candidates.find((c) => c.target.node === "41")).toMatchObject({ kind: "number", label: "CFG" });
  });
});

describe("the author's frames", () => {
  // a base pass; an upscale left switched off, in a frame inside another, with a note; two frames titled "#"
  const editorFile = {
    nodes: [
      { id: 4, type: "CheckpointLoaderSimple", pos: [-390, 10], mode: 0, inputs: [], outputs: [{ name: "MODEL", type: "MODEL", links: [1] }, { name: "CLIP", type: "CLIP", links: null }, { name: "VAE", type: "VAE", links: [3] }], widgets_values: ["m.safetensors"] },
      { id: 3, type: "KSampler", pos: [300, 10], mode: 0, inputs: [{ name: "model", type: "MODEL", link: 1 }, { name: "positive", type: "CONDITIONING", link: null }, { name: "negative", type: "CONDITIONING", link: null }, { name: "latent_image", type: "LATENT", link: null }], outputs: [{ name: "LATENT", type: "LATENT", links: [2] }], widgets_values: [1, "fixed", 20, 7, "euler", "normal", 1] },
      { id: 8, type: "VAEDecode", pos: [600, 10], mode: 0, inputs: [{ name: "samples", type: "LATENT", link: 2 }, { name: "vae", type: "VAE", link: 3 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [4] }], widgets_values: [] },
      { id: 30, type: "UpscaleModelLoader", pos: [1030, 40], mode: 4, inputs: [], outputs: [{ name: "UPSCALE_MODEL", type: "UPSCALE_MODEL", links: [5] }], widgets_values: ["4x.pth"] },
      { id: 31, type: "ImageUpscaleWithModel", pos: [1200, 40], mode: 4, inputs: [{ name: "upscale_model", type: "UPSCALE_MODEL", link: 5 }, { name: "image", type: "IMAGE", link: 4 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [6] }], widgets_values: [] },
      { id: 50, type: "Note", pos: [1300, 200], mode: 0, inputs: [], outputs: [], widgets_values: ["Turn on for 4x."] },
      { id: 9, type: "SaveImage", pos: [2000, 10], mode: 0, inputs: [{ name: "images", type: "IMAGE", link: 6 }], outputs: [], widgets_values: ["out"] },
    ],
    links: [[1, 4, 0, 3, 0, "MODEL"], [2, 3, 0, 8, 0, "LATENT"], [3, 4, 2, 8, 1, "VAE"], [4, 8, 0, 31, 1, "IMAGE"], [5, 30, 0, 31, 0, "UPSCALE_MODEL"], [6, 31, 0, 9, 0, "IMAGE"]],
    groups: [
      { title: "#", bounding: [-400, 0, 300, 300] },
      { title: "Base", bounding: [0, 0, 900, 400] },
      { title: "Extras", bounding: [1000, 0, 800, 500] },
      { title: "🔎 Upscale - only if you need it", bounding: [1020, 20, 500, 300] },
      { title: "#", bounding: [1950, 0, 300, 300] },
    ],
  };
  const read = fromEditor(editorFile, catalog);
  it("are one per box, each with the frame it is drawn in and the notes inside it", () => {
    const frames = read.wiring.frames;
    expect(frames.filter((f) => f.title === "#").map((f) => f.nodes)).toEqual([["4"], ["9"]]);
    const up = frames.find((f) => f.title.includes("Upscale"))!;
    expect(up.nodes).toEqual(["30", "31"]);
    expect(up.note).toBe("Turn on for 4x.");
    expect(frames[up.parent!]!.title).toBe("Extras");
    expect(frames.find((f) => f.title === "Base")!.parent).toBeUndefined();
  });
  it("a frame saved switched off that is a pass feeding the output becomes a switch, off, with its note as help", () => {
    const found = inspect(read.graph, catalog, read.wiring, read.notes);
    const sw = found.suggested!.toggles.find((t) => t.id.startsWith("sw_off_"));
    expect(sw).toMatchObject({ label: "Upscale", default: false, help: "Turn on for 4x." });
    expect([...sw!.effects[0]!.nodes].sort()).toEqual(["30", "31"]);
  });
});
