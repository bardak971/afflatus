import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { parseA1111, readEmbedded } from "../src/embedded";
import { sameModel } from "../src/fromPicture";
import { sdxl } from "../../../packages/workflows/test/fixtures";
import { CHECKPOINT, makeApp, post, referenceCatalog, type TestApp } from "./helpers";

/** A PNG with text chunks in it, the way A1111 and ComfyUI write them. */
function pngWith(texts: Record<string, string>): Uint8Array {
  const png = Buffer.from(makePng(8, 8, [10, 20, 30], [40, 50, 60]));
  const end = png.length - 12;
  const chunks = Object.entries(texts).map(([key, text]) => {
    const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(text, "utf8")]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write("tEXt", 4, "latin1");
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, sum]);
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

describe("which form a picture's settings go to", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: [], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });
  const made = (model: string) => pngWith({ parameters: `a lighthouse at dusk
Negative prompt: blurry
Steps: 12, Sampler: er_sde_beta, CFG scale: 3.5, Seed: 42, Size: 1088x1920, Model: ${model}` });

  it("tells a model by its name, with or without what a site adds to it", () => {
    expect(sameModel("someModel_v10Krea2", "Krea2\\someModel_v10Krea2_fp8.safetensors")).toBe(true);
    expect(sameModel("someModel_v10Krea2", "someModel_v10Krea2.safetensors")).toBe(true);
    expect(sameModel("someModel_v10Krea2", "someModel_v9.safetensors")).toBe(false);
    // a short name is the start of too many others
    expect(sameModel("model", "model_v2.safetensors")).toBe(false);
  });

  it("reads a sampler written with its scheduler behind it", () => {
    expect(parseA1111("x\nSteps: 12, Sampler: er_sde_beta, CFG scale: 3")).toMatchObject({ sampler: "er_sde", scheduler: "beta" });
    expect(parseA1111("x\nSteps: 12, Sampler: dpmpp_2m_sgm_uniform, CFG scale: 3")).toMatchObject({ sampler: "dpmpp_2m", scheduler: "sgm_uniform" });
  });

  it("is the workflow that loads that model, and another when asked; the same from a file and from the library", async () => {
    const found = (await post(t.app, "/api/workflows/inspect", sdxl)).json();
    const id = (await post(t.app, "/api/workflows", { title: "Mine", model: "SDXL", source: "x.json", graph: sdxl, bindings: found.suggested })).json().id as string;
    const send = async (query = "") => (await t.app.inject({ method: "POST", url: `/api/embedded${query}`, headers: { "content-type": "image/png" }, payload: Buffer.from(made("sd_xl_base_1.0")) })).json();

    const first = await send();
    // the workflow names that very model in its loader: it comes first, and says why
    expect(first.settings.targets[0]).toEqual({ id, why: "it uses this model" });
    expect(first.settings).toMatchObject({ recipe: id, model: { name: "sd_xl_base_1.0", found: true } });
    expect(first.settings.input).toMatchObject({ prompt: "a lighthouse at dusk", negative: "blurry", size: { width: 1088, height: 1920 }, seed: 42 });
    // its settings are the node's own: the steps and cfg of its sampler
    expect(Object.entries(first.settings.input).filter(([k]) => /steps|cfg/.test(k)).map(([, v]) => v).sort()).toEqual([12, 3.5]);

    const asked = await send("?recipe=sdxl.text-to-picture");
    expect(asked.settings).toMatchObject({ recipe: "sdxl.text-to-picture", model: { name: "sd_xl_base_1.0", found: false } });
    expect(asked.settings.input).toMatchObject({ prompt: "a lighthouse at dusk", steps: 12, cfg: 3.5, seed: 42 });
    expect(asked.settings.missing).toEqual([{ file: "sd_xl_base_1.0.safetensors", folder: "checkpoints" }]);

    // once it is in the library, the same is read from the file that was kept
    const kept = (await t.app.inject({ method: "POST", url: "/api/assets?name=found.png", headers: { "content-type": "image/png" }, payload: Buffer.from(made("sd_xl_base_1.0")) })).json();
    const later = (await t.app.inject({ method: "GET", url: `/api/assets/${kept.id}/embedded` })).json();
    expect(later.settings).toMatchObject({ recipe: id, input: { prompt: "a lighthouse at dusk" } });
    expect((await t.app.inject({ method: "GET", url: "/api/assets/nope/embedded" })).statusCode).toBe(404);
  });

  it("falls back to txt2img when nothing is known to use that model", async () => {
    const out = (await t.app.inject({ method: "POST", url: "/api/embedded", headers: { "content-type": "image/png" }, payload: Buffer.from(made("never_heard_of_it_v3")) })).json();
    expect(out.settings.recipe).toBe("sdxl.text-to-picture");
    expect(out.settings.targets[0]).toEqual({ id: "sdxl.text-to-picture" });
  });
});

/** A PNG with one compressed text chunk (zTXt) holding `text`. */
function pngWithCompressed(key: string, text: Buffer): Uint8Array {
  const png = Buffer.from(makePng(8, 8, [10, 20, 30], [40, 50, 60]));
  const end = png.length - 12;
  const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0, 0]), deflateSync(text)]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write("zTXt", 4, "latin1");
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return new Uint8Array(Buffer.concat([png.subarray(0, end), head, data, sum, png.subarray(end)]));
}

describe("a stranger's picture", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(() => t.close());

  it("is read when its compressed text is a workflow's size, and not unpacked past a megabyte (a decompression bomb)", async () => {
    const small = await readEmbedded(pngWithCompressed("prompt", Buffer.from(JSON.stringify(GRAPH))));
    expect(small.settings).toMatchObject({ source: "comfyui", prompt: "a harbour at dusk" });
    // 64 MB of one letter packs into about 64 kB
    const bomb = pngWithCompressed("parameters", Buffer.alloc(64 << 20, "a"));
    expect(bomb.length).toBeLessThan(200_000);
    const start = performance.now();
    expect(await readEmbedded(bomb)).toMatchObject({ settings: null, workflow: null });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("with odd ComfyUI metadata gives no settings, never a server error", async () => {
    const odd = [
      { "1": { class_type: "CheckpointLoaderSimple" }, "2": { class_type: "KSampler", inputs: { steps: 20 } } },
      { "1": { class_type: "KSampler" } },
      { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } }, "2": { class_type: "KSampler", inputs: "x" } },
      { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } }, "2": { class_type: "KSampler", inputs: [] } },
    ];
    for (const graph of odd) {
      expect((await readEmbedded(pngWith({ prompt: JSON.stringify(graph) }))).settings).toBeNull();
      const res = await t.app.inject({ method: "POST", url: "/api/embedded", headers: { "content-type": "image/png" }, payload: Buffer.from(pngWith({ prompt: JSON.stringify(graph) })) });
      expect(res.statusCode).toBe(200);
    }
  });
});
