import { describe, expect, it } from "vitest";
import { checkGraph, dryContext, parseInput } from "@studai/core";
import { fillFileName, fromEditor, inspect, isEditorFormat, modesFor, prune, recipeFromWorkflow, splitCaptions, workflowDef, type WorkflowDef } from "../src";
import { chooser, editorFile } from "./editor-fixtures";
import { catalog, sdxl } from "./fixtures";

describe("reading the file ComfyUI's editor saves", () => {
  const read = fromEditor(editorFile, catalog);
  const { graph, wiring } = read;

  it("tells the editor's file from an exported one", () => {
    expect(isEditorFormat(editorFile)).toBe(true);
    expect(isEditorFormat(sdxl)).toBe(false);
    expect(isEditorFormat(null)).toBe(false);
  });

  it("keeps the nodes ComfyUI runs, the ones inside a group node under its id, and none of the editor's own", () => {
    // no reroute, no note, no label, no switch, no group node
    expect(Object.keys(graph).sort()).toEqual(["30", "3:10", "3:20", "3:5", "3:6", "3:7", "3:8", "4", "9"]);
    expect(read.notes).toEqual([]);
  });

  it("matches the bare list of values to the inputs, skipping what is not an input", () => {
    expect(graph["3:10"]!.inputs).toMatchObject({ seed: 42, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1 });
    expect(graph["3:5"]!.inputs).toEqual({ width: 1024, height: 768, batch_size: 1 });
    expect(graph["9"]!.inputs.filename_prefix).toBe("out");
  });

  it("follows links into and out of the group node, through a reroute, and past a link left by a deleted node", () => {
    expect(graph["3:10"]!.inputs).toMatchObject({ model: ["30", 0], positive: ["3:6", 0], negative: ["3:7", 0], latent_image: ["3:5", 0] });
    expect(graph["3:6"]!.inputs.clip).toEqual(["30", 1]);
    expect(graph["3:8"]!.inputs.vae).toEqual(["4", 2]);
    expect(graph["9"]!.inputs.images).toEqual(["3:20", 0]);
  });

  it("reads a list of LoRAs as the inputs that node takes", () => {
    expect(graph["30"]!.inputs).toEqual({
      lora_1: { on: true, lora: "style.safetensors", strength: 0.8, strengthTwo: null },
      lora_2: { on: false, lora: "unused.safetensors", strength: 1, strengthTwo: null },
      model: ["4", 0],
      clip: ["4", 1],
    });
  });

  it("knows what is switched off, and finds the switch with the name its author gave it", () => {
    expect(wiring.modes).toEqual({ "3:20": "bypass" });
    // the field on the front of the group node is the switch: it says off, whatever the node inside says
    expect(wiring.toggles).toEqual([{ id: "sw_3_enabled", label: "🆙 Upscale 2x", default: false, effects: [{ nodes: ["3:20"], activeWhen: true, mode: "bypass" }], writes: [], front: true }]);
  });

  it("keeps the author's control panel and the names given to single settings", () => {
    // "control_after_generate" is a field of the editor, not a setting of the node
    expect(wiring.panel).toEqual([{ node: "3:10", input: "steps" }, { node: "3:10", input: "cfg" }]);
    expect(wiring.labels["3:20.scale_by"]).toBe("↳ How much larger");
    expect(read.groups["3:20"]).toBe("Upscale");
  });

  it("keeps what the file says about where its things come from", () => {
    expect(wiring.packs).toEqual({ "Power Lora Loader (rgthree)": "rgthree-comfy" });
    expect(wiring.downloads).toEqual({ "model.safetensors": "https://example.org/files/model.safetensors" });
    expect(wiring.links).toEqual([{ label: "The checkpoint", url: "https://example.org/models/1" }, { label: "Its LoRA", url: "https://example.org/models/2" }]);
    // on a ComfyUI without that checkpoint and without that pack, both come with where to get them
    const { "Power Lora Loader (rgthree)": _gone, ...without } = catalog;
    const listed = { ...without, CheckpointLoaderSimple: { ...catalog.CheckpointLoaderSimple!, input: { required: { ckpt_name: [["other.safetensors"]] } } } };
    const found = inspect(graph, listed, wiring);
    expect(found.missingFiles).toMatchObject([{ file: "model.safetensors", url: "https://example.org/files/model.safetensors", options: ["other.safetensors"] }]);
    expect(found.missingNodes).toEqual(["Power Lora Loader (rgthree)"]);
    expect(found.packs).toEqual({ "Power Lora Loader (rgthree)": "rgthree-comfy" });
    expect(found.links).toHaveLength(2);
  });

  describe("what runs", () => {
    const run = (values: Record<string, unknown>) => prune(graph, wiring, modesFor(wiring, wiring.toggles, values)).graph;

    it("leaves out a bypassed node and connects its readers to what went into it", () => {
      const off = run({});
      expect(off["3:20"]).toBeUndefined();
      expect(off["9"]!.inputs.images).toEqual(["3:8", 0]);
      expect(checkGraph({ graph: off, phases: {}, outputs: [], totalSteps: 1, loads: [] }, catalog)).toEqual([]);
    });

    it("puts it back when its switch is turned on", () => {
      const on = run({ sw_3_enabled: true });
      expect(on["3:20"]!.inputs).toEqual({ upscale_method: "lanczos", scale_by: 2, image: ["3:8", 0] });
      expect(on["9"]!.inputs.images).toEqual(["3:20", 0]);
      expect(checkGraph({ graph: on, phases: {}, outputs: [], totalSteps: 1, loads: [] }, catalog)).toEqual([]);
    });

    it("gives nothing from a muted node: its reader loses the input", () => {
      const muted = prune(graph, wiring, { "3:20": "bypass", "3:8": "mute" });
      expect(muted.graph["9"]!.inputs.images).toBeUndefined();
      expect([...muted.broken]).toEqual(["9"]);
    });
  });

  describe("as a recipe", () => {
    const found = inspect(graph, catalog, wiring, read.notes);
    const s = found.suggested!;
    const def: WorkflowDef = workflowDef.parse({ id: "workflow.settings", title: "Settings", model: "SDXL", source: "settings.json", graph, wiring, bindings: s });
    const recipe = recipeFromWorkflow(def);
    const build = (over: Record<string, unknown> = {}) => recipe.build(parseInput(recipe, over), dryContext({ seed: 7 }));

    it("finds the parts in what runs, and ticks the author's panel in its order", () => {
      expect(s).toMatchObject({ prompt: { node: "3:6", input: "text" }, negative: { node: "3:7", input: "text" }, seeds: [{ node: "3:10", input: "seed" }], result: { node: "9", kind: "image" } });
      expect(s.controls.map((c) => c.target.input)).toEqual(["steps", "cfg"]);
      expect(s.toggles.map((t) => t.label)).toEqual(["🆙 Upscale 2x"]);
      // a setting of a part that is off is offered too, under the name its author gave it
      expect(found.candidates.find((c) => c.target.input === "scale_by")).toMatchObject({ label: "How much larger", off: true, suggested: false });
    });

    it("takes the workflow's own list of LoRAs as the list, starting with the ones that were on", () => {
      expect(s.loras).toEqual([{ node: "30", output: 0, label: "", power: true }]);
      expect(recipe.inputs.find((i) => i.id === "loras")).toMatchObject({ type: "loras", label: "LoRAs", default: [{ file: "style.safetensors", weight: 0.8 }] });
      expect(build().graph["30"]!.inputs).toEqual({ lora_1: { on: true, lora: "style.safetensors", strength: 0.8 }, model: ["4", 0], clip: ["4", 1] });
      // the user's list replaces it: nothing is chained after
      const changed = build({ loras: [{ file: "other.safetensors", weight: 1 }, { file: "third.safetensors", weight: 0.5 }] });
      expect(changed.graph["30"]!.inputs).toMatchObject({ lora_1: { on: true, lora: "other.safetensors", strength: 1 }, lora_2: { on: true, lora: "third.safetensors", strength: 0.5 } });
      expect(Object.values(changed.graph).some((n) => n.class_type === "LoraLoaderModelOnly")).toBe(false);
      expect(Object.keys(build({ loras: [] }).graph["30"]!.inputs)).toEqual(["model", "clip"]);
    });

    it("has a switch on the form, and builds with or without the part it controls", () => {
      expect(recipe.inputs.find((i) => i.id === "sw_3_enabled")).toMatchObject({ type: "toggle", label: "🆙 Upscale 2x", default: false, advanced: false });
      const off = build({ prompt: "a dog" });
      expect(checkGraph(off, catalog)).toEqual([]);
      expect(off.graph["3:20"]).toBeUndefined();
      expect(off.graph["3:6"]!.inputs.text).toBe("a dog");
      expect(off.graph["3:10"]!.inputs.seed).toBe(7);
      const on = build({ sw_3_enabled: true });
      expect(checkGraph(on, catalog)).toEqual([]);
      expect(on.graph["9"]!.inputs.images).toEqual(["3:20", 0]);
    });

    it("shows a setting of a switched part only while its switch is on, right under it", () => {
      const scale = found.candidates.find((c) => c.target.input === "scale_by")!;
      const { classType: _c, title: _t, suggested: _s, off: _o, ...control } = scale;
      const withScale = recipeFromWorkflow({ ...def, bindings: { ...s, controls: [...s.controls, control] } });
      const ids = withScale.inputs.map((i) => i.id);
      expect(ids.indexOf(control.id)).toBe(ids.indexOf("sw_3_enabled") + 1);
      expect(withScale.inputs.find((i) => i.id === control.id)).toMatchObject({ showWhen: "sw_3_enabled", advanced: false });
      const built = withScale.build(parseInput(withScale, { sw_3_enabled: true, [control.id]: 1.5 }), dryContext());
      expect(built.graph["3:20"]!.inputs.scale_by).toBe(1.5);
    });

    it("only counts the files of what runs as saved", () => {
      // with the address its author left in the workflow, so that it can be fetched when it is missing
      expect(recipe.files).toEqual([{ classType: "CheckpointLoaderSimple", input: "ckpt_name", file: "model.safetensors", url: "https://example.org/files/model.safetensors" }]);
    });
  });
});

