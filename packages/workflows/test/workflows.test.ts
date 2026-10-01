import { describe, expect, it } from "vitest";
import { checkGraph, dryContext, parseInput, schemaFor, type Graph, type NodeCatalog } from "@studai/core";
import { inspect, recipeFromWorkflow, slug, workflowDef, type WorkflowDef } from "../src";
import { catalog, flux, panel, sdxl, wan } from "./fixtures";

const defOf = (graph: Graph, title: string, model: string): WorkflowDef =>
  workflowDef.parse({ id: `workflow.${slug(title)}`, title, model, source: "test.json", graph, bindings: inspect(graph, catalog).suggested });

describe("inspect: the default text-to-picture workflow", () => {
  const found = inspect(sdxl, catalog);

  it("finds the prompt, what to avoid, the seed, the size and the result", () => {
    expect(found.suggested).toMatchObject({
      prompt: { node: "6", input: "text" },
      negative: { node: "7", input: "text" },
      seeds: [{ node: "3", input: "seed" }],
      size: { width: { node: "5", input: "width" }, height: { node: "5", input: "height" }, step: 8 },
      result: { node: "9", kind: "image", sound: false },
      loras: [{ node: "4", output: 0 }],
    });
    expect(found.suggested!.length).toBeUndefined();
    expect(found.suggested!.startImage).toBeUndefined();
    expect(found.missingNodes).toEqual([]);
  });

  it("offers the sampler's settings as controls, the usual ones ticked, with ranges read from ComfyUI", () => {
    const by = (input: string) => found.candidates.find((c) => c.target.node === "3" && c.target.input === input)!;
    expect(by("steps")).toMatchObject({ kind: "number", default: 20, suggested: true, min: 1 });
    expect(by("cfg")).toMatchObject({ kind: "number", default: 8, suggested: true });
    expect(by("sampler_name")).toMatchObject({ kind: "choice", default: "euler", suggested: false, choices: { node: "KSampler", input: "sampler_name" } });
    // the model file can be exposed too, as a picker
    expect(found.candidates.find((c) => c.target.input === "ckpt_name")).toMatchObject({ kind: "choice", file: true });
    // what is already bound is not offered twice
    expect(found.candidates.some((c) => ["seed", "width", "height", "text"].includes(c.target.input))).toBe(false);
  });
});

describe("inspect: a video workflow with a first and a last picture", () => {
  const found = inspect(wan, catalog);

  it("finds the video, its length in frames, and both pictures", () => {
    expect(found.suggested).toMatchObject({
      prompt: { node: "6", input: "text" },
      negative: { node: "7", input: "text" },
      result: { node: "63", kind: "video", sound: false },
      length: { target: { node: "50", input: "length" }, fps: 16, step: 4, offset: 1 },
      size: { step: 16 },
      startImage: { target: { node: "52", input: "image" }, required: false, detach: [{ node: "50", input: "start_image" }] },
      endImage: { target: { node: "53", input: "image" }, required: false, detach: [{ node: "50", input: "end_image" }] },
      loras: [{ node: "37", output: 0 }],
    });
    expect(found.texts.map((t) => [t.title, t.role])).toEqual([["What happens", "positive"], ["CLIPTextEncode", "negative"]]);
    expect(found.suggested!.controls.map((c) => c.target.input).sort()).toEqual(["cfg", "shift", "steps"]);
  });
});

describe("inspect: values kept in shared primitive nodes", () => {
  const found = inspect(flux, catalog);

  it("binds the prompt and the seed where they are really typed in", () => {
    expect(found.suggested).toMatchObject({ prompt: { node: "10", input: "value" }, seeds: [{ node: "11", input: "value" }] });
    expect(found.suggested!.negative).toBeUndefined();
  });

  it("prefers the node that saves over the one that previews", () => {
    expect(found.outputs.map((o) => o.node).sort()).toEqual(["15", "16"]);
    expect(found.suggested!.result.node).toBe("16");
  });

  it("finds the steps on the scheduler of a custom sampler", () => {
    expect(found.suggested!.controls.map((c) => `${c.target.node}.${c.target.input}`).sort()).toEqual(["5.guidance", "9.steps"]);
  });
});

