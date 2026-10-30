import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db";
import { allowedHosts, hostAllowed } from "../src/hostCheck";
import { unlistOptions } from "@afflatus/core";
import { CHECKPOINT, get, makeApp, makeFake, NOWHERE, png, post, type TestApp } from "./helpers";

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

  it("says whether the page is on this computer, where Get ffmpeg is not refused", async () => {
    expect((await get(t.app, "/api/health")).json().here).toBe(true);
    const lan = await t.app.inject({ method: "GET", url: "/api/health", remoteAddress: "192.168.1.20" });
    expect(lan.json().here).toBe(false);
    expect((await t.app.inject({ method: "POST", url: "/api/ffmpeg/get", remoteAddress: "192.168.1.20" })).json().error).toMatch(/on the computer Afflatus runs on/);
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
    const body = unlistOptions((await get(t.app, "/api/setup")).json());
    expect(body.comfy).toMatchObject({ online: false, url: NOWHERE });
  });

  it("reports what the configured ComfyUI can do, reading only", async () => {
    const fake = await makeFake(["LyingSigmaSampler", "DetailDaemonSamplerNode"]);
    try {
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { comfyUrl: fake.url } });
      const body = unlistOptions((await get(t.app, "/api/setup")).json());
      expect(body.comfy).toMatchObject({ online: true, device: "fake gpu" });
      const recipe = body.recipes.find((r: { id: string }) => r.id === "sdxl.text-to-picture");
      // Detail Daemon is not in the fake ComfyUI: the detail boost takes the built-in way, and Settings says so
      expect(recipe).toMatchObject({ ready: true, missingNodes: [], limitedBy: ["LyingSigmaSampler"] });
      expect(recipe.options.checkpoint).toEqual([CHECKPOINT, "other.safetensors"]);
      expect(recipe.options.sampler).toContain("euler_ancestral");
      expect(recipe.options.hiresUpscaler[0]).toBe("latent");
      expect(fake.calls.every((c) => c.startsWith("GET "))).toBe(true);

      // the answer is kept: a second call does not fetch the node catalog again
      const before = fake.calls.length;
      await get(t.app, "/api/setup");
      expect(fake.calls.length).toBe(before);
      await post(t.app, "/api/setup/rescan");
      expect(fake.calls.length).toBeGreaterThan(before);
    } finally {
      await t.close();
      await fake.close();
      t = await makeApp();
    }
  });
});

describe("the Host header", () => {
  it("is answered for the server's own names and refused for any other: a page elsewhere cannot point its name at this machine", async () => {
    expect((await get(t.app, "/api/health", { host: "localhost:8720" })).statusCode).toBe(200);
    expect((await get(t.app, "/api/health", { host: "127.0.0.1" })).statusCode).toBe(200);
    expect((await get(t.app, "/api/health", { host: "[::1]:8720" })).statusCode).toBe(200);
    const foreign = await get(t.app, "/api/settings", { host: "evil.example.com:8720" });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error).toContain("evil.example.com");
  });

  it("allows the bound address, PUBLIC_URL's host and ALLOWED_HOSTS, never a wildcard bind", () => {
    const allowed = allowedHosts({ HOST: "0.0.0.0", PUBLIC_URL: "http://studio.lan:8720/", ALLOWED_HOSTS: "pc.home, 192.168.1.20:8720" });
    expect(hostAllowed("studio.lan:8720", allowed)).toBe(true);
    expect(hostAllowed("pc.home", allowed)).toBe(true);
    expect(hostAllowed("192.168.1.20", allowed)).toBe(true);
    expect(hostAllowed("0.0.0.0:8720", allowed)).toBe(false);
    expect(hostAllowed("other.lan", allowed)).toBe(false);
    expect(hostAllowed(undefined, allowed)).toBe(true);
    expect(hostAllowed("192.168.1.30:8720", allowedHosts({ HOST: "192.168.1.30" }))).toBe(true);
  });
});

