import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@studai/comfy/testing";
import { parseA1111, readEmbedded } from "../src/embedded";
import { CHECKPOINT, makeApp, referenceCatalog, type TestApp } from "./helpers";

/** A PNG with text chunks in it, the way A1111 and ComfyUI write them. (The reader does not check the checksums.) */
function pngWith(texts: Record<string, string>): Uint8Array {
  const png = Buffer.from(makePng(8, 8, [10, 20, 30], [40, 50, 60]));
  const end = png.length - 12;
  const chunks = Object.entries(texts).map(([key, text]) => {
    const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(text, "utf8")]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write("tEXt", 4, "latin1");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  });
  return new Uint8Array(Buffer.concat([png.subarray(0, end), ...chunks, png.subarray(end)]));
}

const A1111 = `1girl, solo, terrace at sunset, <lora:soft_light-v2:0.8>, <lora:not_here:1>
Negative prompt: lowres, bad hands
Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 6.5, Seed: 1234567, Size: 832x1216, Model hash: abc123, Model: Illustrious, Clip skip: 2, Hires upscale: 1.5, Hires upscaler: R-ESRGAN 4x+, Denoising strength: 0.35, Civitai resources: [{"type":"checkpoint","modelVersionId":11,"modelName":"Illustrious"},{"type":"lora","modelVersionId":42,"modelName":"not_here","weight":1}], Version: v1.9`;

const GRAPH = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sub\\Illustrious.safetensors" } },
  "2": { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: "Soft_Light-v2.safetensors", strength_model: 0.6, strength_clip: 0.6 } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "a harbour at dusk", clip: ["2", 1] } },
  "4": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["2", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1216, height: 832, batch_size: 1 } },
  "6": { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], seed: 99, steps: 24, cfg: 5, sampler_name: "euler_ancestral", scheduler: "normal", denoise: 1 } },
};

describe("what a picture says about how it was made", () => {
  it("reads A1111's text: words, LoRAs out of the words, settings in ComfyUI's names, Civitai's versions", () => {
    const s = parseA1111(A1111);
    expect(s).toMatchObject({
      source: "a1111", prompt: "1girl, solo, terrace at sunset", negative: "lowres, bad hands", checkpoint: "Illustrious", checkpointCivitai: 11,
      steps: 30, cfg: 6.5, seed: 1234567, sampler: "dpmpp_2m", scheduler: "karras", clipSkip: 2, width: 832, height: 1216,
      hires: { scale: 1.5, upscaler: "R-ESRGAN 4x+", denoise: 0.35 },
    });
    expect(s.loras).toEqual([{ name: "soft_light-v2", weight: 0.8 }, { name: "not_here", weight: 1, civitai: 42 }]);
  });

  it("reads a ComfyUI graph and keeps the workflow beside it", async () => {
    const found = await readEmbedded(pngWith({ prompt: JSON.stringify(GRAPH), workflow: JSON.stringify({ nodes: [], links: [] }) }));
    expect(found.settings).toMatchObject({ source: "comfyui", prompt: "a harbour at dusk", negative: "blurry", checkpoint: "Illustrious", steps: 24, sampler: "euler_ancestral", width: 1216, height: 832, seed: 99 });
    expect(found.settings!.loras).toEqual([{ name: "Soft_Light-v2", weight: 0.6 }]);
    // the editor's own form of the workflow is the one handed to the import screen
    expect(found.workflow).toEqual({ nodes: [], links: [] });
  });

  it("gives the workflow alone when the graph is not built around a checkpoint, and says so when a file holds nothing", async () => {
    const other = { "1": { class_type: "UNETLoader", inputs: { unet_name: "x.safetensors" } } };
    const onlyWorkflow = await readEmbedded(pngWith({ prompt: JSON.stringify(other) }));
    expect(onlyWorkflow.settings).toBeNull();
    expect(onlyWorkflow.workflow).toEqual(other);
    expect(onlyWorkflow.why).toContain("Import its workflow");
    const nothing = await readEmbedded(makePng(8, 8, [0, 0, 0], [0, 0, 0]));
    expect(nothing).toMatchObject({ settings: null, workflow: null, why: expect.stringContaining("Nothing about how it was made") });
  });
});

describe("a dropped picture's settings, as a form", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT, "other.safetensors"], loras: ["styles\\Soft_Light-v2.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });
  const read = async (bytes: Uint8Array) => (await t.app.inject({ method: "POST", url: "/api/embedded", headers: { "content-type": "image/png" }, payload: Buffer.from(bytes) })).json();

  it("uses the files this ComfyUI has, whatever folder they are in, and lists what it lacks", async () => {
    const out = await read(pngWith({ parameters: A1111.replace("Model: Illustrious", "Model: illustrious") }));
    expect(out.settings.recipe).toBe("sdxl.text-to-picture");
    expect(out.settings.input).toMatchObject({
      prompt: "1girl, solo, terrace at sunset", negative: "lowres, bad hands", checkpoint: CHECKPOINT,
      loras: [{ file: "styles\\Soft_Light-v2.safetensors", weight: 0.8 }],
      size: { width: 832, height: 1216 }, steps: 30, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras", clipSkip: 2, seed: 1234567,
      hires: true, hiresScale: 1.5, hiresUpscaler: "latent", hiresDenoise: 0.35,
    });
    expect(out.settings.model).toEqual({ name: "illustrious", found: true });
    expect(out.settings.loras).toEqual([{ name: "soft_light-v2", weight: 0.8, found: true }, { name: "not_here", weight: 1, found: false }]);
    // what is missing can be fetched: the folder it goes in, and its Civitai version when the picture says
    expect(out.settings.missing).toEqual([{ file: "not_here.safetensors", folder: "loras", civitai: 42 }]);
    // nothing was kept
    expect((await t.app.inject({ method: "GET", url: "/api/assets" })).json().items).toEqual([]);
  });

  it("keeps the form's own model when the picture's is not there", async () => {
    const out = await read(pngWith({ parameters: A1111.replace("Model: Illustrious", "Model: SomethingElse_v3") }));
    expect(out.settings.input.checkpoint).toBeUndefined();
    expect(out.settings.model).toEqual({ name: "SomethingElse_v3", found: false });
    expect(out.settings.missing[0]).toEqual({ file: "SomethingElse_v3.safetensors", folder: "checkpoints", civitai: 11 });
  });

  it("answers with why when the picture holds nothing", async () => {
    const out = await read(makePng(8, 8, [0, 0, 0], [0, 0, 0]));
    expect(out).toMatchObject({ settings: null, workflow: null, why: expect.stringContaining("Nothing about how it was made") });
  });
});
