import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forAdults, thumbOf } from "../src/browse";
import { forgetHuggingFace } from "../src/huggingface";
import { writeSettings } from "../src/settings";
import { get, makeApp, post, type TestApp } from "./helpers";

/**
 * Find models (browse.ts) against a pretend Civitai and Hugging Face: cards with each file's folder, its source and what
 * the user has of it (a file of the same SHA-256 here, a Model set), the families' base models, a link pasted.
 */

const SHA_HAVE = "A".repeat(64);
let t: TestApp;
let site: Server;
let asked: string[];

const civModel = {
  id: 77, name: "Handheld Camera", type: "LORA", creator: { username: "maker" }, stats: { downloadCount: 1400, thumbsUpCount: 90 },
  allowCommercialUse: ["Image"], allowNoCredit: false, allowDerivatives: true,
  modelVersions: [{
    id: 770, name: "v2", baseModel: "Wan Video 2.2 I2V-A14B", publishedAt: "2026-10-01T00:00:00Z", trainedWords: ["handheld"],
    files: [
      { name: "handheld_high.safetensors", sizeKB: 150_000, metadata: { fp: "fp16" }, hashes: { SHA256: SHA_HAVE } },
      { name: "handheld_low.safetensors", sizeKB: 150_000, hashes: { SHA256: "B".repeat(64) } },
      { name: "readme.txt", sizeKB: 1 },
    ],
    images: [{ url: "https://image.civitai.com/x/abc/original=true/1.jpeg", type: "image" }],
  }],
};

