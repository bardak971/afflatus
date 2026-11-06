import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { markPng } from "../src/aiMark";
import { newId, now, OWNER } from "../src/db";
import { parseA1111, readEmbedded } from "../src/embedded";
import { infotext, samplingOf } from "../src/pngInfo";
import { writeSettings } from "../src/settings";
import { CHECKPOINT, get, makeApp, referenceCatalog, type TestApp } from "./helpers";

/** A1111's own reading of the settings line (infotext_utils.py re_param_code), ported as it is: what A1111 and Forge take back. */
const RE_PARAM = /\s*(\w[\w \-/]+):\s*("(?:\\.|[^\\"])+"|[^,]*)(?:,|$)/g;
function a1111Reads(text: string): { prompt: string; negative: string; params: Record<string, string> } {
  const lines = text.trim().split("\n");
  let last = lines.pop()!;
  if ([...last.matchAll(RE_PARAM)].length < 3) {
    lines.push(last);
    last = "";
  }
  let prompt = "";
  let negative = "";
  let neg = false;
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith("Negative prompt:")) {
      neg = true;
      line = line.slice(16).trim();
    }
    if (neg) negative += (negative ? "\n" : "") + line;
    else prompt += (prompt ? "\n" : "") + line;
  }
  const params: Record<string, string> = {};
  for (const [, k, v] of last.matchAll(RE_PARAM)) params[k!] = v!.startsWith('"') && v!.endsWith('"') ? (JSON.parse(v!) as string) : v!;
  return { prompt, negative, params };
}

/** The text chunks of a PNG, by keyword (tEXt in Latin-1, iTXt uncompressed in UTF-8, as aiMark.ts writes them). */
function chunks(bytes: Uint8Array): Array<{ type: string; key: string; text: string }> {
  const buf = Buffer.from(bytes);
  const out: Array<{ type: string; key: string; text: string }> = [];
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    const nul = data.indexOf(0);
    if (type === "tEXt") out.push({ type, key: data.toString("latin1", 0, nul), text: data.toString("latin1", nul + 1) });
    if (type === "iTXt") out.push({ type, key: data.toString("latin1", 0, nul), text: data.subarray(nul + 5).toString("utf8") });
    at += 12 + length;
  }
  return out;
}

/** A PNG with a tEXt chunk put in before its end, as ComfyUI's Save Image writes its "prompt" and "workflow". */
function withText(png: Uint8Array, key: string, text: string): Buffer {
  const buf = Buffer.from(png);
  const data = Buffer.from(`${key}\0${text}`, "latin1");
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write("tEXt", 4, "latin1");
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([buf.subarray(0, buf.length - 12), head, data, sum, buf.subarray(buf.length - 12)]);
}

/** ComfyUI's own texts of a render: the graph with a LoRA's sub-folder and an imported workflow's path on this computer. */
const COMFY_GRAPH = JSON.stringify({ "1": { class_type: "LoraLoader", inputs: { lora_name: "people\\Mira.safetensors" } }, "2": { class_type: "VHS_LoadVideoPath", inputs: { video: "C:\\Users\\someone\\clip.mp4" } } });
const comfyPng = () => withText(withText(makePng(8, 8, [1, 2, 3], [4, 5, 6]), "prompt", COMFY_GRAPH), "workflow", JSON.stringify({ nodes: [{ widgets_values: ["people\\Mira.safetensors"] }] }));

