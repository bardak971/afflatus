import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, referenceCatalog, type TestApp } from "./helpers";

/**
 * Where a workflow's missing files can be had, worked out at import from the author's notes, the
 * author's other models and Manager's list of standard files.
 */
describe("sources for a workflow's missing files", () => {
  let fake: FakeComfy;
  let t: TestApp;
  let civitai: Server;
  let asked: string[] = [];

  const lora = (id: number, name: string, versionId: number, version: string, file: string) => ({ id, name, type: "LORA", creator: { username: "Stable_Yogi" }, modelVersions: [{ id: versionId, name: version, files: [{ name: file, primary: true }] }] });

  beforeEach(async () => {
    asked = [];
    civitai = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/models/1098033") return res.end(JSON.stringify(lora(1098033, "Realism Lora By Stable Yogi (Pony)", 5001, "v3.0_lite", "Realism Lora By Stable Yogi_V3_Lite.safetensors")));
      if (req.url === "/api/v1/models/1134825") {
        return res.end(JSON.stringify({
          id: 1134825, name: "Babes Illustrious By Stable Yogi", type: "Checkpoint", creator: { username: "Stable_Yogi" },
          modelVersions: [{ id: 2044081, name: "v5.5_DMD2", files: [{ name: "babesIllustriousBy_v55DMD2.safetensors", primary: true }] }, { id: 2044080, name: "v5.5 FP16", files: [{ name: "babesIllustriousBy_v55FP16.safetensors" }] }],
        }));
      }
      if (req.url?.startsWith("/api/v1/models?") && req.url.includes("username=Stable_Yogi")) {
        return res.end(JSON.stringify({ items: [
          lora(1100721, "Realism Lora By Stable Yogi (SDXL)", 6001, "v1.0", "Realism_Lora_By_Stable_yogi_SDXL8.1.safetensors"),
          lora(777, "Eyes Fix", 7001, "v1", "StableYogi_EyesFix_v1.safetensors"),
        ] }));
      }
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise<void>((r) => civitai.listen(0, "127.0.0.1", r));
    process.env.CIVITAI_URL = `http://127.0.0.1:${(civitai.address() as AddressInfo).port}`;
    process.env.MODEL_LIST_URL = "data:application/json," + encodeURIComponent(JSON.stringify({ models: [{ name: "4x-UltraSharp", type: "upscale", filename: "4x-UltraSharp.pth", save_path: "default", url: "https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth" }] }));
    const catalog = referenceCatalog();
    catalog.LoraLoader!.input.required!.lora_name = [["other.safetensors"]];
    catalog.UpscaleModelLoader!.input.required!.model_name = [["other.pth"]];
    fake = await startFakeComfy({ catalog });
    t = await makeApp({ comfyUrl: fake.url });
  });
  afterEach(async () => {
    delete process.env.CIVITAI_URL;
    delete process.env.MODEL_LIST_URL;
    await t?.close();
    await fake?.close();
    await new Promise((r) => civitai.close(r));
  });

  const graph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "StableDiffusion\\PRO\\Babes Illustrious BSY V5 Patreon Pro DMD2 C36.safetensors" } },
    "2": { class_type: "LoraLoader", inputs: { lora_name: "000 ALL SDXL LORAS\\Realism Lora By Stable Yogi_V3_Lite.safetensors", strength_model: 1, strength_clip: 1, model: ["1", 0], clip: ["1", 1] } },
    "3": { class_type: "LoraLoader", inputs: { lora_name: "StableYogi_EyesFix_v1.safetensors", strength_model: 1, strength_clip: 1, model: ["2", 0], clip: ["2", 1] } },
    "4": { class_type: "UpscaleModelLoader", inputs: { model_name: "4x-UltraSharp.pth" } },
  };
  const wiring = { modes: {}, slots: {}, fallback: {}, links: [{ label: "Babes By Stable Yogi (Illus) v5", url: "https://civitai.com/models/1134825?modelVersionId=2044081" }, { label: "Realism Lora By Stable Yogi (Pony)", url: "https://civitai.com/models/1098033/realism-lora-by-stable-yogi-pony" }] };
  const inspect = async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/workflows/inspect", payload: { graph, wiring } });
    expect(res.statusCode, res.body).toBe(200);
    const found = res.json() as { missingFiles: Array<{ file: string; source?: Record<string, unknown> }> };
    return Object.fromEntries(found.missingFiles.map((m) => [m.file.split(/[\\/]/).pop()!, m.source ?? null]));
  };

  it("asks nothing while lookups are off", async () => {
    const by = await inspect();
    expect(Object.keys(by)).toHaveLength(4);
    expect(Object.values(by).every((s) => s === null)).toBe(true);
    expect(asked).toEqual([]);
  });

  it("takes the author's links first, then the author's other models, and Manager's list for standard files", async () => {
    await t.app.inject({ method: "PUT", url: "/api/settings", payload: { civitaiLookups: true } });
    const by = await inspect();
    // the notes link the very model, which has the file itself
    expect(by["Realism Lora By Stable Yogi_V3_Lite.safetensors"]).toMatchObject({ how: "notes", exact: true, civitai: 5001, file: "Realism Lora By Stable Yogi_V3_Lite.safetensors", page: "https://civitai.com/models/1098033" });
    // the checkpoint is a build Civitai never had: the notes' link gives the version the author points at, said not to be the same file
    expect(by["Babes Illustrious BSY V5 Patreon Pro DMD2 C36.safetensors"]).toMatchObject({ how: "notes", exact: false, civitai: 2044081, file: "babesIllustriousBy_v55DMD2.safetensors" });
    // a LoRA the notes do not name: the same author has it, under exactly that name
    expect(by["StableYogi_EyesFix_v1.safetensors"]).toMatchObject({ how: "creator", exact: true, civitai: 7001 });
    // a standard file: Manager's list has its address, Civitai is not asked for it
    expect(by["4x-UltraSharp.pth"]).toMatchObject({ how: "known", exact: true, url: "https://huggingface.co/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.pth" });
    expect(asked.filter((u) => u.startsWith("/api/v1/models/"))).toHaveLength(2);
    // the author's models are listed once per kind: for the checkpoint, whose link was not the file itself, and for the LoRA the notes do not name
    expect(asked.filter((u) => u.includes("username=")).sort()).toEqual([
      "/api/v1/models?username=Stable_Yogi&limit=100&nsfw=true&types=Checkpoint",
      "/api/v1/models?username=Stable_Yogi&limit=100&nsfw=true&types=LORA&types=LoCon&types=DoRA",
    ]);
  });
});
