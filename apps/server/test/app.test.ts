import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db";
import { CHECKPOINT, get, makeApp, makeFake, NOWHERE, type TestApp } from "./helpers";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(() => t.close());

describe("config", () => {
  it("listens on localhost and uses SQLite when nothing is set", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.databaseUrl).toBe("");
  });
});

describe("migrations", () => {
  it("are applied once", async () => {
    expect(await migrate(t.db)).toEqual([]);
  });
});

describe("GET /api/health", () => {
  it("answers", async () => {
    const res = await get(t.app, "/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, database: "sqlite" });
  });
});

describe("GET /api/recipes", () => {
  it("lists families and recipes with their forms, without functions", async () => {
    const body = (await get(t.app, "/api/recipes")).json();
    expect(body.families.map((f: { id: string }) => f.id)).toContain("sdxl");
    const recipe = body.recipes.find((r: { id: string }) => r.id === "sdxl.text-to-picture");
    expect(recipe.inputs.map((i: { id: string }) => i.id)).toContain("hiresUpscaler");
    expect(recipe.build).toBeUndefined();
  });
});

describe("GET /api/setup", () => {
  it("says so when ComfyUI is not there", async () => {
    const body = (await get(t.app, "/api/setup")).json();
    expect(body.comfy).toMatchObject({ online: false, url: NOWHERE });
  });

  it("reports what the configured ComfyUI can do, reading only", async () => {
    const fake = await makeFake();
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } });
      const body = (await get(t.app, "/api/setup")).json();
      expect(body.comfy).toMatchObject({ online: true, device: "fake gpu" });
      const recipe = body.recipes.find((r: { id: string }) => r.id === "sdxl.text-to-picture");
      expect(recipe).toMatchObject({ ready: true, missingNodes: [], limitedBy: [] });
      expect(recipe.options.checkpoint).toEqual([CHECKPOINT, "other.safetensors"]);
      expect(recipe.options.sampler).toContain("euler_ancestral");
      expect(recipe.options.hiresUpscaler[0]).toBe("latent");
      expect(fake.calls.every((c) => c.startsWith("GET "))).toBe(true);

      // the answer is kept: a second call does not fetch the node catalog again
      const before = fake.calls.length;
      await get(t.app, "/api/setup");
      expect(fake.calls.length).toBe(before);
      await get(t.app, "/api/setup?fresh=1");
      expect(fake.calls.length).toBeGreaterThan(before);
    } finally {
      await t.close();
      await fake.close();
      t = await makeApp();
    }
  });
});

describe("GET /api/system", () => {
  it("is null when ComfyUI is not there", async () => {
    expect((await get(t.app, "/api/system")).json()).toEqual({ load: null });
  });

  it("falls back to ComfyUI's memory numbers when no monitor extension is heard", async () => {
    const fake = await makeFake();
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } });
      const { load } = (await get(t.app, "/api/system")).json();
      expect(load).toMatchObject({ source: "comfyui", gpus: [{ name: "fake gpu" }] });
    } finally {
      await t.close();
      await fake.close();
      t = await makeApp();
    }
  });
});