describe("file names the editor fills in before it queues", () => {
  const at = new Date(2026, 9, 1, 8, 5, 9);

  it("puts the date in, in the form the name asks for", () => {
    expect(fillFileName("video/%date:yyyy-MM-dd%/%date:hhmmss%", {}, at)).toBe("video/2026-10-01/080509");
    expect(fillFileName("clip_%date:yy-M-d%", {}, at)).toBe("clip_26-10-1");
    expect(fillFileName("plain", {}, at)).toBe("plain");
  });

  it("puts in a value typed into another node, named by its title or its type", () => {
    expect(fillFileName("out/%KSampler.seed%_%Positive.text%", { a: sdxl["3"]!, b: { class_type: "CLIPTextEncode", inputs: { text: "a/b" }, ...{ _meta: { title: "Positive" } } } }, at)).toBe("out/156680208700286_a_b");
    // what it cannot find stays as written
    expect(fillFileName("%Nothing.here%", {}, at)).toBe("%Nothing.here%");
  });

  it("is done to every save node of an imported workflow when it is built", () => {
    const graph = structuredClone(chooser);
    graph["6"]!.inputs.filename_prefix = "studai/%date:yyyy-MM-dd%/out";
    const recipe = recipeFromWorkflow(workflowDef.parse({ id: "workflow.dated", title: "Dated", model: "Test", graph, bindings: inspect(graph, catalog).suggested }));
    const built = recipe.build(parseInput(recipe, { startImage: "asset" }), dryContext({ uploads: { startImage: "a.png" } }));
    expect(built.graph["6"]!.inputs.filename_prefix).toMatch(/^studai\/\d{4}-\d{2}-\d{2}\/out$/);
  });
});