describe("A1111's parameters text, as Afflatus writes it", () => {
  it("is A1111's own layout, key for key, quoted where A1111 quotes", () => {
    const text = infotext({
      prompt: "1girl, terrace at sunset", negative: "lowres, bad hands", steps: 28, sampler: "dpmpp_2m", scheduler: "karras", cfg: 6.5, seed: 1234567,
      width: 832, height: 1216, model: { name: "illustrious", hash: "abcdef0123" }, loras: [{ name: "soft_light-v2", weight: 0.8, hash: "0123456789" }], version: "Afflatus 0.9.1",
    });
    expect(text).toBe([
      "1girl, terrace at sunset, <lora:soft_light-v2:0.8>",
      "Negative prompt: lowres, bad hands",
      'Steps: 28, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 6.5, Seed: 1234567, Size: 832x1216, Model hash: abcdef0123, Model: illustrious, Lora hashes: "soft_light-v2: 0123456789", Version: Afflatus 0.9.1',
    ].join("\n"));
  });

  it("reads back in A1111's parser and in Afflatus's own, the same settings", () => {
    const text = infotext({
      prompt: "a harbour, dusk", negative: "", steps: 20, sampler: "euler_ancestral", scheduler: "linear_quadratic", cfg: 7, seed: 5, width: 1024, height: 1024,
      model: { name: "juggernaut, v9", hash: "aaaaaaaaaa", civitai: 11 }, loras: [{ name: "a:b", weight: 1, hash: "bbbbbbbbbb", civitai: 42 }], clipSkip: 2,
      hires: { scale: 1.5, steps: 10, upscaler: "4x-UltraSharp", denoise: 0.35 }, version: "Afflatus dev",
    })!;
    const a = a1111Reads(text);
    expect(a.prompt).toBe("a harbour, dusk, <lora:a:b:1>");
    expect(a.negative).toBe("");
    expect(a.params).toMatchObject({ Steps: "20", Sampler: "Euler a", "Schedule type": "linear_quadratic", "CFG scale": "7", Seed: "5", Size: "1024x1024", "Model hash": "aaaaaaaaaa", Model: "juggernaut, v9", "Clip skip": "2", "Hires upscale": "1.5", "Hires steps": "10", "Hires upscaler": "4x-UltraSharp", "Denoising strength": "0.35", "Lora hashes": "ab: bbbbbbbbbb", Version: "Afflatus dev" });
    // Civitai finds the line by its start, and its own resources by their key
    expect(text.split("\n").at(-1)).toMatch(/^Steps: 20, /);
    expect(text).toContain('Civitai resources: [{"type":"checkpoint","modelVersionId":11,"modelName":"juggernaut, v9"},{"type":"lora","weight":1,"modelVersionId":42,"modelName":"a:b"}]');
    const own = parseA1111(text);
    expect(own).toMatchObject({ prompt: "a harbour, dusk", checkpoint: "juggernaut, v9", checkpointCivitai: 11, steps: 20, cfg: 7, seed: 5, sampler: "euler_ancestral", scheduler: "linear_quadratic", clipSkip: 2, width: 1024, height: 1024, hires: { scale: 1.5, steps: 10, upscaler: "4x-UltraSharp", denoise: 0.35 } });
  });

  it("is not written when the steps are not known: A1111 and Civitai could not find its line", () => {
    expect(infotext({ prompt: "a harbour" })).toBeNull();
  });

  it("reads a graph's sampling settings where the form has none", () => {
    expect(samplingOf({
      "9": { class_type: "KSampler", inputs: { steps: 10, cfg: 2, sampler_name: "lcm", scheduler: "simple" } },
      "3": { class_type: "BasicScheduler", inputs: { steps: 8, scheduler: "beta", model: ["1", 0] } },
      "4": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
      "5": { class_type: "CFGGuider", inputs: { cfg: 1 } },
    })).toEqual({ steps: 8, cfg: 1, sampler: "res_multistep", scheduler: "beta" });
  });
});

describe("texts beside the AI mark", () => {
  const png = () => makePng(8, 8, [10, 20, 30], [40, 50, 60]);
  it("go as tEXt in ASCII, as iTXt in UTF-8 otherwise, and never over a text the file has", async () => {
    const out = markPng(png(), { parameters: "café\nSteps: 1", afflatus: "{}" });
    expect(chunks(out).filter((c) => c.key !== "XML:com.adobe.xmp")).toEqual([
      { type: "tEXt", key: "Comment", text: "AI-generated (Afflatus)" },
      { type: "iTXt", key: "parameters", text: "café\nSteps: 1" },
      { type: "tEXt", key: "afflatus", text: "{}" },
    ]);
    expect((await readEmbedded(out)).settings?.prompt).toBe("café");
    // PIL's tEXt (A1111's, ComfyUI's) is Latin-1: read so where it is not UTF-8
    const pil = Buffer.from(markPng(png(), { x: "y" }));
    const latin = Buffer.from(`parameters\0café\nSteps: 1`, "latin1");
    const head = Buffer.alloc(8);
    head.writeUInt32BE(latin.length, 0);
    head.write("tEXt", 4, "latin1");
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), latin])) >>> 0, 0);
    const withLatin = Buffer.concat([pil.subarray(0, pil.length - 12), head, latin, sum, pil.subarray(pil.length - 12)]);
    expect((await readEmbedded(withLatin)).settings?.prompt).toBe("café");
    // a picture that came with its own parameters keeps them, alone
    const theirs = markPng(png(), { parameters: "theirs\nSteps: 1" }).subarray();
    const unmarked = Buffer.concat([Buffer.from(theirs).subarray(0, 8), ...rest(theirs)]);
    expect(chunks(markPng(unmarked, { parameters: "ours\nSteps: 2" })).filter((c) => c.key === "parameters").map((c) => c.text)).toEqual(["theirs\nSteps: 1"]);
  });
  /** A PNG's chunks but the mark's (the comment and the XMP), as a file that carries only its own texts. */
  const rest = (bytes: Uint8Array): Buffer[] => {
    const buf = Buffer.from(bytes);
    const out: Buffer[] = [];
    for (let at = 8; at + 12 <= buf.length; ) {
      const length = buf.readUInt32BE(at);
      const data = buf.subarray(at + 8, at + 8 + length);
      if (!data.toString("latin1").startsWith("Comment\0") && !data.toString("latin1").startsWith("XML:com.adobe.xmp\0")) out.push(buf.subarray(at, at + 12 + length));
      at += 12 + length;
    }
    return out;
  };
});

