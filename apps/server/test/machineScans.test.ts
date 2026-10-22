import { describe, expect, it } from "vitest";
import type { RecipeStatus, Scan } from "@afflatus/comfy";
import { parseInput } from "@afflatus/core";
import { recipes, sdxlTextToPicture } from "@afflatus/recipes";
import { familyOn, filesAsked, filesUsed, lackOn, mergeScans } from "../src/machineScans";
import type { Machine } from "../src/settings";

const machine = (id: string, families: Record<string, boolean> = {}): Machine => ({ id, name: id, url: `http://${id}:8188`, dir: "", dirCleared: "", takes: "all", packs: "ask", families, token: "" });
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

  it("names a family file by its download when its graph could not be built, as a pod's own check does (one VAE fetched twice, 2026-10-18)", () => {
    const vae = { id: "vae", label: "VAE", folder: "vae", optional: false, get: { file: "vae_int8.safetensors", url: "https://huggingface.co/x/vae_int8.safetensors" } };
    const here = { ...scan([]), families: [{ id: "h3", slots: [{ ...vae, file: "vae_fp16.safetensors", choices: [], auto: null, chosen: false, hint: "" }] }] } as Scan;
    expect(filesUsed({ family: "h3", inputs: [] } as never, {}, here, [vae])).toEqual([{ file: "vae_int8.safetensors", folder: "vae", url: vae.get.url }]);
    // a slot with no download known is this PC's file, sent from here
    expect(filesUsed({ family: "h3", inputs: [] } as never, {}, here, [{ ...vae, get: undefined }])).toEqual([{ file: "vae_fp16.safetensors", folder: "vae" }]);
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

describe("lackOn, a family file the job's choices ask for", () => {
  /** Wan as a pod has it: its two models, no turbo LoRA. */
  const wan = { id: "wan.video", family: "wan", inputs: [], needsWith: (input: Record<string, unknown>) => (input.fast ? ["i2vTurboHigh", "i2vTurboLow"] : []) };
  const turboSlots = [
    { id: "i2vTurboHigh", label: "Turbo LoRA (i2v, high noise)", folder: "loras", optional: true, file: null, get: { file: "high_lightx2v.safetensors", url: "https://huggingface.co/x/high_lightx2v.safetensors" } },
    { id: "i2vTurboLow", label: "Turbo LoRA (i2v, low noise)", folder: "loras", optional: true, file: null, get: { file: "low_lightx2v.safetensors", url: "https://huggingface.co/x/low_lightx2v.safetensors" } },
  ];
  const pod = (slots: unknown[]): Scan => ({ ...scan([recipe("wan.video", true)]), families: [{ id: "wan", slots }] as Scan["families"] });

  it("sends a pod Turbo's LoRAs when Turbo is on, and asks nothing with it off", () => {
    const lack = lackOn(wan as never, { fast: true }, pod(turboSlots), { families: {} }, machine("pod"), () => "wan");
    expect(lack).toMatchObject({ sendable: true, files: [{ file: "high_lightx2v.safetensors", folder: "loras" }, { file: "low_lightx2v.safetensors", folder: "loras" }] });
    expect(lackOn(wan as never, { fast: false }, pod(turboSlots), { families: {} }, machine("pod"), () => "wan")).toBeNull();
    // there already: nothing lacks
    expect(lackOn(wan as never, { fast: true }, pod(turboSlots.map((s) => ({ ...s, file: s.get.file }))), { families: {} }, machine("pod"), () => "wan")).toBeNull();
  });

  it("says why when no download is known for one", () => {
    const lack = lackOn(wan as never, { fast: true }, pod(turboSlots.map((s, i) => (i ? { ...s, get: undefined } : s))), { families: {} }, machine("pod"), () => "wan");
    expect(lack).toMatchObject({ sendable: false, why: "its Turbo LoRA (i2v, low noise) file is not there, and no download is known for it" });
  });

  it("counts them among the files a job uses (a pod just deployed gets them)", () => {
    expect(filesUsed(wan as never, { fast: true }, null, turboSlots).map((f) => f.file)).toEqual(["high_lightx2v.safetensors", "low_lightx2v.safetensors"]);
    expect(filesUsed(wan as never, { fast: false }, null, turboSlots)).toEqual([]);
  });
});

describe("lackOn, Turbo with the model left to the family's file (review K-10)", () => {
  const qwenPicture = recipes.find((r) => r.id === "qwen.text-to-picture")!;
  const turbo = { id: "turbo", label: "Turbo LoRA", folder: "loras", optional: true, file: null, get: { file: "qwen_lightning.safetensors", url: "https://huggingface.co/x/qwen_lightning.safetensors" } };
  const pod = (unet: string): Scan => ({ ...scan([recipe("qwen.text-to-picture", true)]), families: [{ id: "qwen", slots: [{ id: "unet", label: "Model", folder: "diffusion_models", optional: false, file: unet }, turbo] }] as Scan["families"] });

  it("asks no turbo LoRA when the family's file there is made for a few steps, and asks it for a plain one", () => {
    expect(lackOn(qwenPicture, { fast: true }, pod("qwen_image_lightning_8steps.safetensors"), { families: {} }, machine("pod"), () => "qwen")).toBeNull();
    expect(lackOn(qwenPicture, { fast: true }, pod("qwen_image_fp8.safetensors"), { families: {} }, machine("pod"), () => "qwen")).toMatchObject({ files: [{ file: "qwen_lightning.safetensors" }] });
    const used = (unet: string) => filesUsed(qwenPicture, { fast: true }, pod(unet), pod(unet).families[0]!.slots).map((f) => f.file);
    expect(used("qwen_image_lightning_8steps.safetensors")).not.toContain("qwen_lightning.safetensors");
    expect(used("qwen_image_fp8.safetensors")).toContain("qwen_lightning.safetensors");
  });
});

describe("filesAsked, a choice among a model folder's files", () => {
  // the SDXL picture with hires fix through an upscale model: a pod sent its checkpoint, text encoder and VAE, never its
  // upscaler, and every render there failed with "Missing model file RealESRGAN_x4plus_anime_6B.pth"
  const ANIME = "RealESRGAN_x4plus_anime_6B.pth";
  const hires = (over: Record<string, unknown>) => parseInput(sdxlTextToPicture, { prompt: "a", checkpoint: "illustrious.safetensors", ...over }) as unknown as Record<string, unknown>;

  it("asks for the hires upscaler chosen, in upscale_models, only while hires fix is on and an upscale model is chosen", () => {
    expect(filesAsked(sdxlTextToPicture, hires({ hires: true, hiresUpscaler: ANIME }))).toEqual([
      { input: "checkpoint", file: "illustrious.safetensors", folder: "checkpoints" },
      { input: "hiresUpscaler", file: ANIME, folder: "upscale_models" },
    ]);
    // hires fix off: its upscaler (the default, filled in) is never loaded
    expect(filesAsked(sdxlTextToPicture, hires({ hires: false, hiresUpscaler: ANIME })).map((f) => f.input)).toEqual(["checkpoint"]);
    // enlarged in latent space: no file
    expect(filesAsked(sdxlTextToPicture, hires({ hires: true, hiresUpscaler: "latent" })).map((f) => f.input)).toEqual(["checkpoint"]);
    // a pod just deployed for the job is sent it too
    expect(filesUsed(sdxlTextToPicture, hires({ hires: true, hiresUpscaler: ANIME }), null, [])).toContainEqual({ file: ANIME, folder: "upscale_models" });
  });

  it("asks for every recipe's choices among model files, each in its folder (a detector, a ControlNet, an upscale model)", () => {
    const folders = new Map<string, string>();
    for (const r of recipes) {
      for (const i of r.inputs) {
        if (i.type !== "choice" || Array.isArray(i.options)) continue;
        const asked = filesAsked({ inputs: [{ ...i, showWhen: undefined }] }, { [i.id]: "zz-test.pth" });
        for (const a of asked) folders.set(`${i.options.node}.${i.options.input}`, a.folder);
      }
    }
    expect(Object.fromEntries(folders)).toMatchObject({
      "UpscaleModelLoader.model_name": "upscale_models", "UltralyticsDetectorProvider.model_name": "ultralytics", "ControlNetLoader.control_net_name": "controlnet",
    });
    // a choice among settings is no file
    expect([...folders.keys()].filter((k) => /sampler|scheduler|weight_dtype/.test(k))).toEqual([]);
  });

  it("has a machine that lacks it say so, a home machine as a pod, and a pod sent it", () => {
    const status = { ...recipe("sdxl.text-to-picture", true, { checkpoint: ["illustrious.safetensors"], hiresUpscaler: ["latent", "4x-UltraSharp.pth"] }), missingSlots: [] };
    const lack = lackOn(sdxlTextToPicture, hires({ hires: true, hiresUpscaler: ANIME }), scan([status]), { families: {} }, machine("home"), familyOf);
    expect(lack).toEqual({ off: false, files: [{ file: ANIME, folder: "upscale_models" }], sendable: true });
    expect(lackOn(sdxlTextToPicture, hires({ hires: true, hiresUpscaler: "4x-UltraSharp.pth" }), scan([status]), { families: {} }, machine("home"), familyOf)).toBeNull();
    // a ComfyUI with no upscale model at all: the input has nothing to pick, and the job's file fills it
    const none = { ...status, ready: false, options: { ...status.options, hiresUpscaler: ["latent"] }, emptyInputs: ["hiresUpscaler"] };
    expect(lackOn(sdxlTextToPicture, hires({ hires: true, hiresUpscaler: ANIME }), scan([none]), { families: {} }, machine("pod"), familyOf)).toMatchObject({ files: [{ file: ANIME, folder: "upscale_models" }], sendable: true });
  });
});
