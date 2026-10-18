import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import type { RecipeStatus, Scan } from "@afflatus/comfy";
import { dryContext, graphFiles, missingSlotFile, missingSlotIn, parseInput, type GraphFile } from "@afflatus/core";
import { h3, h3Video } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { offeredOn, podSlotFiles } from "../src/jobFiles";
import { filesUsed, lackOn } from "../src/machineScans";
import { CHECKPOINT, makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A rented pod is sent what the waiting jobs' graphs load, each file once under one name. The pod deployed for one swap
 * (Mask off) on 2026-10-18 listed 9 files for the 5 it loads: the family's video model twice over (this PC's and the
 * download), one VAE under two names, and SAM 3.
 */

const FUSED = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors";
const SWAP_LORA = "h3_character_swap_v1.5.safetensors";
const slot = (id: string) => h3.slots.find((s) => s.id === id)!;
const download = (id: string) => slot(id).get!.file;

// this PC: its own video model and an fp16 video VAE, where the family's downloads are other files
const HERE = {
  checkpoints: [CHECKPOINT, "sam3.1_multiplex_fp16.safetensors"],
  diffusion_models: ["DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors", FUSED],
  text_encoders: ["qwen3vl_32b_minimax_h3_fp8.safetensors"],
  vae: ["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae.safetensors"],
  loras: [SWAP_LORA],
  upscale_models: [],
};

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: HERE });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
  await fake.close().catch(() => {});
});

async function video(): Promise<string> {
  const id = newId();
  const at = now();
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind: "video", origin: "uploaded", name: "zz-test source", file_key: `assets/${id}`, thumb_key: null, mime: "video/mp4", bytes: 4,
    width: 864, height: 480, duration_ms: 5000, fps: 24, has_sound: 1, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
  } as never).execute();
  return id;
}

const row = (recipe: string, inputs: Record<string, unknown>) => ({ id: `zz-test-${newId()}`, recipe_id: recipe, inputs: JSON.stringify(inputs), finished_from: null as string | null, clip_id: null, clip_fit: 0, clip_mirror: null });
const swapRow = async (over: Record<string, unknown> = {}) => row("h3.swap", { who: "the man", source: { asset: await video() }, references: [], fast: false, swapModel: FUSED, swapLora: SWAP_LORA, ...over });

/** The files the Deploy dialog lists for one waiting job, as the dialog asks for them. */
async function deployed(r: ReturnType<typeof row>) {
  const recipe = t.services.registry.recipe(r.recipe_id)!;
  const scan = await (await t.services.comfy()).scan();
  return filesUsed(recipe, JSON.parse(r.inputs), scan, h3.slots, await t.services.queue.loadedOnNew(r));
}

