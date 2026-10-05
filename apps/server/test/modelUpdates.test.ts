import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { get, makeApp, post, referenceCatalog, type TestApp } from "./helpers";

/**
 * Civitai, pretended: version 42 (of model 9, "Soft light") is what the LoRA here is; the model has a
 * newer version 50. A second LoRA has no hash and is not on the disk: it stays unmatched.
 */
let fake: FakeComfy;
let t: TestApp;
let site: Server;
let asked: string[] = [];

beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [], diffusion_models: [], loras: ["soft_light.safetensors", "nameless.safetensors"] } });
  site = createServer((req, res) => {
    asked.push(req.url ?? "");
    const json = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/v1/model-versions/by-hash/ABCDEF123456") return json({ id: 42, name: "v1 Int8", modelId: 9, model: { name: "Soft light" }, publishedAt: "2026-01-01T00:00:00Z" });
    if (req.url === "/api/v1/models/9") {
      return json({
        id: 9, name: "Soft light",
        modelVersions: [
          // the newest is an int4 sibling of v2; the int8 file here is told about v2 int8, not about it
          { id: 51, name: "v2 Int4", publishedAt: "2026-07-01T00:00:00Z", files: [{ name: "soft_light-v2-int4.safetensors", primary: true }] },
          { id: 50, name: "v2 Int8", publishedAt: "2026-06-01T00:00:00Z", files: [{ name: "soft_light-v2.safetensors", primary: true }] },
          { id: 45, name: "v1 Int4", publishedAt: "2026-02-01T00:00:00Z", files: [{ name: "soft_light-int4.safetensors", primary: true }] },
          { id: 42, name: "v1 Int8", publishedAt: "2026-01-01T00:00:00Z", files: [{ name: "soft_light.safetensors", primary: true }] },
        ],
      });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const port = (site.address() as { port: number }).port;
  process.env.CIVITAI_URL = `http://127.0.0.1:${port}`;
  asked = [];
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  delete process.env.CIVITAI_URL;
  await t.close();
  await new Promise<void>((r) => site.close(() => r()));
  await fake.close().catch(() => {});
});

import { precisionOf, sansPrecision } from "../src/modelUpdates";

describe("a version's name, apart from its precision", () => {
  it("tells a precision sibling from a newer version", () => {
    expect(sansPrecision("v3.5 Int8 Extended")).toBe(sansPrecision("v3.5 Int4 Extended"));
    expect(sansPrecision("v3.5 Int8 Extended")).not.toBe(sansPrecision("v3.6 Int8 Extended"));
    expect(precisionOf("v2 fp8_e4m3fn scaled")).toBe("fp8e4m3fn scaled");
    expect(precisionOf("Q4_K_M gguf")).toBe("gguf q4km");
    expect(precisionOf("v7.77")).toBe("");
  });
});

describe("newer versions on Civitai", () => {
  it("does nothing while lookups are off; then matches a file by its fingerprint, asks the model page once, and says which version is newer", async () => {
    expect((await post(t.app, "/api/models/updates/check", {})).json()).toMatchObject({ items: [], lookups: false });
    expect(asked).toEqual([]);
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true } });
    // the LoRA's header was read: its fingerprint is known
    await t.services.db.insertInto("model_info").values({ folder: "loras", file: "soft_light.safetensors", info: JSON.stringify({ fingerprint: "ABCDEF123456", v: 4 }), read_at: "2026-10-05T00:00:00Z" }).execute();
    const r = (await post(t.app, "/api/models/updates/check", {})).json();
    expect(r.lookups).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ folder: "loras", file: "soft_light.safetensors", modelId: 9, modelName: "Soft light", versionId: 42, versionName: "v1 Int8", newer: { id: 50, name: "v2 Int8", file: "soft_light-v2.safetensors" } });
    expect(r.items[0].newer.page).toBe("https://civitai.com/models/9?modelVersionId=50");
    // the file with no hash and no copy on this disk is counted, not guessed
    expect(r.unmatched).toBe(1);
    expect(asked.filter((u) => u.includes("by-hash"))).toHaveLength(1);
    expect(asked.filter((u) => u === "/api/v1/models/9")).toHaveLength(1);
    // asked again: the match is kept, only the model page is read again
    asked = [];
    await post(t.app, "/api/models/updates/check", {});
    expect(asked.filter((u) => u.includes("by-hash"))).toHaveLength(0);
    expect(asked.filter((u) => u === "/api/v1/models/9")).toHaveLength(1);
    expect((await get(t.app, "/api/models/updates")).json().items).toHaveLength(1);
    // the setting for the daily check is kept
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { updateChecks: true } });
    expect((await get(t.app, "/api/settings")).json().updateChecks).toBe(true);
    // a file's row forgotten by name; without a name there is nothing to forget, and that is said rather than failed
    expect((await t.app.inject({ method: "DELETE", url: "/api/models/updates/loras" })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "DELETE", url: "/api/models/updates/loras?file=Soft_Light.safetensors" })).statusCode).toBe(200);
    expect((await get(t.app, "/api/models/updates")).json().items).toEqual([]);
  });
});