describe("a request from another site's page", () => {
  const send = (method: "GET" | "POST", headers: Record<string, string>) => t.app.inject({ method, url: method === "GET" ? "/api/health" : "/api/health/check", headers });

  it("is refused when the browser says it is cross-site or same-site", async () => {
    expect((await send("POST", { "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await send("POST", { "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await send("POST", { "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
  });

  it("is refused when its Origin is not one of the server's names", async () => {
    expect((await send("POST", { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await send("POST", { origin: "null" })).statusCode).toBe(403);
    expect((await send("POST", { origin: "http://localhost:8720" })).statusCode).toBe(200);
  });

  it("passes with neither header (curl, a script); a read is refused only as safety.test.ts says", async () => {
    expect((await send("POST", {})).statusCode).toBe(200);
    expect((await send("GET", { origin: "https://evil.example" })).statusCode).toBe(200);
    expect((await send("GET", { origin: "https://evil.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" })).statusCode).toBe(200);
  });
});

describe("a change that is not JSON, a file, or marked", () => {
  // the helpers' inject adds "x-afflatus: 1": undefined takes it off, as a plain form's request would be
  const send = (headers: Record<string, string | undefined>, payload?: string) => t.app.inject({ method: "POST", url: "/api/health/check", headers: { "x-afflatus": undefined, ...headers }, payload });

  it("is refused without a body: a page elsewhere sends one without asking the browser first", async () => {
    const res = await send({});
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("X-Afflatus");
  });

  it("is refused as text/plain or a form, the bodies a page elsewhere can send", async () => {
    expect((await send({ "content-type": "text/plain" }, "{}")).statusCode).toBe(403);
    expect((await send({ "content-type": "application/x-www-form-urlencoded" }, "a=1")).statusCode).toBe(403);
  });

  it("passes with the header, as JSON, or as a file; reading needs neither", async () => {
    expect((await send({ "x-afflatus": "1" })).statusCode).toBe(200);
    expect((await send({ "content-type": "application/json; charset=utf-8" }, "{}")).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/api/health", headers: { "x-afflatus": undefined } })).statusCode).toBe(200);
    // a file is taken (and judged by the route), not refused here
    expect((await t.app.inject({ method: "POST", url: "/api/embedded", headers: { "x-afflatus": undefined, "content-type": "image/png" }, payload: Buffer.from(png(8, 8)) })).statusCode).not.toBe(403);
  });
});

describe("a scraper or a probe", () => {
  it("is answered on /metrics and /api/health whatever name it uses, and nowhere else", async () => {
    expect((await get(t.app, "/api/health", { host: "10.1.2.3:8720" })).statusCode).toBe(200);
    expect((await get(t.app, "/metrics", { host: "10.1.2.3:8720" })).statusCode).toBe(200);
    expect((await get(t.app, "/api/settings", { host: "10.1.2.3:8720" })).statusCode).toBe(403);
    expect((await t.app.inject({ method: "POST", url: "/api/health/check", headers: { host: "10.1.2.3:8720" } })).statusCode).toBe(403);
  });
});

describe("a JSON body shaped like an upload", () => {
  it("names no file to read and no folder to remove", async () => {
    const dir = await mkdtemp(join(tmpdir(), "afflatus-not-upload-"));
    try {
      await writeFile(join(dir, "secret.txt"), "keep me");
      const res = await post(t.app, "/api/embedded", { path: join(dir, "secret.txt"), dir });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("send the file itself");
      await t.app.inject({ method: "PUT", url: "/api/settings", payload: { path: join(dir, "secret.txt"), dir } });
      expect(await readFile(join(dir, "secret.txt"), "utf8")).toBe("keep me");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /api/health/check", () => {
  it("runs the start-up checks again and says when", async () => {
    const res = await post(t.app, "/api/health/check");
    expect(res.statusCode).toBe(200);
    expect(res.json().checkedAt).toBeTruthy();
    expect(res.json().checks.length).toBeGreaterThan(0);
  });
});

describe("settings", () => {
  const put = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/settings", payload: payload as object });

  it("are saved, and secrets never come back", async () => {
    expect((await put({ comfyUrl: "http://10.0.0.5:8188", llm: { baseUrl: "http://llm/v1", model: "m", apiKey: "secret" }, civitaiKey: "k" })).statusCode).toBe(200);
    const res = await get(t.app, "/api/settings");
    expect(res.json()).toEqual({
      machines: [{ id: "m1", name: "", url: "http://10.0.0.5:8188", dir: "", takes: "all", packs: "ask", families: {}, tokenEnd: "", local: false }], machinesSetAside: [],
      comfyUrl: "http://10.0.0.5:8188", comfyDir: "", llm: { baseUrl: "http://llm/v1", model: "m", hasApiKey: true, vision: false },
      llms: [{ id: "main", name: "", baseUrl: "http://llm/v1", model: "m", hasApiKey: true, vision: false, contextSize: 16384, maxOutputTokens: 3000, noThinking: false }],
      unloadAfterMinutes: 0, designerLlm: "main", designerInstructions: [], designerInstruction: "", designerGuides: {},
      tagCheck: true, families: {}, allFamilies: false, firstLaunch: "done", hasCivitaiKey: true, hasHuggingFaceToken: false, hasRunpodKey: false, runpodS3User: "", hasRunpodS3Secret: false, rentCaps: { day: 0, month: 0 }, costs: { kwhPrice: null, currency: "€" }, lastDeploy: null, volumeUnusedDays: 7, bootLogDays: 0, civitaiLookups: true, updateChecks: false, afflatusUpdateChecks: true, downloadModels: true, downloadPlaces: {}, renderHistoryDays: 90, jobHistoryDays: 30, unkeptDays: 1, binDays: 7,
      finish: { route: "seedvr", factor: 2, colour: "lab", upscaleModel: "", latentNoise: 0.35, latentSteps: 3, faceDenoise: 0.45, face: false, seedvrFrames: 0, sharpen: 0, faceModel: "", latentModel: "", seedvrModel: "" }, slotFiles: {}, acceptedPresets: [],
      bar: { shortcut: "Ctrl+K", snippets: false, cast: false }, pinnedProjects: [], pinnedFields: {},
      notify: { hasTelegramToken: false, telegramChat: "", hasDiscordWebhook: false, picture: true, events: expect.objectContaining({ renderDone: { telegram: false, discord: false }, renderFailed: { telegram: true, discord: true } }) },
      access: { hasPassword: false, passwordSetAt: null, localNoPassword: false, stayDays: 30, resetTelegram: true, hasMetricsToken: false },
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

  it("keep the pinned fields per model family, in their order, and forget them all", async () => {
    // the H3 forms share the family "h3": one list of input ids for every one of them
    const pins = { sdxl: ["cfg", "hiresDenoise", "steps"], h3: ["shot"] };
    expect((await put({ pinnedFields: pins })).json().pinnedFields).toEqual(pins);
    expect((await get(t.app, "/api/settings")).json().pinnedFields).toEqual(pins);
    // a field pinned twice, or a list that is not one of ids, is refused and leaves what was kept
    expect((await put({ pinnedFields: { sdxl: ["cfg", "cfg"] } })).statusCode).toBe(400);
    expect((await put({ pinnedFields: { sdxl: [""] } })).statusCode).toBe(400);
    expect((await put({ pinnedFields: { sdxl: "cfg" } })).statusCode).toBe(400);
    expect((await get(t.app, "/api/settings")).json().pinnedFields).toEqual(pins);
    // Settings › Interface's Forget sends none
    expect((await put({ pinnedFields: {} })).json().pinnedFields).toEqual({});
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

  it("take only http and https addresses for ComfyUI and for a language model", async () => {
    expect((await put({ comfyUrl: "file:///etc/passwd" })).statusCode).toBe(400);
    expect((await put({ comfyUrl: "not an address" })).statusCode).toBe(400);
    expect((await put({ llms: [{ id: "a", baseUrl: "ftp://llm/v1" }] })).statusCode).toBe(400);
    expect((await put({ llms: [{ id: "a", baseUrl: "" }] })).statusCode).toBe(200);
    expect((await put({ llms: [{ id: "a", baseUrl: "https://api.example.com/v1" }] })).statusCode).toBe(200);
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
      const setup = unlistOptions((await get(own.app, "/api/setup")).json());
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
      const setup = unlistOptions((await get(own.app, "/api/setup")).json());
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
