import { describe, expect, it } from "vitest";
import type { RecipeStatus, Scan } from "@afflatus/comfy";
import { familyOn, filesUsed, lackOn, mergeScans } from "../src/machineScans";
import type { Machine } from "../src/settings";

const machine = (id: string, families: Record<string, boolean> = {}): Machine => ({ id, name: id, url: `http://${id}:8188`, dir: "", takes: "all", families, token: "" });
const recipe = (id: string, ready: boolean, options: Record<string, string[]> = {}): RecipeStatus => ({
  id, ready, missingNodes: [], missingSlots: ready ? [] : ["model"], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options,
});
const scan = (recipes: RecipeStatus[], online = true): Scan => ({
  at: "now",
  comfy: online ? ({ online: true, url: "x", nodes: 1 } as Scan["comfy"]) : { online: false, url: "x", error: "away" },
  families: [{ id: "sdxl", slots: [] }, { id: "h3", slots: [] }],
  recipes,
});
const familyOf = (id: string) => (id.startsWith("sdxl") ? "sdxl" : "h3");

describe("familyOn", () => {
  it("takes the machine's switch, then every machine's, then its files", () => {
    expect(familyOn({ families: {} }, machine("a"), "h3", true)).toBe(true);
    expect(familyOn({ families: {} }, machine("a"), "h3", false)).toBe(false);
    expect(familyOn({ families: { h3: false } }, machine("a"), "h3", true)).toBe(false);
    expect(familyOn({ families: { h3: false } }, machine("a", { h3: true }), "h3", false)).toBe(true);
  });
});

describe("mergeScans", () => {
  it("gives one machine's scan unchanged", () => {
    const one = scan([recipe("sdxl-t2i", false)]);
    expect(mergeScans([{ machine: machine("a"), scan: one }], { families: {} }, familyOf)).toBe(one);
  });

  it("is ready where any machine is, and offers every machine's files", () => {
    const a = scan([recipe("sdxl-t2i", true, { ckpt: ["one.safetensors"] }), recipe("h3-i2v", false)]);
    const b = scan([recipe("sdxl-t2i", true, { ckpt: ["two.safetensors", "one.safetensors"] }), recipe("h3-i2v", true, { unet: ["h3.safetensors"] })]);
    const merged = mergeScans([{ machine: machine("a"), scan: a }, { machine: machine("b"), scan: b }], { families: {} }, familyOf);
    expect(merged.recipes.find((r) => r.id === "sdxl-t2i")?.options.ckpt).toEqual(["one.safetensors", "two.safetensors"]);
    expect(merged.recipes.find((r) => r.id === "h3-i2v")?.ready).toBe(true);
  });

  it("leaves out a machine where the family is off, and one that does not answer", () => {
    const a = scan([recipe("h3-i2v", false)]);
    const b = scan([recipe("h3-i2v", true)]);
    const c = scan([recipe("h3-i2v", true)], false);
    const off = mergeScans([{ machine: machine("a"), scan: a }, { machine: machine("b", { h3: false }), scan: b }, { machine: machine("c"), scan: c }], { families: {} }, familyOf);
    expect(off.recipes.find((r) => r.id === "h3-i2v")?.ready).toBe(false);
  });
});

describe("lackOn, why it cannot be sent", () => {
  const h3 = { id: "h3-i2v", family: "h3", inputs: [{ id: "unet", type: "model", folder: "diffusion_models", label: "Model", slot: "model" }] } as never;
  it("names a node no pack Afflatus can install, and ComfyUI refusing it", () => {
    const node = scan([{ ...recipe("h3-i2v", false, { unet: [] }), missingNodes: ["SomeUnknownNode"] }]);
    expect(lackOn(h3, { unet: "h3.safetensors" }, node, { families: {} }, machine("b"), familyOf)).toMatchObject({ sendable: false, why: expect.stringMatching(/lacks SomeUnknownNode, of no node pack/) });
    const refused = scan([{ ...recipe("h3-i2v", false, { unet: [] }), problems: ["Value not in list: weight_dtype"] }]);
    expect(lackOn(h3, { unet: "h3.safetensors" }, refused, { families: {} }, machine("b"), familyOf)).toMatchObject({ sendable: false, why: "its ComfyUI refuses it: Value not in list: weight_dtype" });
    // sendable: no reason said
    expect(lackOn(h3, { unet: "h3.safetensors" }, scan([recipe("h3-i2v", false, { unet: [] })]), { families: {} }, machine("b"), familyOf)).not.toHaveProperty("why");
  });
});