describe("a render's picture downloaded, then dropped back", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT], loras: ["styles\\Soft_Light-v2.safetensors", "styles\\Coat.safetensors"], upscale_models: [] } });
    t = await makeApp({ comfyUrl: fake.url });
  });
  afterEach(async () => {
    await t.close();
    await fake.close().catch(() => {});
  });

  const FORM = {
    prompt: "1girl, terrace at sunset", quality: "masterpiece", negative: "lowres, bad hands", checkpoint: CHECKPOINT,
    loras: [{ file: "styles\\Soft_Light-v2.safetensors", weight: 0.8 }], size: { width: 832, height: 1216 }, steps: 30, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras", seed: -1,
  };
  /** A picture filed as a render of the SDXL form, its models hashed (and one matched on Civitai). */
  const rendered = async (bytes: Uint8Array = makePng(8, 8, [1, 2, 3], [4, 5, 6]), form: Record<string, unknown> = FORM, recipe = "sdxl.text-to-picture") => {
    const a = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test", headers: { "content-type": "image/png" }, payload: Buffer.from(bytes) })).json() as { id: string };
    const g = newId();
    await t.db.insertInto("generations").values({ id: g, owner_id: OWNER, recipe_id: recipe, recipe_version: 1, family: recipe.split(".")[0]!, inputs: JSON.stringify(form), resolved: JSON.stringify({ seed: 1234567 }), gen_ms: 1, draft_id: null, created_at: now() } as never).execute();
    await t.db.updateTable("assets").set({ origin: "generated", generation_id: g }).where("id", "=", a.id).execute();
    const hashed = { size: 1, mtime: 1, hashed_at: now(), hf_url: null, matched_at: now() };
    await t.db.insertInto("model_hashes").values({ folder: "checkpoints", file: CHECKPOINT, sha256: `ABCDEF0123${"0".repeat(54)}`, civitai_version: 11, ...hashed }).onConflict((oc) => oc.doNothing()).execute();
    await t.db.insertInto("model_hashes").values({ folder: "loras", file: "styles/Soft_Light-v2.safetensors", sha256: `9876543210${"1".repeat(54)}`, civitai_version: 0, ...hashed }).onConflict((oc) => oc.doNothing()).execute();
    return a.id;
  };
  const download = async (id: string) => new Uint8Array((await get(t.app, `/api/assets/${id}/file?download=1`)).rawPayload);
  const drop = async (bytes: Uint8Array, recipe = "") => (await t.app.inject({ method: "POST", url: `/api/embedded${recipe ? `?recipe=${recipe}` : ""}`, headers: { "content-type": "image/png" }, payload: Buffer.from(bytes) })).json();

  it("carries A1111's parameters with the hashes, never a path, and fills the same form again", async () => {
    const id = await rendered();
    const file = await download(id);
    const texts = Object.fromEntries(chunks(file).map((c) => [c.key, c.text]));
    expect(texts.Comment).toBe("AI-generated (Afflatus)");
    expect(texts.parameters).toBe([
      "masterpiece, 1girl, terrace at sunset, <lora:Soft_Light-v2:0.8>",
      "Negative prompt: lowres, bad hands",
      'Steps: 30, Sampler: DPM++ 2M, Schedule type: Karras, CFG scale: 6.5, Seed: 1234567, Size: 832x1216, Model hash: abcdef0123, Model: illustrious, Lora hashes: "Soft_Light-v2: 9876543210", Version: Afflatus dev, Civitai resources: [{"type":"checkpoint","modelVersionId":11,"modelName":"illustrious"}]',
    ].join("\n"));
    // the LoRA's sub-folder is ComfyUI's, not this computer's: it goes all the same by its name alone
    expect(texts.afflatus).not.toMatch(/styles|\\/);
    expect(JSON.parse(texts.afflatus!)).toMatchObject({ afflatus: 1, recipe: "sdxl.text-to-picture", input: { prompt: FORM.prompt, quality: "masterpiece", seed: 1234567, loras: [{ file: "Soft_Light-v2.safetensors", weight: 0.8 }] } });

    const back = await drop(file);
    expect(back.settings.recipe).toBe("sdxl.text-to-picture");
    expect(back.settings.targets[0]).toEqual({ id: "sdxl.text-to-picture", why: "it was made with it" });
    expect(back.settings.input).toMatchObject({ ...FORM, seed: 1234567 });
  });

  it("goes with its settings into a form that starts from the picture, with its own seed", async () => {
    const back = await drop(await download(await rendered()), "sdxl.redraw");
    expect(back.settings.recipe).toBe("sdxl.redraw");
    expect(back.settings.input).toMatchObject({ prompt: "masterpiece, 1girl, terrace at sunset", checkpoint: CHECKPOINT, loras: [{ file: "styles\\Soft_Light-v2.safetensors", weight: 0.8 }] });
    expect(back.settings.input.seed).toBeUndefined();
    expect(back.settings.input.size).toBeUndefined();
    expect(back.settings.notes.some((n: string) => /img2img/.test(n))).toBe(false);
  });

  it("an A1111 img2img's strength goes into one", async () => {
    const png = markPng(makePng(8, 8, [0, 0, 0], [0, 0, 0]), { parameters: `a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Size: 512x512, Model: illustrious, Denoising strength: 0.45` });
    expect((await drop(png, "sdxl.redraw")).settings.input).toMatchObject({ prompt: "a cat", strength: 0.45, checkpoint: CHECKPOINT });
  });

  it("says the steps a Turbo render ran, not the form's Steps", async () => {
    const steps = async (fast: boolean) => {
      const file = await download(await rendered(undefined, { prompt: "a lighthouse", fast, steps: 40, turboSteps: 8, seed: -1 }, "qwen.text-to-picture"));
      return /Steps: (\d+)/.exec(chunks(file).find((c) => c.key === "parameters")!.text)?.[1];
    };
    expect(await steps(true)).toBe("8");
    expect(await steps(false)).toBe("40");
  });

  it("carries the mark alone with the switch off", async () => {
    const id = await rendered();
    await writeSettings(t.db, { pngInfo: false });
    const keys = chunks(await download(id)).map((c) => c.key);
    expect(keys).toContain("Comment");
    expect(keys).not.toContain("parameters");
    expect(keys).not.toContain("afflatus");
  });

  it("leaves ComfyUI's own graph behind, the switch off or on: the mark alone, or Afflatus's texts and no path", async () => {
    const id = await rendered(comfyPng());
    await writeSettings(t.db, { pngInfo: false });
    const off = await download(id);
    expect(chunks(off).map((c) => c.key).sort()).toEqual(["Comment", "XML:com.adobe.xmp"]);
    expect(Buffer.from(off).toString("latin1")).not.toMatch(/Mira|someone|LoraLoader/);
    // the picture itself is the same
    expect((await readEmbedded(off)).workflow).toBeNull();

    await writeSettings(t.db, { pngInfo: true });
    const on = await download(id);
    expect(chunks(on).map((c) => c.key).sort()).toEqual(["Comment", "XML:com.adobe.xmp", "afflatus", "parameters"]);
    // never a folder or a path: neither ComfyUI's graph nor its sub-folders
    expect(Buffer.from(on).toString("latin1")).not.toMatch(/Mira|someone|styles|people|[A-Z]:\\/);
  });

  it.each(["jpeg", "webp"] as const)("a %s follows the switch too: a render's marked with its parameters, one brought in stripped with it off", async (format) => {
    const shot = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } })[format]().withExif({ IFD0: { Make: "PhoneCo" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2/1" } }).toBuffer();
    const type = `image/${format}`;
    const id = await rendered(await shot());
    await t.db.updateTable("assets").set({ mime: type }).where("id", "=", id).execute();
    const own = (await t.app.inject({ method: "POST", url: `/api/assets?name=zz-test-${format}`, headers: { "content-type": type }, payload: await shot() })).json() as { id: string };
    await writeSettings(t.db, { pngInfo: true });
    const on = Buffer.from(await download(id));
    expect(on.toString("latin1")).toContain("trainedAlgorithmicMedia");
    expect(on.toString("latin1")).not.toMatch(/PhoneCo|styles/);
    expect((await drop(on)).settings.input).toMatchObject({ prompt: "masterpiece, 1girl, terrace at sunset", seed: 1234567, checkpoint: CHECKPOINT });
    expect(Buffer.from(await download(own.id)).toString("latin1")).toContain("PhoneCo");

    await writeSettings(t.db, { pngInfo: false });
    const off = Buffer.from(await download(id));
    expect(off.toString("latin1")).toContain("trainedAlgorithmicMedia");
    expect((await drop(off)).settings).toBeNull();
    const plain = Buffer.from(await download(own.id));
    expect(plain.toString("latin1")).not.toMatch(/PhoneCo|trainedAlgorithmicMedia/);
    expect((await sharp(plain).metadata()).exif).toBeUndefined();
  });

  it("writes a region by its box and words: no cast person, no LoRA folder, no mask", async () => {
    const box = { x: 0.1, y: 0.1, w: 0.4, h: 0.5 };
    const regions = [
      { id: "r1", box, prompt: "a red coat", cast: "kit-person-1", castLora: { file: "people\\Mira.safetensors", weight: 0.9 }, lora: { file: "styles\\Coat.safetensors", weight: 0.5 }, mask: "upload-123.png" },
      { id: "r2", box, prompt: "a hat", lora: { file: "hats\\Gone.safetensors", weight: 0.4 } },
    ];
    const file = await download(await rendered(undefined, { ...FORM, regions }));
    const own = JSON.parse(chunks(file).find((c) => c.key === "afflatus")!.text) as { input: { regions: unknown[] } };
    expect(own.input.regions).toEqual([{ id: "r1", box, prompt: "a red coat", lora: { file: "Coat.safetensors", weight: 0.5 } }, { id: "r2", box, prompt: "a hat", lora: { file: "Gone.safetensors", weight: 0.4 } }]);
    expect(Buffer.from(file).toString("latin1")).not.toMatch(/kit-person|people|styles|hats|upload-123/);

    // dropped back, the box's LoRA is this ComfyUI's file again, its sub-folder with it (card #326); one it has not goes, said
    const back = await drop(file);
    expect(back.settings.input.regions).toEqual([
      { id: "r1", box, prompt: "a red coat", lora: { file: "styles\\Coat.safetensors", weight: 0.5 } },
      { id: "r2", box, prompt: "a hat" },
    ]);
    expect(back.settings.notes).toContain("A region's LoRA (Gone) is not one ComfyUI has: its box goes without it.");
  });

  it("is read from Afflatus's own text alone, when it went out with no A1111 text", async () => {
    const own = JSON.stringify({ afflatus: 1, recipe: "sdxl.text-to-picture", version: 1, input: { prompt: "a lighthouse", checkpoint: "illustrious.safetensors", steps: 28, seed: 42 } });
    const back = await drop(markPng(makePng(8, 8, [0, 0, 0], [0, 0, 0]), { afflatus: own }));
    expect(back.settings.recipe).toBe("sdxl.text-to-picture");
    expect(back.settings.targets[0]).toEqual({ id: "sdxl.text-to-picture", why: "it was made with it" });
    expect(back.settings.input).toMatchObject({ prompt: "a lighthouse", checkpoint: CHECKPOINT, steps: 28, seed: 42 });
  });

  it("dropped into the img2img it was made with, rolls its own seed as the img2img does", async () => {
    const own = JSON.stringify({ afflatus: 1, recipe: "sdxl.redraw", version: 1, input: { prompt: "a lighthouse", strength: 0.4, seed: 42 } });
    const back = await drop(markPng(makePng(8, 8, [0, 0, 0], [0, 0, 0]), { afflatus: own, parameters: "a lighthouse\nSteps: 20, Seed: 42, Size: 512x512, Denoising strength: 0.4" }), "sdxl.redraw");
    expect(back.settings.recipe).toBe("sdxl.redraw");
    expect(back.settings.input.strength).toBe(0.4);
    expect(back.settings.input.seed).toBeUndefined();
  });

  it("goes out without its texts with the switch off when the user brought it in, and as it came with it on", async () => {
    const a = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test", headers: { "content-type": "image/png" }, payload: comfyPng() })).json() as { id: string };
    expect(chunks(await download(a.id)).map((c) => c.key)).toEqual(["prompt", "workflow"]);
    await writeSettings(t.db, { pngInfo: false });
    expect(chunks(await download(a.id))).toEqual([]);
  });
});