describe("the files a pod is sent for a waiting job", () => {
  it("are the 5 a swap with the Mask off loads: no family video model, no SAM, one video VAE; RIFE too with RIFE ×2 on", async () => {
    const files = await deployed(await swapRow({ smooth: false }));
    expect(files.map((f) => f.file).sort()).toEqual([FUSED, SWAP_LORA, download("clip"), download("videoVae"), download("audioVae")].sort());
    // RIFE ×2 on (the form's default): RIFE's download too, which a pod could not get before (2026-10-18)
    const smooth = await deployed(await swapRow());
    expect(smooth.map((f) => f.file).sort()).toEqual([FUSED, SWAP_LORA, download("clip"), download("videoVae"), download("audioVae"), download("rife")].sort());
    expect(smooth.find((f) => f.file === download("rife"))).toMatchObject({ folder: "frame_interpolation", url: slot("rife").get!.url });
    // the family's download, with where to get it
    expect(files.find((f) => f.file === download("videoVae"))).toMatchObject({ folder: "vae", url: slot("videoVae").get!.url });
  });

  it("add SAM 3 with the Mask on", async () => {
    const files = (await deployed(await swapRow({ maskOn: true, smooth: false }))).map((f) => f.file);
    expect(files).toContain(download("swapSam"));
    expect(files).toHaveLength(6);
  });

  it("leave out the reference model for an H3 video without references", async () => {
    const files = (await deployed(row("h3.video", { description: "a red ball rolls", seconds: 5 }))).map((f) => f.file);
    expect(files).toContain(download("unet"));
    expect(files).not.toContain(download("refUnet"));
  });

  it("never name one slot twice, whatever this PC has under another name", async () => {
    for (const r of [await swapRow(), await swapRow({ maskOn: true }), row("h3.video", { description: "a", seconds: 5 })]) {
      const vaes = (await deployed(r)).filter((f) => /video_vae/.test(f.file));
      expect(vaes).toEqual([expect.objectContaining({ file: download("videoVae") })]);
    }
  });

  it("are the SDXL job's own checkpoint and hires upscaler, not the family's", async () => {
    const r = row("sdxl.text-to-picture", { prompt: "a cat", checkpoint: CHECKPOINT, hires: true, hiresUpscaler: "RealESRGAN_x4plus_anime_6B.pth" });
    const recipe = t.services.registry.recipe(r.recipe_id)!;
    const loaded = await t.services.queue.loadedOnNew(r);
    expect(loaded).not.toBeNull();
    const files = filesUsed(recipe, JSON.parse(r.inputs), null, t.services.registry.family("sdxl")!.slots, loaded);
    expect(files.filter((f) => f.folder === "checkpoints").map((f) => f.file)).toEqual([CHECKPOINT]);
    expect(files).toContainEqual({ file: "RealESRGAN_x4plus_anime_6B.pth", folder: "upscale_models" });
  });

  it("fall back to the family's slots, and say so, for a job whose graph cannot be built", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // no source video: a swap cannot be built
    const r = row("h3.swap", { who: "the man", references: [], swapModel: FUSED });
    expect(await t.services.queue.loadedOnNew(r)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/its files are counted by its family's slots/));
    const files = filesUsed(t.services.registry.recipe("h3.swap")!, JSON.parse(r.inputs), null, h3.slots, null).map((f) => f.file);
    // the slot rule names each slot by its download too
    expect(files).toContain(download("videoVae"));
    expect(files).not.toContain("minimax_h3_video_vae_fp16.safetensors");
  });
});

describe("podSlotFiles, one name per slot", () => {
  const status = (id: string, file: string | null) => ({ id, label: id, folder: slot(id).folder, file, choices: [], auto: null, chosen: false, optional: Boolean(slot(id).optional), hint: "" });
  const swap = { needs: ["swapLora", "swapUnet"], needsWith: (i: Record<string, unknown>) => (i.maskOn ? ["swapSam"] : []) };

  it("takes the machine's own file, else the family's download, else this PC's", () => {
    const files = podSlotFiles(swap, {}, h3.slots, [status("videoVae", "pod_vae.safetensors")], [status("clip", "here_clip.safetensors")]);
    expect(files.videoVae).toBe("pod_vae.safetensors");
    expect(files.clip).toBe(download("clip"));
    expect(files.unet).toBe(download("unet"));
  });

  it("names a required slot nobody has so that a graph reading it says so, and brings an optional one only when asked", () => {
    const bare = [{ id: "own", folder: "diffusion_models" }, { id: "extra", folder: "loras", optional: true }];
    expect(podSlotFiles({}, {}, bare, null, null)).toEqual({ own: missingSlotFile("own") });
    expect(podSlotFiles({}, {}, bare, [status("unet", null), { ...status("unet", "x.safetensors"), id: "extra" }], null)).toEqual({ own: missingSlotFile("own"), extra: "x.safetensors" });
    expect(podSlotFiles(swap, { maskOn: true }, h3.slots, null, null).swapSam).toBe(download("swapSam"));
    expect(podSlotFiles(swap, {}, h3.slots, null, null).swapSam).toBeUndefined();
  });
});