describe("inspect: a large workflow whose controls are renamed nodes", () => {
  const found = inspect(panel, catalog);
  const s = found.suggested!;

  it("is valid for ComfyUI as written (the fixture itself)", () => {
    expect(found.missingNodes).toEqual([]);
  });

  it("finds the prompt, what to avoid and the seed in the nodes that hold them", () => {
    expect(s.prompt).toEqual({ node: "2368", input: "value" });
    expect(s.negative).toEqual({ node: "2371", input: "value" });
    expect(s.seeds).toEqual([{ node: "1670", input: "value" }]);
    expect(found.texts.map((t) => t.title)).toEqual(["WAN22 Video prompt positive", "WAN22 Video prompt negative"]);
  });

  it("recognises the first and last pictures by the names their nodes were given", () => {
    expect(s.startImage).toMatchObject({ target: { node: "23", input: "image" } });
    expect(s.endImage).toMatchObject({ target: { node: "24", input: "image" }, required: false });
    // everything that reads the first picture can do without it, so it can be left out
    expect(s.startImage!.required).toBe(false);
    expect(found.images.map((i) => [i.title, i.role])).toEqual([["First-Frame-Image", "start"], ["Last-Frame-Image", "end"]]);
  });

  it("does not claim a size or a length that other nodes work out", () => {
    expect(s.size).toBeUndefined();
    expect(s.length).toBeUndefined();
  });

  it("offers the author's own controls under the names the author gave them, ticked", () => {
    const labels = s.controls.map((c) => c.label).sort();
    expect(labels).toEqual(["FPS", "Resolution", "Sampling · cfg", "Sampling · steps total", "Seconds", "Sigma Shift High · shift", "Sigma Shift Low · shift"]);
    // "Seconds" is the author's own control: up front, with a range a person would use
    expect(s.controls.find((c) => c.label === "Seconds")).toMatchObject({ kind: "number", default: 5, min: 1, max: 30, front: true, target: { node: "1668", input: "value" } });
    expect(s.controls.find((c) => c.label === "FPS")).toMatchObject({ min: 1, max: 60, front: true });
    expect(s.controls.find((c) => c.label === "Sampling · cfg")!.front).toBeUndefined();
    // the size is worked out by another node: its preset is the control for it, up front, as a choice read from ComfyUI
    expect(found.candidates.find((c) => c.target.input === "resolution_preset")).toMatchObject({ kind: "choice", label: "Resolution", suggested: true, front: true, choices: { node: "DaSiWa_ResolutionScaleCalculator", input: "resolution_preset" } });
    // the rest is offered unticked
    expect(found.candidates.find((c) => c.target.input === "custom_divisor")).toMatchObject({ suggested: false });
    expect(found.candidates.some((c) => c.target.node === "1670")).toBe(false);
  });

  it("takes the video as the result, not the saved frame or a utility node", () => {
    expect(found.outputs.map((o) => [o.node, o.kind])).toEqual([["28", "video"], ["2503", "image"]]);
    expect(s.result).toMatchObject({ node: "28", kind: "video" });
  });

  it("gives the high and the low model their own LoRA lists", () => {
    expect(s.loras).toEqual([{ node: "1501", output: 0, label: "Wan22_I2V_Low" }, { node: "1502", output: 0, label: "Wan22_I2V_High" }]);
  });

  describe("as a recipe", () => {
    const def = defOf(panel, "Wan 2.2 control panel", "Wan 2.2");
    const recipe = recipeFromWorkflow(def);
    const build = (over: Record<string, unknown> = {}) => recipe.build(parseInput(recipe, over), dryContext({ seed: 5, uploads: { startImage: "a.png [temp]", endImage: "b.png [temp]" } }));

    it("puts the author's own controls up front and the rest under All settings", () => {
      expect(recipe.inputs.filter((i) => i.advanced).map((i) => i.label)).toEqual(["Sampling · steps total", "Sampling · cfg", "Sigma Shift High · shift", "Sigma Shift Low · shift"]);
    });

    it("has a form with the author's controls and two LoRA lists", () => {
      expect(recipe.inputs.map((i) => i.label)).toEqual([
        "What happens", "Avoid", "Opening picture", "Ending picture", "LoRAs · Wan22_I2V_Low", "LoRAs · Wan22_I2V_High",
        "Seconds", "FPS", "Sampling · steps total", "Sampling · cfg", "Sigma Shift High · shift", "Sigma Shift Low · shift", "Resolution", "Seed",
      ]);
    });

    it("builds a graph ComfyUI accepts, with the values in the nodes that hold them", () => {
      const built = build({ prompt: "She waves.", ctl_1668_value: 3, loras_2: [{ file: "high.safetensors", weight: 1 }] });
      expect(checkGraph(built, catalog)).toEqual([]);
      expect(built.graph["2368"]!.inputs.value).toBe("She waves.");
      expect(built.graph["1668"]!.inputs.value).toBe(3);
      expect(built.graph["1670"]!.inputs.value).toBe(5);
      // the LoRA went after the high model only
      const lora = Object.entries(built.graph).find(([, n]) => n.class_type === "LoraLoaderModelOnly")!;
      expect(lora[1].inputs.model).toEqual(["1502", 0]);
      expect(built.graph["2027"]!.inputs.model).toEqual([lora[0], 0]);
      expect(built.graph["2028"]!.inputs.model).toEqual(["1501", 0]);
    });

    it("counts the steps that really run: two samplers sharing one schedule", () => {
      // 4 steps in all: the high model runs 0 to 2, the low model 2 to 4
      expect(build().totalSteps).toBe(4);
      expect(build({ ctl_1671_steps_total: 8, }).totalSteps).toBe(8);
    });
  });
});

