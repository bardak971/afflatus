import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forAdults, forgetPages, PageStore, thumbOf } from "../src/browse";
import { startFakeComfy } from "@afflatus/comfy/testing";
import { folderOfHfFile, folderOfSlots, slotPlaces } from "../src/fromLink";
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
/** Whether each request asked carried an Authorization header, by its address. */
let keyed: Map<string, boolean>;

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
  keyed = new Map();
  forgetPages();
  site = createServer((req, res) => {
    asked.push(req.url ?? "");
    keyed.set(req.url ?? "", Boolean(req.headers.authorization));
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/v1/models?")) return res.end(JSON.stringify({ items: [civModel], metadata: { nextCursor: "c2" } }));
    if (req.url === "/api/v1/models/77") return res.end(JSON.stringify(civModel));
    if (req.url?.startsWith("/api/models?")) {
      res.setHeader("Link", `<http://x/api/models?cursor=hf2>; rel="next"`);
      return res.end(JSON.stringify([{ id: "org/wan-loras", downloads: 50, likes: 3, gated: false, tags: ["lora", "base_model:adapter:Wan-AI/Wan2.2-I2V-A14B"], siblings: [{ rfilename: "a.safetensors" }, { rfilename: "README.md" }] }]));
    }
    // a RIFE kept at its repository's root: no folder name in its path
    if (req.url?.startsWith("/api/models/sisniha/frame_interpolation/tree/main")) return res.end(JSON.stringify([{ type: "file", path: "rife_v4.26.safetensors", size: 134, lfs: { oid: "d".repeat(64), size: 21_000_000 } }]));
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
    // Find models' own cursor: Civitai's, and where in its block
    expect(next).toBe("c2~0");
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
    expect(off.next).toBe("c2~0");
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
    // one creator's only (the command bar's by:), on both sites by their own parameter
    // (a page asked ahead may come in between: the first pages only)
    asked = [];
    await get(t.app, "/api/browse/huggingface?q=wan&by=Comfy-Org");
    expect(new URL(asked.find((u) => u.startsWith("/api/models?") && u.includes("author="))!, "http://x").searchParams.get("author")).toBe("Comfy-Org");
    await get(t.app, "/api/browse/civitai?q=wan&by=maker");
    expect(new URL(asked.find((u) => u.startsWith("/api/v1/models?") && !u.includes("cursor="))!, "http://x").searchParams.get("username")).toBe("maker");
    expect((await get(t.app, "/api/browse/civitai?by=a%20b")).statusCode).toBe(400);
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

  it("asks Civitai's list pages without the user's key (its shared cache bypasses keyed requests), what is opened with it", async () => {
    await writeSettings(t.db, { civitaiKey: "k".repeat(32) });
    await get(t.app, "/api/browse/civitai?q=handheld");
    expect(keyed.get(asked.find((u) => u.startsWith("/api/v1/models?"))!)).toBe(false);
    await post(t.app, "/api/browse/link", { link: "https://civitai.com/models/77" });
    expect(keyed.get("/api/v1/models/77")).toBe(true);
  });

  it("asks the next page as soon as one is served and serves it from there; a page asked again within 5 minutes is not asked again", async () => {
    const first = await get(t.app, "/api/browse/civitai?q=handheld");
    expect(first.headers["server-timing"]).toMatch(/^civitai;dur=\d+;desc="asked", known;dur=\d+, cards;dur=\d+, total;dur=\d+$/);
    await vi.waitFor(() => expect(asked.filter((u) => u.includes("cursor=c2"))).toHaveLength(1));
    const second = await get(t.app, "/api/browse/civitai?q=handheld&cursor=c2~0");
    expect(second.json().items).toHaveLength(1);
    expect(second.headers["server-timing"]).toContain(`desc="kept"`);
    await get(t.app, "/api/browse/civitai?q=handheld");
    // page 1 once; page 2 once, ahead (its own next page is the same c2 here, already kept)
    expect(asked.filter((u) => u.startsWith("/api/v1/models?") && !u.includes("cursor="))).toHaveLength(1);
    expect(asked.filter((u) => u.includes("cursor=c2"))).toHaveLength(1);
    // Hugging Face alike
    await get(t.app, "/api/browse/huggingface?q=wan");
    await vi.waitFor(() => expect(asked.filter((u) => u.startsWith("/api/models?") && u.includes("cursor=hf2"))).toHaveLength(1));
    expect((await get(t.app, "/api/browse/huggingface?q=wan&cursor=hf2")).headers["server-timing"]).toMatch(/^huggingface;dur=\d+;desc="kept"/);
    expect(asked.filter((u) => u.startsWith("/api/models?") && u.includes("cursor=hf2"))).toHaveLength(1);
  });

  it("asks Civitai the first page at 24 and then blocks of 96 ahead, each served 24 at a time from one ask", async () => {
    site.removeAllListeners("request");
    site.on("request", (req, res) => {
      asked.push(req.url ?? "");
      const p = new URL(req.url ?? "", "http://x").searchParams;
      const from = Number(p.get("cursor") ?? 0);
      const many = from >= 100 ? 30 : Number(p.get("limit"));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ items: Array.from({ length: many }, (_, i) => ({ ...civModel, id: from + i, name: `zz-test ${from + i}` })), metadata: from >= 100 ? {} : { nextCursor: from + many } }));
    });
    const ids = (r: { json(): { items: Array<{ id: string }> } }) => r.json().items.map((c) => Number(c.id));
    const first = await get(t.app, "/api/browse/civitai?q=x");
    expect(ids(first)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    let next = first.json().next as string | null;
    const seen: number[] = [];
    while (next) {
      const page = await get(t.app, `/api/browse/civitai?q=x&cursor=${encodeURIComponent(next)}`);
      seen.push(...ids(page));
      next = page.json().next;
    }
    // every model once, in Civitai's order: 24 to 119 (one block of 96), then the last block's 30
    expect(seen).toEqual([...Array.from({ length: 96 }, (_, i) => 24 + i), ...Array.from({ length: 30 }, (_, i) => 120 + i)]);
    const limits = asked.map((u) => new URL(u, "http://x").searchParams.get("limit"));
    expect(limits).toEqual(["24", "96", "96"]);
  });

  it("keeps no failed page: asked again, it is asked of the site again", async () => {
    let fail = true;
    site.removeAllListeners("request");
    site.on("request", (req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      if (fail) {
        res.statusCode = 500;
        return res.end("{}");
      }
      res.end(JSON.stringify({ items: [civModel], metadata: {} }));
    });
    expect((await get(t.app, "/api/browse/civitai?q=down")).statusCode).toBe(502);
    fail = false;
    const again = await get(t.app, "/api/browse/civitai?q=down");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ items: [{ id: "77" }], next: null });
  });

  it("keeps a page for its time, the most recent ones only", async () => {
    let now = 0;
    const pages = new PageStore<number>(1000, 2, () => now);
    let asks = 0;
    const ask = () => Promise.resolve(++asks);
    expect(await pages.get("a", ask).got).toBe(1);
    expect(pages.get("a", ask).how).toBe("kept");
    now = 1000;
    expect(await pages.get("a", ask).got).toBe(2);
    pages.ahead("b", ask);
    pages.ahead("b", ask);
    expect(asks).toBe(3);
    pages.ahead("c", ask);
    // two kept at most: the oldest (a) went
    expect(pages.get("c", ask).how).toBe("kept");
    expect(pages.get("a", ask).how).toBe("asked");
  });

  it("places a file its path says nothing of by the families' slots: RIFE at a repository's root goes in frame_interpolation", async () => {
    const files = (await get(t.app, "/api/browse/huggingface/files?repo=sisniha/frame_interpolation")).json().files;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "rife_v4.26.safetensors", folder: "frame_interpolation" });
    expect(files[0].why).toMatch(/RIFE.*frame_interpolation/);
    // a link to the file, pasted where a download is asked for, is placed the same way
    await writeSettings(t.db, { downloadModels: true });
    const linked = (await post(t.app, "/api/downloads/resolve", { link: "https://huggingface.co/sisniha/frame_interpolation/blob/main/rife_v4.26.safetensors" })).json();
    expect(linked.folder).toBe("frame_interpolation");
  });

  it("offers ComfyUI's own folders to put a file in, with the usual ones and the families'; the usual and the families' when ComfyUI does not answer", async () => {
    const without = (await get(t.app, "/api/browse/folders")).json();
    expect(without.comfy).toBe(false);
    expect(without.folders).toEqual(expect.arrayContaining(["checkpoints", "loras", "frame_interpolation", "ultralytics_bbox"]));
    expect(without.folders).toEqual([...without.folders].sort());
    const fake = await startFakeComfy({ models: { checkpoints: [], frame_interpolation: [], somepack_models: [], custom_nodes: [] } });
    const t2 = await makeApp({ comfyUrl: fake.url });
    try {
      const withIt = (await get(t2.app, "/api/browse/folders")).json();
      expect(withIt.comfy).toBe(true);
      // a folder only that ComfyUI knows (a custom node's) can be chosen; ComfyUI's custom_nodes is no models folder
      expect(withIt.folders).toEqual(expect.arrayContaining(["somepack_models", "frame_interpolation", "loras", "embeddings"]));
      expect(withIt.folders).not.toContain("custom_nodes");
      expect((await get(t2.app, "/api/browse/folders?machine=nope")).json().comfy).toBe(false);
    } finally {
      await t2.close();
      await fake.close();
    }
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

describe("a file's folder by the families' slots", () => {
  const places = slotPlaces([
    { name: "MiniMax H3", slots: [
      { label: "Frame interpolation model (RIFE)", folder: "frame_interpolation", detect: ["rife"] },
      { label: "Face detector", folder: "ultralytics", detect: ["face_yolo"], get: { file: "bbox/face_yolov8m.pt" } },
      { label: "Video model", folder: "diffusion_models", detect: ["^(?!.*lora).*flux.?1"] },
      { label: "Bad pattern", folder: "vae", detect: ["("] },
      { label: "Checkpoint", folder: "checkpoints", detect: ["."] },
    ] },
    { name: "Other", slots: [{ label: "Text encoder", folder: "text_encoders", detect: ["clip_l"] }, { label: "Vision", folder: "clip_vision", detect: ["clip_l"] }] },
  ]);

  it("takes the folder every slot that knows the name agrees on, with why; none when two slots claim it for two folders", () => {
    expect(folderOfSlots("rife49.pth", places)).toEqual({ folder: "frame_interpolation", why: expect.stringContaining("MiniMax H3's Frame interpolation model (RIFE)") });
    expect(folderOfSlots("clip_l.safetensors", places)).toBeNull();
    expect(folderOfSlots("nothing.safetensors", places)).toBeNull();
  });

  it("puts a slot's file kept in a sub-folder in the folder ComfyUI names for it (ultralytics_bbox), and skips a broken pattern or one any name matches", () => {
    expect(folderOfSlots("face_yolov8s.pt", places)?.folder).toBe("ultralytics_bbox");
    expect(places.some((p) => p.folder === "vae" || p.folder === "checkpoints")).toBe(false);
  });

  it("reads a Hugging Face file's path first, then a LoRA by its path, then the slots", () => {
    expect(folderOfHfFile("split_files/vae/rife.safetensors", places)).toEqual({ folder: "vae" });
    // a family's folder in the path (sisniha/frame_interpolation keeps FILM beside RIFE in frame_interpolation/)
    expect(folderOfHfFile("frame_interpolation/film_net_fp16.safetensors", places)).toEqual({ folder: "frame_interpolation" });
    expect(folderOfHfFile("flux1_style_lora.safetensors", places)).toEqual({ folder: "loras" });
    expect(folderOfHfFile("flux1-dev.safetensors", places).folder).toBe("diffusion_models");
    expect(folderOfHfFile("misc/thing.safetensors", places)).toEqual({ folder: null });
  });
});