describe("lackOn from what the job's graph loads", () => {
  const ready: RecipeStatus = { id: "h3.swap", ready: false, missingNodes: [], missingSlots: ["unet"], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [], options: {} };
  const pod = (over: Partial<RecipeStatus> = {}): Scan => ({ at: "now", comfy: { online: true, url: "x", nodes: 1 } as Scan["comfy"], families: [{ id: "h3", slots: h3.slots.map((s) => ({ ...s, file: null, choices: [], auto: null, chosen: false, optional: Boolean(s.optional), hint: "" })) }], recipes: [{ ...ready, ...over }] });
  const recipe = { id: "h3.swap", family: "h3", inputs: [] } as never;
  const machine = { families: {} };
  const file = (f: string, s?: string): GraphFile => ({ file: f, folder: s ? slot(s).folder : "loras", node: "1", classType: "X", input: "x", ...(s ? { slot: s } : {}) });

  it("keeps nothing off for a family file the graph does not read", () => {
    expect(lackOn(recipe, {}, pod(), { families: {} }, machine, () => "h3", { files: [file(FUSED, "swapUnet")], absent: [] })).toBeNull();
  });

  it("sends the graph's files the machine lacks, with the family's download address", () => {
    const lack = lackOn(recipe, {}, pod(), { families: {} }, machine, () => "h3", { files: [], absent: [file(download("videoVae"), "videoVae"), file(SWAP_LORA)] });
    expect(lack).toEqual({ off: false, sendable: true, files: [{ file: download("videoVae"), folder: "vae", url: slot("videoVae").get!.url }, { file: SWAP_LORA, folder: "loras" }] });
  });

  it("sends RIFE to a rented pod, and does not keep a job off a machine of the user's own for want of it", () => {
    const rife = { files: [], absent: [file(download("rife"), "rife")] };
    expect(lackOn(recipe, {}, pod(), { families: {} }, { ...machine, rented: { provider: "runpod" } as never }, () => "h3", rife)).toMatchObject({ sendable: true, files: [{ file: download("rife"), url: slot("rife").get!.url }] });
    expect(lackOn(recipe, {}, pod(), { families: {} }, machine, () => "h3", rife)).toBeNull();
  });

  it("does not keep a latent-upscale job off a machine of the user's own for want of H3's latent upscaler (it resizes plainly, and says so)", () => {
    const up = { files: [], absent: [file(download("latentUpscaler"), "latentUpscaler")] };
    expect(lackOn(recipe, {}, pod(), { families: {} }, machine, () => "h3", up)).toBeNull();
    expect(lackOn(recipe, {}, pod(), { families: {} }, { ...machine, rented: { provider: "runpod" } as never }, () => "h3", up)).toMatchObject({ sendable: true });
  });

  it("cannot send a family file the graph reads and nobody has", () => {
    const lack = lackOn(recipe, {}, pod(), { families: {} }, machine, () => "h3", { files: [], absent: [file(missingSlotFile("unet"), "unet")] });
    expect(lack).toMatchObject({ sendable: false, files: [], why: "its Video model file is not there, and no download is known for it" });
  });
});

describe("offeredOn, whether a machine has a file where the graph names it", () => {
  const f = (over: Partial<GraphFile> = {}): GraphFile => ({ file: "a.safetensors", folder: "loras", node: "1", classType: "LoraLoaderModelOnly", input: "lora_name", ...over });
  const catalog = { LoraLoaderModelOnly: { input: { required: { lora_name: [["sub/a.safetensors", "b.safetensors"]] } }, output: ["MODEL"] } } as never;

  it("reads the node's list, a file in a sub-folder counting as there", () => {
    expect(offeredOn(catalog, f(), null)).toBe(true);
    expect(offeredOn(catalog, f({ file: "c.safetensors" }), null)).toBe(false);
  });

  it("asks the machine's scan for a family file where the node lists nothing", () => {
    const there = [{ id: "veda", label: "", folder: "veda", file: "v.safetensors", choices: [], auto: null, chosen: false, optional: true, hint: "" }];
    expect(offeredOn({}, f({ file: "v.safetensors", slot: "veda", classType: "VedaSparseAttention", input: "predictor" }), there)).toBe(true);
    expect(offeredOn({}, f({ file: "w.safetensors", slot: "veda", classType: "VedaSparseAttention", input: "predictor" }), there)).toBe(false);
  });
});

describe("graphFiles", () => {
  it("reads every loader's file, and the family files a build was handed whatever its node, each once", () => {
    const graph = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
      "2": { class_type: "LoraLoader", inputs: { lora_name: "l.safetensors", strength_model: 1 } },
      "3": { class_type: "VedaSparseAttention", inputs: { predictor: "v.safetensors", verbose: false } },
      "4": { class_type: "LoraLoader", inputs: { lora_name: "l.safetensors" } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: "a photo.safetensors of nothing" } },
    };
    expect(graphFiles(graph, { veda: "v.safetensors" }, { veda: "veda" })).toEqual([
      { file: "m.safetensors", folder: "checkpoints", node: "1", classType: "CheckpointLoaderSimple", input: "ckpt_name" },
      { file: "l.safetensors", folder: "loras", node: "2", classType: "LoraLoader", input: "lora_name" },
      { file: "v.safetensors", folder: "veda", node: "3", classType: "VedaSparseAttention", input: "predictor", slot: "veda" },
    ]);
  });
});