describe("inspect: a workflow whose prompt, size and length sit on one all-in-one node", () => {
  // the shape of a "director" workflow: the node takes the words itself, the length in seconds, and the
  // seed comes from a seed node under another name
  const director: Graph = {
    "1": { class_type: "MiniMaxH3Director", inputs: { mode: "T2VA", prompt: "A dog runs on a beach.", width: 608, height: 832, duration: 5, ref_image_size: "match", timeline_data: "{}", builder_state: "", frame_rate: 24 } },
    "2": { class_type: "DaSiWa_SeedControl", inputs: { seed_value: 123, seed_control_state: "{}" } },
    "3": { class_type: "MiniMaxH3DirectorGuide", inputs: { guide: ["1", 0] } },
    "4": { class_type: "BasicScheduler", inputs: { scheduler: "simple", steps: 15, denoise: 1 } },
    "5": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["2", 1], sigmas: ["4", 0], latent_image: ["3", 1] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0] } },
    "7": { class_type: "DaSiWa_EnhancedVideoCombine", inputs: { images: ["6", 0], frame_rate: ["1", 8], filename_prefix: "video/clip" } },
  };
  const found = inspect(director, catalog);
  const s = found.suggested!;

  it("finds the prompt on the node that takes it, and the seed under its other name", () => {
    expect(s.prompt).toEqual({ node: "1", input: "prompt" });
    expect(s.seeds).toEqual([{ node: "2", input: "seed_value" }]);
    expect(s.size).toMatchObject({ width: { node: "1", input: "width" }, height: { node: "1", input: "height" } });
  });

  it("offers the length in seconds as a control, up front", () => {
    expect(s.length).toBeUndefined();
    expect(s.controls.find((c) => c.target.input === "duration")).toMatchObject({ label: "Seconds", kind: "number", default: 5, min: 1, front: true });
  });

  it("does not take a one-line field holding data for a text to write in", () => {
    expect(found.texts.map((t) => t.target.input)).toEqual(["prompt"]);
  });
});

describe("how many steps a workflow runs", () => {
  it("adds up every pass, whether its step count is typed in or held by a number node", () => {
    // a custom sampler whose scheduler reads its steps from a number node, then a detailer with its own
    const graph: Graph = {
      ...flux,
      "20": { class_type: "PrimitiveInt", inputs: { value: 14 } },
      "9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "simple", steps: ["20", 0], denoise: 1 } },
      "30": { class_type: "FaceDetailer", inputs: { image: ["14", 0], steps: 8 } },
      "16": { class_type: "SaveImage", inputs: { images: ["30", 0], filename_prefix: "flux" } },
    };
    const recipe = recipeFromWorkflow(workflowDef.parse({ id: "workflow.passes", title: "Passes", model: "Flux", graph, bindings: { seeds: [], loras: [], controls: [], result: { node: "16", kind: "image", sound: false } } }));
    const built = recipe.build(parseInput(recipe, {}), dryContext());
    expect(built.totalSteps).toBe(22);
    expect(built.phases["30"]).toBe("detailing");
  });
});

describe("inspect: a model file this ComfyUI does not have", () => {
  it("is reported with the files that could take its place", () => {
    const listed: NodeCatalog = { ...catalog, UNETLoader: { ...catalog.UNETLoader!, input: { required: { ...catalog.UNETLoader!.input.required, unet_name: [["wan-a.safetensors", "wan-b.safetensors"]] } } } };
    expect(inspect(wan, listed).missingFiles).toEqual([
      { node: "37", input: "unet_name", classType: "UNETLoader", file: "wan2.2_i2v_14B.safetensors", label: "unet name", options: ["wan-a.safetensors", "wan-b.safetensors"] },
    ]);
  });
});

describe("inspect: what is missing on this ComfyUI", () => {
  it("lists node types it does not have and files it does not list", () => {
    const withFiles: NodeCatalog = { ...catalog, CheckpointLoaderSimple: { ...catalog.CheckpointLoaderSimple!, input: { required: { ckpt_name: [["other.safetensors"]] } } } };
    const graph: Graph = { ...sdxl, "20": { class_type: "SomeCustomNode", inputs: {} } };
    const found = inspect(graph, withFiles);
    expect(found.missingNodes).toEqual(["SomeCustomNode"]);
    expect(found.missingFiles).toEqual([{ node: "4", input: "ckpt_name", classType: "CheckpointLoaderSimple", file: "sd_xl_base_1.0.safetensors", label: "ckpt name", options: ["other.safetensors"] }]);
  });

  it("has nothing to suggest for a workflow that saves nothing", () => {
    const { "9": _save, ...noOutput } = sdxl;
    expect(inspect(noOutput, catalog).suggested).toBeNull();
  });
});

