import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { missingSlotFile, type GraphFile } from "@afflatus/core";
import { newId, now, OWNER } from "../src/db";
import { waitingFiles } from "../src/deployModels";
import { loadedOn } from "../src/jobFiles";
import { toolLackOn, toolSlots } from "../src/machineScans";
import { FACE_REFINE_NODES, RIFE_GET, families } from "@afflatus/recipes";
import { CUT_JOB } from "../src/timelineModel";
import { toolNeeds } from "../src/queueTools";
import type { QueueCore } from "../src/queueModel";
import { CHECKPOINT, makeApp, referenceCatalog, type TestApp } from "./helpers";

/**
 * A finish or a RIFE slow-motion gets its model files on a pod, only when it loads them: Timeline 19's finish failed on a
 * pod with "no RIFE model left" (2026-10-18), as a finish is no recipe and nobody asked for its files.
 */

const SEEDVR = "seedvr2_3b_int8_convrot.safetensors";
const SEEDVR_VAE = "seedvr2_ema_vae_fp16.safetensors";
const HERE = { checkpoints: [CHECKPOINT], upscale_models: ["4x-UltraSharp.pth"], frame_interpolation: ["rife49.pth"], vae: [], diffusion_models: [] };

let fake: FakeComfy;
let t: TestApp;
const dirs: string[] = [];
beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: HERE });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A short clip at a frame rate, made by ffmpeg. */
function clip(fps: number): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "afflatus-tool-files-"));
  dirs.push(dir);
  const file = join(dir, "c.mp4");
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=128x96:rate=${fps}:duration=1`, "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  if (made.status !== 0) throw new Error(String(made.stderr));
  return readFileSync(file);
}

/** A take in the library at 24 fps; `interpolated`: its render's own frames kept beside it at 12 fps. */
async function take(interpolated: boolean): Promise<string> {
  const id = newId();
  const at = now();
  await t.services.storage.put(`assets/${id}`, clip(24));
  if (interpolated) await t.services.storage.put(`raw/${id}`, clip(12));
  await t.db.insertInto("assets").values({
    id, owner_id: OWNER, kind: "video", origin: "generated", name: "zz-test take", file_key: `assets/${id}`, thumb_key: null, mime: "video/mp4", bytes: 4,
    width: 128, height: 96, duration_ms: 1000, fps: 24, has_sound: 0, folder_id: null, generation_id: null, kept_at: at, deleted_at: null, created_at: at,
    ...(interpolated ? { raw_key: `raw/${id}` } : {}),
  } as never).execute();
  return id;
}

const cut = (opts: Record<string, unknown>) => ({ id: `zz-test-${newId()}`, recipe_id: CUT_JOB, inputs: JSON.stringify({ startMs: 0, endMs: 1000, ...opts }), finished_from: null, clip_id: null, clip_fit: 0, clip_mirror: null });
const listed = async (opts: Record<string, unknown>) => (await waitingFiles(t.services, { ...cut(opts), priority: 0 } as never, null)).map((f) => f.file).sort();

describe("the files a pod is sent for a finish", () => {
  it("are SeedVR2's two, with their downloads, for its SeedVR2 route (the route a finish takes by default)", async () => {
    const asset = await take(false);
    expect(await listed({ asset, action: "finish", route: "seedvr" })).toEqual([SEEDVR, SEEDVR_VAE].sort());
    expect(await listed({ asset, action: "finish" })).toEqual([SEEDVR, SEEDVR_VAE].sort());
    const files = await waitingFiles(t.services, cut({ asset, action: "finish" }) as never, null);
    expect(files.find((f) => f.file === SEEDVR)?.url).toMatch(/^https:\/\/huggingface\.co\/.*seedvr2_3b_int8_convrot\.safetensors$/);
  });

  it("are the upscale model picked, or this PC's first when none is, for the model route; nothing for RTX VSR", async () => {
    const asset = await take(false);
    expect(await listed({ asset, action: "finish", route: "model", upscaleModel: "2xNomosUni.pth" })).toEqual(["2xNomosUni.pth"]);
    expect(await listed({ asset, action: "finish", route: "model" })).toEqual(["4x-UltraSharp.pth"]);
    expect(await listed({ asset, action: "finish", route: "rtx" })).toEqual([]);
  });

  it("add RIFE (its download, which a pod fetches itself) only for a take that was interpolated", async () => {
    expect(await listed({ asset: await take(true), action: "finish", route: "rtx" })).toEqual([RIFE_GET.file]);
    expect(await listed({ asset: await take(false), action: "finish", route: "rtx" })).toEqual([]);
  });

  it("are RIFE for a RIFE slow-motion, nothing for an ffmpeg one or a plain cut", async () => {
    const asset = await take(false);
    expect(await listed({ asset, action: "slow", engine: "rife", factor: 2 })).toEqual([RIFE_GET.file]);
    expect(await listed({ asset, action: "slow", engine: "ffmpeg", factor: 2 })).toEqual([]);
    expect(await listed({ asset, action: "copy" })).toEqual([]);
  });
});

describe("an interpolated take's raw frames", () => {
  it("are read again after a read that failed: a failure is not kept", async () => {
    const asset = await take(false);
    // its raw file named, but not there yet: read as not interpolated
    await t.db.updateTable("assets").set({ raw_key: `raw/${asset}` } as never).where("id", "=", asset).execute();
    const row = { recipe_id: CUT_JOB, inputs: JSON.stringify({ asset, action: "finish", route: "rtx", startMs: 0, endMs: 1000 }) };
    expect((await toolNeeds(t.services as never, row))?.rife).toBe(false);
    await t.services.storage.put(`raw/${asset}`, clip(12));
    expect((await toolNeeds(t.services as never, row))?.rife).toBe(true);
  });
});

describe("a finish on a machine", () => {
  it("lacks there only what it loads and the machine does not list", async () => {
    const on = { id: "pod", comfy: await t.services.comfy(), scan: await (await t.services.comfy()).scan() };
    // the machine has RIFE and an upscale model, not SeedVR2
    const core = (t.services.queue as unknown as { core: QueueCore }).core;
    expect((await loadedOn(core, cut({ asset: await take(true), action: "finish", route: "model" }), on))?.absent).toEqual([]);
    const seedvr = await loadedOn(core, cut({ asset: await take(true), action: "finish", route: "seedvr" }), on);
    expect(seedvr?.absent.map((f) => f.file).sort()).toEqual([SEEDVR, SEEDVR_VAE].sort());
    // a machine without RIFE: it is sent RIFE's download, whether this PC has a copy or not
    fake.models.frame_interpolation = [];
    const none = { ...on, scan: { ...on.scan, at: "later" } };
    const lack = toolLackOn((await loadedOn(core, cut({ asset: await take(true), action: "finish", route: "rtx" }), none))!, []);
    expect(lack).toMatchObject({ sendable: true, files: [{ file: RIFE_GET.file, folder: "frame_interpolation" }] });
  });
});

describe("a finish's nodes on a machine", () => {
  it("asks DaSiWa's pack for RTX VSR where neither driver is there, nothing where one is", async () => {
    const core = (t.services.queue as unknown as { core: QueueCore }).core;
    const comfy = await t.services.comfy();
    const on = { id: "pod", comfy, scan: await comfy.scan() };
    const catalog = await comfy.catalog();
    const rtx = cut({ asset: await take(false), action: "finish", route: "rtx" });
    const had = "DaSiWa_RTX_UpscalerRefiner" in catalog || "RTXVideoSuperResolution" in catalog;
    expect((await loadedOn(core, rtx, on))?.missingNodes).toEqual(had ? undefined : ["DaSiWa_RTX_UpscalerRefiner"]);
    // a machine with neither: the pack is asked, and the finish can be sent it
    const without = Object.fromEntries(Object.entries(catalog).filter(([k]) => k !== "DaSiWa_RTX_UpscalerRefiner" && k !== "RTXVideoSuperResolution"));
    fake.catalog = without as never;
    comfy.forgetAll();
    const lack = toolLackOn((await loadedOn(core, rtx, { ...on, scan: { ...on.scan, at: "later" } }))!, []);
    expect(lack).toEqual({ off: false, files: [], sendable: true, packs: ["ComfyUI-DaSiWa-Nodes"] });
  });
});

describe("toolLackOn", () => {
  const f = (file: string, folder: string, slot?: string): GraphFile => ({ file, folder, node: "", classType: "X", input: "x", ...(slot ? { slot } : {}) });
  const slots = [{ id: "seedvr", get: { file: SEEDVR, url: "https://huggingface.co/x/seedvr" } }];

  it("is nothing when the machine has every file, and the files to send otherwise", () => {
    expect(toolLackOn({ files: [], absent: [] }, slots)).toBeNull();
    expect(toolLackOn({ files: [], absent: [f(SEEDVR, "diffusion_models", "seedvr"), f("rife49.pth", "frame_interpolation", "rife")] }, slots)).toEqual({
      off: false, sendable: true, files: [{ file: SEEDVR, folder: "diffusion_models", url: "https://huggingface.co/x/seedvr" }, { file: "rife49.pth", folder: "frame_interpolation" }],
    });
  });

  it("sends the packs of the nodes it lacks, and cannot be sent one of no pack Afflatus knows", () => {
    expect(toolLackOn({ files: [], absent: [], missingNodes: ["VHS_VideoCombine"] }, slots)).toEqual({ off: false, files: [], sendable: true, packs: ["comfyui-videohelpersuite"] });
    expect(toolLackOn({ files: [], absent: [], missingNodes: ["SomeoneElsesNode"] }, slots)).toEqual({
      off: false, files: [], sendable: false, why: "its ComfyUI lacks SomeoneElsesNode, of no node pack Afflatus can install",
    });
  });

  it("cannot send a file nobody has, and says which", () => {
    expect(toolLackOn({ files: [], absent: [f(missingSlotFile("rife"), "frame_interpolation", "rife")] }, slots)).toEqual({
      off: false, sendable: false, files: [], why: "no RIFE model to send it: none in this PC's models/frame_interpolation either",
    });
  });
});

describe("Finish › Face refine of a take that keeps no latent (SCAIL-2 at 24 fps)", () => {
  const face = (asset: string) => cut({ asset, action: "finish", route: "face", family: "scail", picture: "zz-test-picture" });
  const get = (id: string) => families.find((f) => f.id === "scail")!.slots.find((x) => x.id === id)!.get!;
  const core = () => (t.services.queue as unknown as { core: QueueCore }).core;

  it("sends a pod Face refine's files, H3's text encoder and VAEs among them, with their downloads: none of SeedVR2's", async () => {
    const files = await waitingFiles(t.services, face(await take(false)) as never, null);
    for (const id of ["faceRefineUnet", "faceDetector", "faceSeg", "faceClip", "faceVideoVae", "faceAudioVae"]) {
      expect(files, id).toContainEqual(expect.objectContaining({ file: get(id).file, url: get(id).url }));
    }
    expect(files.map((f) => f.file)).not.toContain(SEEDVR);
  });

  // card #192: the model picked in Finish is the one loaded, so the one sent; the fused turbo is not asked for beside it
  it("sends the Face refine model picked in place of the fused turbo's slot", async () => {
    const picked = "minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    const asset = await take(false);
    const files = await waitingFiles(t.services, cut({ asset, action: "finish", route: "face", family: "scail", picture: "zz-test-picture", faceModel: picked }) as never, null);
    expect(files.map((f) => f.file)).toContain(picked);
    expect(files.map((f) => f.file)).not.toContain(get("faceRefineUnet").file);
  });

  it("asks for Face refine's pack where it lacks, never SeedVR2's nodes; a machine of the user's own does without the person detector and SAM", async () => {
    const comfy = await t.services.comfy();
    const catalog = await comfy.catalog();
    fake.catalog = Object.fromEntries(Object.entries(catalog).filter(([k]) => !FACE_REFINE_NODES.includes(k) && !k.startsWith("SeedVR2"))) as never;
    comfy.forgetAll();
    const on = { id: "m1", comfy, scan: await comfy.scan() };
    const loaded = (await loadedOn(core(), face(await take(false)), on))!;
    expect(loaded.missingNodes).toEqual(FACE_REFINE_NODES);
    const own = toolLackOn(loaded, toolSlots(t.services.registry), { rented: undefined });
    expect(own).toMatchObject({ packs: ["comfyui-h3-facerefine"], sendable: true });
    expect(own!.files.map((f) => f.file)).toContain(get("faceRefineUnet").file);
    expect(own!.files.map((f) => f.file)).not.toContain(get("faceSeg").file);
    const pod = toolLackOn(loaded, toolSlots(t.services.registry), { rented: { provider: "runpod" } as never });
    expect(pod!.files.map((f) => f.file)).toContain(get("faceSeg").file);
  });
});