describe("lackOn", () => {
  const h3 ={ id: "h3-i2v", family: "h3", inputs: [{ id: "unet", type: "model", folder: "diffusion_models", label: "Model", slot: "model" }] } as never;
  it("says the files a machine lacks, and calls a family off only when it was switched off", () => {
    const none = scan([recipe("h3-i2v", false, { unet: [] })]);
    // no H3 file there: the family follows its files, so it is not "off", it lacks the file asked for
    expect(lackOn(h3, { unet: "h3.safetensors" }, none, { families: {} }, machine("b"), familyOf)).toEqual({ off: false, files: [{ file: "h3.safetensors", folder: "diffusion_models" }], sendable: true });
    // switched off on that machine: said so, ready or not
    const all = scan([recipe("h3-i2v", true, { unet: ["h3.safetensors"] })]);
    expect(lackOn(h3, { unet: "h3.safetensors" }, all, { families: {} }, machine("b", { h3: false }), familyOf)).toEqual({ off: true, files: [], sendable: false });
    expect(lackOn(h3, { unet: "h3.safetensors" }, all, { families: {} }, machine("b"), familyOf)).toBeNull();
  });

  it("never asks for a family's usual file where the job picks its own (a pod would fetch a model it never uses)", () => {
    // SDXL: its checkpoint picked per render, an input that names no slot; the family's only checkpoint slot has a usual file
    const sdxl = { id: "sdxl-t2p", family: "sdxl", inputs: [{ id: "checkpoint", type: "model", folder: "checkpoints", label: "Checkpoint" }] } as never;
    const slot = { id: "checkpoint", label: "Checkpoint", folder: "checkpoints", file: null, choices: [], auto: null, chosen: false, optional: false, hint: "", get: { file: "sd_xl_base_1.0.safetensors", url: "https://huggingface.co/x/sd_xl_base_1.0.safetensors" } };
    const empty: Scan = { ...scan([{ ...recipe("sdxl-t2p", false, { checkpoint: [] }), missingSlots: ["checkpoint"] }]), families: [{ id: "sdxl", slots: [slot] }] };
    const lack = lackOn(sdxl, { checkpoint: "illustrious.safetensors" }, empty, { families: {} }, machine("b"), familyOf);
    expect(lack).toEqual({ off: false, files: [{ file: "illustrious.safetensors", folder: "checkpoints" }], sendable: true });
    expect(filesUsed(sdxl, { checkpoint: "illustrious.safetensors" }, empty, [slot])).toEqual([{ file: "illustrious.safetensors", folder: "checkpoints" }]);
    // a family with two required files in one folder: the job's pick fills neither by folder alone, the other is still asked
    const other = { ...slot, id: "ref", get: { file: "ref.safetensors", url: "https://huggingface.co/x/ref.safetensors" } };
    expect(filesUsed(sdxl, { checkpoint: "illustrious.safetensors" }, empty, [slot, other]).map((f) => f.file)).toEqual(["illustrious.safetensors", "sd_xl_base_1.0.safetensors", "ref.safetensors"]);
  });

  it("names the node packs a machine lacks when it knows every one: a pod can be sent them too", () => {
    const status = (over: Partial<RecipeStatus>) => scan([{ ...recipe("h3-i2v", false, { unet: ["h3.safetensors"] }), missingSlots: [], ...over }]);
    const lack = (s: Scan) => lackOn(h3, { unet: "h3.safetensors" }, s, { families: {} }, machine("b"), familyOf);
    // the Impact pack's detailer: no file missing, only the pack
    expect(lack(status({ missingNodes: ["FaceDetailer", "DetailerForEach"] }))).toEqual({ off: false, files: [], sendable: true, packs: ["comfyui-impact-pack"] });
    // a node no pack Afflatus knows brings: it cannot be sent
    expect(lack(status({ missingNodes: ["FaceDetailer", "SomeoneElsesNode"] }))?.sendable).toBe(false);
  });

  it("says when the files are all a machine lacks: what a rented pod can be sent", () => {
    const status = (over: Partial<RecipeStatus>) => scan([{ ...recipe("h3-i2v", false, { unet: [] }), ...over }]);
    const lack = (s: Scan, h = h3) => lackOn(h, { unet: "h3.safetensors" }, s, { families: {} }, machine("b"), familyOf);
    expect(lack(status({}))?.sendable).toBe(true);
    // a node no known pack brings, or something else ComfyUI would refuse: what it lacks cannot all be sent
    expect(lack(status({ missingNodes: ["SomeoneElsesNode"] }))?.sendable).toBe(false);
    expect(lack(status({ problems: ["sampler x is not offered"] }))?.sendable).toBe(false);
    // a family file no input stands for and no address is known for
    expect(lack(status({ missingSlots: ["model", "vae"] }))?.sendable).toBe(false);
    // an input with nothing to pick that no job file fills (a choice among files)
    expect(lack(status({ emptyInputs: ["upscaler"] }))?.sendable).toBe(false);
    expect(lack(status({ emptyInputs: ["unet"] }))?.sendable).toBe(true);
  });
});