describe("settings", () => {
  const put = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/settings", payload: payload as object });

  it("are saved, and secrets never come back", async () => {
    expect((await put({ comfyUrl: "http://10.0.0.5:8188", llm: { baseUrl: "http://llm/v1", model: "m", apiKey: "secret" }, civitaiKey: "k" })).statusCode).toBe(200);
    const res = await get(t.app, "/api/settings");
    expect(res.json()).toEqual({
      comfyUrl: "http://10.0.0.5:8188", comfyDir: "", llm: { baseUrl: "http://llm/v1", model: "m", hasApiKey: true, vision: false },
      llms: [{ id: "main", name: "", baseUrl: "http://llm/v1", model: "m", hasApiKey: true, vision: false, contextSize: 16384, maxOutputTokens: 3000 }],
      unloadAfterMinutes: 0, designerLlm: "main", designerInstructions: [], designerInstruction: "", designerGuides: {},
      tagCheck: true, families: {}, hasCivitaiKey: true, civitaiLookups: false, updateChecks: false, downloadModels: false, renderHistoryDays: 90,
      finish: { route: "seedvr", factor: 2, colour: "lab", upscaleModel: "", latentDenoise: 0.25, latentSteps: 2 }, slotFiles: {}, acceptedPresets: [],
    });
    expect(res.body).not.toContain("secret");
    // a family's file chosen by hand where several fit: kept by family and slot; a slot taken back follows its patterns again
    expect((await put({ slotFiles: { h3: { seedvr: "seedvr2_7b_int8_convrot.safetensors" } } })).json().slotFiles).toEqual({ h3: { seedvr: "seedvr2_7b_int8_convrot.safetensors" } });
    expect((await put({ slotFiles: {} })).json().slotFiles).toEqual({});
    // model families switched on or off by hand are kept by id; one not named follows its files
    expect((await put({ families: { ltx: true, wan: false } })).json().families).toEqual({ ltx: true, wan: false });
    expect((await put({ families: { ltx: true } })).json().families).toEqual({ ltx: true });
    expect((await put({ families: { ltx: "yes" } })).statusCode).toBe(400);
  });

  it("keep what a partial update does not mention", async () => {
    await put({ civitaiKey: "k" });
    await put({ comfyUrl: "http://10.0.0.5:8188" });
    expect((await get(t.app, "/api/settings")).json()).toMatchObject({ comfyUrl: "http://10.0.0.5:8188", hasCivitaiKey: true });
  });

  it("reject a setting that does not exist", async () => {
    const res = await put({ nope: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("nope");
  });

  it("reject a bad address with a 400 that says what is wrong", async () => {
    const res = await put({ comfyUrl: "not a url" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("comfyUrl");
  });
});

describe("the model of a recipe that has a usual one", () => {
  it("is offered with the usual file first, then the others made for it, then the rest of the folder", async () => {
    const { startFakeComfy } = await import("@afflatus/comfy/testing");
    const { referenceCatalog } = await import("./helpers");
    const fake = await startFakeComfy({
      catalog: referenceCatalog(),
      models: {
        checkpoints: [CHECKPOINT], loras: [], upscale_models: [],
        // the reference model is there too: it is used by itself for clips with references, and is not a choice here
        diffusion_models: ["A_wan_model.safetensors", "SomeoneMinimaxH3_hybridTurboV3.safetensors", "minimax_h3_fl2va.safetensors", "minimax_h3_ref2va.safetensors", "zz_other.safetensors"],
        text_encoders: ["qwen3vl_32b_minimax_h3.safetensors"], vae: ["minimax_h3_video_vae.safetensors", "minimax_h3_audio_vae.safetensors"],
      },
    });
    const own = await makeApp({ comfyUrl: fake.url });
    try {
      const setup = (await get(own.app, "/api/setup")).json();
      const h3 = setup.recipes.find((r: { id: string }) => r.id === "h3.video");
      expect(h3.ready).toBe(true);
      expect(h3.options.model).toEqual(["minimax_h3_fl2va.safetensors", "SomeoneMinimaxH3_hybridTurboV3.safetensors", "A_wan_model.safetensors", "zz_other.safetensors"]);
    } finally {
      await own.close();
      await fake.close().catch(() => {});
    }
  });
});

describe("MiniMax H3 with a hybrid fine-tune and none of MiniMax's own model files", () => {
  it("is ready: the one file is the usual model and the reference model", async () => {
    const { startFakeComfy } = await import("@afflatus/comfy/testing");
    const { referenceCatalog } = await import("./helpers");
    const fake = await startFakeComfy({
      catalog: referenceCatalog(),
      models: {
        checkpoints: [CHECKPOINT], loras: [], upscale_models: [],
        diffusion_models: ["SomeoneMinimaxH3_hybridTurboV3.safetensors", "SomeoneMinimaxH3_hybridV3.safetensors", "zz_other.safetensors"],
        text_encoders: ["qwen3vl_32b_minimax_h3.safetensors"], vae: ["minimax_h3_video_vae.safetensors", "minimax_h3_audio_vae.safetensors"],
      },
    });
    const own = await makeApp({ comfyUrl: fake.url });
    try {
      const setup = (await get(own.app, "/api/setup")).json();
      const slots = Object.fromEntries(setup.families.find((f: { id: string }) => f.id === "h3").slots.map((s: { id: string; file: string | null }) => [s.id, s.file]));
      // the full-step one before the turbo one
      expect(slots).toMatchObject({ unet: "SomeoneMinimaxH3_hybridV3.safetensors", refUnet: "SomeoneMinimaxH3_hybridV3.safetensors" });
      const h3 = setup.recipes.find((r: { id: string }) => r.id === "h3.video");
      expect(h3).toMatchObject({ ready: true, missingSlots: [], problems: [] });
      expect(h3.options.model).toEqual(["SomeoneMinimaxH3_hybridV3.safetensors", "SomeoneMinimaxH3_hybridTurboV3.safetensors", "zz_other.safetensors"]);
    } finally {
      await own.close();
      await fake.close().catch(() => {});
    }
  });
});