describe("a recipe made from a workflow", () => {
  const def = defOf(wan, "Wan 2.2 · Picture to video", "Wan 2.2");
  const recipe = recipeFromWorkflow(def);
  const build = (over: Record<string, unknown> = {}, uploads: Record<string, string> = { startImage: "a.png [temp]", endImage: "b.png [temp]" }) =>
    recipe.build(parseInput(recipe, over), dryContext({ seed: 7, uploads }));

  it("has a form made from the mapping", () => {
    expect(recipe).toMatchObject({ id: "workflow.wan-2-2-picture-to-video", family: "workflow-wan-2-2", output: "video" });
    expect(recipe.inputs.map((i) => i.id)).toEqual([
      "prompt", "negative", "startImage", "endImage", "loras", "size", "seconds", "ctl_48_shift", "ctl_57_steps", "ctl_57_cfg", "seed",
    ]);
    expect(recipe.inputs.find((i) => i.id === "seconds")).toMatchObject({ type: "number", default: 5, unit: " s" });
    expect(recipe.traits).toMatchObject({ startFrame: true, endFrame: true, continues: "frame", sound: false, fps: 16, frameGrid: { step: 4, offset: 1 } });
    expect(schemaFor(recipe.inputs).safeParse({ nonsense: 1 }).success).toBe(false);
  });

  it("builds the workflow as it was imported, valid for ComfyUI, when nothing is changed", () => {
    const built = build();
    expect(checkGraph(built, catalog)).toEqual([]);
    expect(built.graph["50"]!.inputs).toMatchObject({ width: 832, height: 480, length: 81 });
    expect(built.outputs).toEqual([{ node: "63", kind: "video", role: "result" }]);
    expect(built.totalSteps).toBe(6);
    expect(built.graph["57"]!.inputs.seed).toBe(7);
    expect(built.graph["52"]!.inputs.image).toBe("a.png [temp]");
    // the stored workflow is never modified
    expect(wan["57"]!.inputs.seed).toBe(42);
  });

  it("fills in the form's values, turning seconds into a frame count the model accepts", () => {
    const built = build({ prompt: "She waves.", seconds: 3, size: { width: 480, height: 832 }, ctl_57_steps: 8, ctl_48_shift: 5 });
    expect(built.graph["6"]!.inputs.text).toBe("She waves.");
    expect(built.graph["50"]!.inputs).toMatchObject({ width: 480, height: 832, length: 49 });
    expect(built.graph["57"]!.inputs.steps).toBe(8);
    expect(built.graph["48"]!.inputs.shift).toBe(5);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("takes an optional picture out of the graph when none is given", () => {
    const built = build({}, { startImage: "a.png [temp]" });
    expect(built.graph["53"]).toBeUndefined();
    expect("end_image" in built.graph["50"]!.inputs).toBe(false);
    expect(built.graph["50"]!.inputs.start_image).toEqual(["52", 0]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("chains LoRAs after the model loader and rewires what read it", () => {
    const built = build({ loras: [{ file: "a.safetensors", weight: 0.8 }, { file: "off.safetensors", weight: 0 }, { file: "b.safetensors", weight: 1 }] });
    const loras = Object.entries(built.graph).filter(([, n]) => n.class_type === "LoraLoaderModelOnly");
    expect(loras.map(([, n]) => n.inputs.lora_name)).toEqual(["a.safetensors", "b.safetensors"]);
    expect(loras[0]![1].inputs.model).toEqual(["37", 0]);
    expect(loras[1]![1].inputs.model).toEqual([loras[0]![0], 0]);
    expect(built.graph["48"]!.inputs.model).toEqual([loras[1]![0], 0]);
    expect(checkGraph(built, catalog)).toEqual([]);
  });

  it("works for a picture workflow with a custom sampler too", () => {
    const r = recipeFromWorkflow(defOf(flux, "Flux picture", "FLUX"));
    const built = r.build(parseInput(r, { prompt: "a dog" }), dryContext({ seed: 99 }));
    expect(built.graph["10"]!.inputs.value).toBe("a dog");
    expect(built.graph["11"]!.inputs.value).toBe(99);
    expect(built.totalSteps).toBe(20);
    expect(built.outputs[0]).toMatchObject({ node: "16", kind: "image" });
    expect(checkGraph(built, catalog)).toEqual([]);
    expect(r.traits).toBeUndefined();
  });

  it("survives being saved and read back as plain data", () => {
    const again = recipeFromWorkflow(workflowDef.parse(JSON.parse(JSON.stringify(def))));
    expect(again.inputs).toEqual(recipe.inputs);
  });
});