beforeEach(async () => {
  asked = [];
  site = createServer((req, res) => {
    asked.push(req.url ?? "");
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/v1/models?")) return res.end(JSON.stringify({ items: [civModel], metadata: { nextCursor: "c2" } }));
    if (req.url === "/api/v1/models/77") return res.end(JSON.stringify(civModel));
    if (req.url?.startsWith("/api/models?")) {
      res.setHeader("Link", `<http://x/api/models?cursor=hf2>; rel="next"`);
      return res.end(JSON.stringify([{ id: "org/wan-loras", downloads: 50, likes: 3, gated: false, tags: ["lora", "base_model:adapter:Wan-AI/Wan2.2-I2V-A14B"], siblings: [{ rfilename: "a.safetensors" }, { rfilename: "README.md" }] }]));
    }
    if (req.url?.startsWith("/api/models/org/wan-loras/tree/main")) return res.end(JSON.stringify([{ type: "file", path: "loras/a.safetensors", size: 134, lfs: { oid: "c".repeat(64), size: 200_000_000 } }, { type: "file", path: "README.md", size: 10 }]));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  vi.stubEnv("CIVITAI_URL", at);
  vi.stubEnv("HUGGINGFACE_URL", at);
  forgetHuggingFace();
  t = await makeApp();
  await writeSettings(t.db, { civitaiLookups: true });
  // this computer has the high one (by its hash, under another name); a set holds the low one
  await t.db.insertInto("model_hashes").values({ folder: "loras", file: "mine/renamed.safetensors", size: 1, mtime: 1, sha256: SHA_HAVE, hashed_at: "2026-10-14", civitai_version: 770, hf_url: null, matched_at: "2026-10-14" }).execute();
  await post(t.app, "/api/model-sets", { name: "Video", presets: [], off: [], files: [{ file: "handheld_low.safetensors", folder: "loras" }] });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
  await new Promise((r) => site.close(r));
});

describe("find models", () => {
  it("lists Civitai's models as cards: files with their folder, source, and what the user has; filters as Civitai takes them", async () => {
    const res = await get(t.app, "/api/browse/civitai?q=handheld&types=LORA&bases=Wan%20Video%202.2%20I2V-A14B&sort=Newest&period=Month");
    expect(res.statusCode).toBe(200);
    const { items, next } = res.json();
    expect(next).toBe("c2");
    const asked1 = new URL(asked.find((u) => u.startsWith("/api/v1/models?"))!, "http://x").searchParams;
    expect(Object.fromEntries(asked1)).toMatchObject({ query: "handheld", types: "LORA", baseModels: "Wan Video 2.2 I2V-A14B", sort: "Newest", period: "Month", limit: "24" });
    const card = items[0];
    expect(card).toMatchObject({
      site: "civitai", id: "77", name: "Handheld Camera", type: "LORA", base: "Wan Video 2.2 I2V-A14B", creator: "maker", downloads: 1400, likes: 90,
      thumb: "https://image.civitai.com/x/abc/width=450/1.jpeg", page: "https://civitai.com/models/77",
      licence: { commercial: true, credit: true, derivatives: true }, have: true, gated: false,
    });
    const files = card.versions[0].files;
    // a model file only (no readme), each with its folder and its Civitai version
    expect(files.map((f: { name: string }) => f.name)).toEqual(["handheld_high.safetensors", "handheld_low.safetensors"]);
    expect(files[0]).toMatchObject({ folder: "loras", bytes: 150_000 * 1024, note: "fp16", source: { kind: "civitai", version: 770, pick: "handheld_high.safetensors" }, have: [{ kind: "pc", folder: "loras", file: "mine/renamed.safetensors" }] });
    expect(files[1].have).toEqual([{ kind: "set", name: "Video" }]);
    expect(card.versions[0].trainedWords).toEqual(["handheld"]);
  });

  it("takes a file of the same name here for the site's only when the site says no hash: other bytes are another file", async () => {
    await t.db.insertInto("model_hashes").values({ folder: "loras", file: "handheld_low.safetensors", size: 1, mtime: 1, sha256: "D".repeat(64), hashed_at: "2026-10-14", civitai_version: 0, hf_url: null, matched_at: "2026-10-14" }).execute();
    const files = (await get(t.app, "/api/browse/civitai?q=handheld")).json().items[0].versions[0].files;
    expect(files[1].have).toEqual([{ kind: "set", name: "Video" }]);
  });

  it("with All of Civitai off, leaves out a model for adults by its flag, its name or its explicit tags, not a checkpoint merely tagged nsfw", async () => {
    expect(forAdults({ name: "NSFW Master" })).toBe(true);
    expect(forAdults({ name: "Breast size slider" })).toBe(true);
    expect(forAdults({ name: "Styles pack", tags: ["anime", "hentai"] })).toBe(true);
    expect(forAdults({ name: "Plain", nsfw: true })).toBe(true);
    expect(forAdults({ name: "Juggernaut XL", tags: ["photorealistic", "nsfw"] })).toBe(false);
    expect(forAdults({ name: "Hairstyles Collection", tags: ["woman", "sexy"] })).toBe(false);
    expect(forAdults({ name: "Essex landscapes", tags: ["sussex"] })).toBe(false);
    const flagged = { ...civModel, id: 78, name: "Nude Pack" };
    site.removeAllListeners("request");
    site.on("request", (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ items: [civModel, flagged], metadata: { nextCursor: "c2" } }));
    });
    const off = (await get(t.app, "/api/browse/civitai?q=x")).json();
    expect(off.items.map((c: { id: string }) => c.id)).toEqual(["77"]);
    expect(off.next).toBe("c2");
    const on = (await get(t.app, "/api/browse/civitai?q=x&all=1")).json();
    expect(on.items.map((c: { id: string }) => c.id)).toEqual(["77", "78"]);
  });

  it("says which family a model fits by its base model, and offers the families' base models as filters", async () => {
    const bases = (await get(t.app, "/api/browse/bases")).json();
    expect(bases.families.find((f: { id: string }) => f.id === "wan")).toMatchObject({ bases: expect.arrayContaining(["Wan Video 2.2 I2V-A14B"]), hf: expect.arrayContaining(["Wan-AI/Wan2.2-I2V-A14B"]) });
    const card = (await get(t.app, "/api/browse/civitai")).json().items[0];
    expect(card.fits).toEqual(expect.any(String));
  });

  it("lists Hugging Face's repositories, made for a family's base model, then a repository's model files with sizes and SHA-256", async () => {
    const res = (await get(t.app, `/api/browse/huggingface?base=${encodeURIComponent("Wan-AI/Wan2.2-I2V-A14B")}&kind=loras`)).json();
    expect(res.next).toBe("hf2");
    const asked1 = new URL(asked.find((u) => u.startsWith("/api/models?"))!, "http://x").searchParams;
    // one base model at a time: Hugging Face reads several as all of them at once
    expect(asked1.getAll("filter")).toEqual(["base_model:adapter:Wan-AI/Wan2.2-I2V-A14B", "lora"]);
    expect((await get(t.app, "/api/browse/huggingface?base=evil")).statusCode).toBe(400);
    expect(res.items[0]).toMatchObject({ site: "huggingface", id: "org/wan-loras", creator: "org", modelFiles: 1, thumb: null, versions: [] });
    const files = (await get(t.app, "/api/browse/huggingface/files?repo=org/wan-loras")).json().files;
    expect(files).toEqual([{ name: "a.safetensors", bytes: 200_000_000, note: "loras", sha256: "C".repeat(64), folder: "loras", source: { kind: "url", url: "https://huggingface.co/org/wan-loras/resolve/main/loras/a.safetensors" }, have: [] }]);
    expect((await get(t.app, "/api/browse/huggingface/files?repo=../../etc")).statusCode).toBe(400);
  });

  it("reads a pasted link: a Civitai page, a Hugging Face repository or one of its files", async () => {
    const civ = (await post(t.app, "/api/browse/link", { link: "https://civitai.com/models/77?modelVersionId=770" })).json();
    expect(civ.card).toMatchObject({ site: "civitai", id: "77", versions: [{ id: "770" }] });
    const repo = (await post(t.app, "/api/browse/link", { link: "https://huggingface.co/org/wan-loras" })).json();
    expect(repo.card.versions[0].files.map((f: { name: string }) => f.name)).toEqual(["a.safetensors"]);
    const file = (await post(t.app, "/api/browse/link", { link: "https://huggingface.co/org/wan-loras/blob/main/loras/a.safetensors" })).json();
    expect(file.card.versions[0].files).toHaveLength(1);
    expect((await post(t.app, "/api/browse/link", { link: "https://example.com/nothing" })).statusCode).toBe(400);
  });

  it("asks no site with lookups off", async () => {
    await writeSettings(t.db, { civitaiLookups: false });
    expect((await get(t.app, "/api/browse/civitai")).statusCode).toBe(409);
    expect(asked).toEqual([]);
  });

  it("makes a 450-wide thumbnail of a picture, and a still of a video", () => {
    expect(thumbOf({ url: "https://image.civitai.com/k/u/original=true/9.jpeg", type: "image" })).toBe("https://image.civitai.com/k/u/width=450/9.jpeg");
    expect(thumbOf({ url: "https://image.civitai.com/k/u/width=1080/9.mp4", type: "video" })).toBe("https://image.civitai.com/k/u/anim=false,transcode=true,width=450/9.mp4");
    expect(thumbOf(undefined)).toBeNull();
  });
});