describe("a workflow that chooses between two ways by a yes/no value", () => {
  const found = inspect(chooser, catalog);
  const s = found.suggested!;
  const recipe = recipeFromWorkflow(workflowDef.parse({ id: "workflow.chooser", title: "Chooser", model: "Test", graph: chooser, bindings: s }));
  const build = (over: Record<string, unknown>, uploads: Record<string, string>) => recipe.build(parseInput(recipe, over), dryContext({ uploads }));

  it("asks for the picture the result is made from, and leaves the other one optional", () => {
    expect(s.startImage).toMatchObject({ target: { node: "1", input: "image" }, required: true });
    expect(s.endImage).toMatchObject({ target: { node: "2", input: "image" }, required: false });
  });

  it("offers the choice as two named positions rather than on and off", () => {
    expect(splitCaptions("WAN22: True = I2V | False = FLF2V")).toEqual({ label: "WAN22", captions: { on: "I2V", off: "FLF2V" } });
    expect(splitCaptions("Seconds")).toEqual({ label: "Seconds" });
    const mode = recipe.inputs.find((i) => i.type === "toggle")!;
    expect(mode).toMatchObject({ label: "Mode", default: true, captions: { on: "First", off: "Last" }, advanced: false });
  });

  it("sends only the side that is chosen, so the other needs neither its picture nor its files", () => {
    const first = build({ startImage: "asset-1" }, { startImage: "a.png" });
    expect(Object.keys(first.graph).sort()).toEqual(["1", "3", "6"]);
    expect(first.graph["6"]!.inputs.images).toEqual(["1", 0]);
    expect(checkGraph(first, catalog)).toEqual([]);

    const mode = recipe.inputs.find((i) => i.type === "toggle")!.id;
    const last = build({ startImage: "asset-1", endImage: "asset-2", [mode]: false }, { startImage: "a.png", endImage: "b.png" });
    expect(last.graph["6"]!.inputs.images).toEqual(["4", 0]);
    expect(last.graph["2"]!.inputs.image).toBe("b.png");
    expect(checkGraph(last, catalog)).toEqual([]);
  });

  it("says what is missing when the chosen side needs a picture that was not given", () => {
    const mode = recipe.inputs.find((i) => i.type === "toggle")!.id;
    const built = build({ startImage: "asset-1", [mode]: false }, { startImage: "a.png" });
    expect(checkGraph(built, catalog)).toEqual(['4 ImageScaleBy: missing required "image"']);
  });
});