describe("a family file a machine does not have", () => {
  it("is read by an H3 video's graph and never by a swap's", async () => {
    const slots = { ...Object.fromEntries(h3.slots.filter((s) => s.get).map((s) => [s.id, s.get!.file])), unet: missingSlotFile("unet") };
    const swap = (await t.services.queue.builtOf("h3.swap", { who: "the man", source: { asset: await video() }, references: [], swapModel: FUSED }, { slots }))!;
    const plain = (await t.services.queue.builtOf("h3.video", { description: "a red ball rolls", seconds: 5 }, { slots }))!;
    expect(missingSlotIn(swap.graph)).toBeNull();
    expect(missingSlotIn(plain.graph)).toBe("unet");
  });

  it("is refused, in its words, by a graph built with this ComfyUI's own files (a forecast, Open in ComfyUI): never named by its placeholder", async () => {
    await t.close();
    await fake.close();
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { ...HERE, diffusion_models: [FUSED] } });
    t = await makeApp({ comfyUrl: fake.url });
    await expect(t.services.queue.builtOf("h3.video", { description: "a red ball rolls", seconds: 5 })).rejects.toThrow(`needs was not found. ${slot("unet").hint}`);
  });

  it("refuses a job whose graph reads it, in its words, before anything is sent", async () => {
    await t.close();
    await fake.close();
    fake = await startFakeComfy({ catalog: referenceCatalog(), models: { ...HERE, diffusion_models: [FUSED] } });
    t = await makeApp({ comfyUrl: fake.url });
    await t.services.queue.start();
    const id = (await post(t.app, "/api/jobs", { recipe: "h3.video", input: { description: "a red ball rolls", seconds: 5 } })).json().ids[0] as string;
    await until(async () => (await t.db.selectFrom("jobs").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status === "failed");
    const { error } = await t.db.selectFrom("jobs").select("error").where("id", "=", id).executeTakeFirstOrThrow();
    expect(error).toContain(`needs was not found. ${slot("unet").hint}`);
    expect([...fake.prompts.keys()]).toEqual([]);
  });
});

describe("an optional file a job's settings use (H3's latent upscaler, 2026-10-18)", () => {
  const finish = (upscaleWith: string) => ({ ...row("h3.video", { description: "a red ball rolls", seconds: 5, upscale: "Latent: re-sampled", upscaleWith }), finished_from: "zz-test-take" });

  it("is sent for a finish that enlarges with it, never for one with a plain resize", async () => {
    expect((await deployed(finish("H3's latent upscaler"))).map((f) => f.file)).toContain(download("latentUpscaler"));
    expect((await deployed(finish("Plain resize"))).map((f) => f.file)).not.toContain(download("latentUpscaler"));
    expect((await deployed(row("h3.video", { description: "a", seconds: 5 }))).map((f) => f.file)).not.toContain(download("latentUpscaler"));
  });

  it("is sent for a swap's finish too, which has its own rules but is built as a clip", async () => {
    const swapFinish = async (upscaleWith: string) => ({ ...(await swapRow({ upscale: "Latent: re-sampled", upscaleWith })), finished_from: "zz-test-take" });
    expect((await deployed(await swapFinish("H3's latent upscaler"))).map((f) => f.file)).toContain(download("latentUpscaler"));
    expect((await deployed(await swapFinish("Plain resize"))).map((f) => f.file)).not.toContain(download("latentUpscaler"));
    expect((await deployed(await swapRow())).map((f) => f.file)).not.toContain(download("latentUpscaler"));
  });

  it("says so on the job when a render falls back to a plain resize without it", () => {
    const input = parseInput(h3Video, { description: "a", seconds: 5, upscale: "Latent: re-sampled", smooth: false });
    const slots = Object.fromEntries(h3.slots.filter((s) => !s.optional).map((s) => [s.id, s.get!.file]));
    expect(h3Video.build(input, dryContext({ slots, uploads: { "self.latent": "l.latent" } })).warnings).toEqual([expect.stringMatching(/^Enlarged by a plain resize: H3's latent upscaler is not on this ComfyUI/)]);
    expect(h3Video.build(input, dryContext({ slots: { ...slots, latentUpscaler: download("latentUpscaler") }, uploads: { "self.latent": "l.latent" } })).warnings ?? []).toEqual([]);
  });
});
