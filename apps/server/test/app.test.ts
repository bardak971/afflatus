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
    expect(res.json()).toEqual({ comfyUrl: "http://10.0.0.5:8188", llm: { baseUrl: "http://llm/v1", model: "m", hasApiKey: true, vision: false }, hasCivitaiKey: true, civitaiLookups: false, downloadModels: false });
    expect(res.body).not.toContain("secret");
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
