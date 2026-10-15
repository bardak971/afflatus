import { describe, expect, it } from "vitest";
import type { BrowseCard, Download, FamilyInfo, UpdateRow } from "../src/api";
import { downloadRows, isLink, linkRows } from "../src/bar/modelRows";
import { parseCommand } from "../src/bar/parse";
import { parseSearch } from "../src/bar/search";
import { valueRows, type SearchData } from "../src/bar/searchRows";

const file = (name: string, over: object = {}) => ({ name, bytes: 48 * 2 ** 20, note: "", sha256: "", folder: "loras", source: { kind: "civitai" as const, version: 1002, pick: name }, have: [], ...over });
const card = (over: Partial<BrowseCard> = {}): BrowseCard => ({
  site: "civitai", id: "777", name: "Soft light", type: "LORA", base: "SDXL 1.0", creator: "someone", downloads: 0, likes: 0, updatedAt: "", thumb: null, page: "https://civitai.com/models/777",
  licence: { commercial: "", credit: false, derivatives: true }, fits: null, have: false, update: null, gated: false,
  versions: [{ id: "1002", name: "v2", base: "SDXL 1.0", publishedAt: "", trainedWords: ["soft light"], files: [file("soft_light-v2.safetensors")] }],
  ...over,
} as unknown as BrowseCard);

describe("Civitai and Hugging Face in the bar", () => {
  it("reads a pasted address as a link, not words", () => {
    expect(isLink("https://civitai.com/models/777?modelVersionId=1002")).toBe(true);
    expect(isLink("  https://huggingface.co/org/repo ")).toBe(true);
    expect(isLink("civitai lora")).toBe(false);
    expect(isLink("https://a b")).toBe(false);
  });

  it("lists a link's files, the folder each goes in, and what is had already", () => {
    const rows = linkRows(card());
    expect(rows.map((r) => [r.label, r.meta, r.verb])).toEqual([["Soft light · v2", "LORA · SDXL 1.0 · 48 MB · → loras", "download"]]);
    expect(rows[0]!.value).toMatchObject({ kind: "link", version: "1002", file: "soft_light-v2.safetensors" });
    // a Hugging Face repository: a row per file, by its name; one without a folder has it asked
    const hf = linkRows(card({ site: "huggingface", id: "org/repo", type: "", base: "", versions: [{ id: "main", name: "main", base: "", publishedAt: "", trainedWords: [], files: [file("a.safetensors", { folder: null, have: [{ kind: "pc", folder: "loras", file: "a.safetensors" }] }), file("b.gguf")] }] }));
    expect(hf.map((r) => [r.label, r.meta])).toEqual([["a.safetensors", "48 MB · its folder asked · you have it"], ["b.gguf", "48 MB · → loras"]]);
  });

  it("lists the downloads under way first, with how far, and what Enter does to each", () => {
    const d = (over: Partial<Download>): Download => ({ id: "x", file: "a.safetensors", folder: "loras", title: "a.safetensors", bytes: 0, total: 0, status: "done", ...over });
    const rows = downloadRows([
      d({ id: "1", status: "stopped", again: true }),
      d({ id: "2", status: "downloading", bytes: 12 * 2 ** 20, total: 48 * 2 ** 20, title: "Soft light · v2", machine: "pod" }),
    ], (id) => (id === "pod" ? "RunPod 4090" : null));
    expect(rows.map((r) => [r.label, r.meta, r.verb])).toEqual([
      ["Soft light · v2", "25 % of 48 MB · loras › a.safetensors · RunPod 4090", "show"],
      ["a.safetensors", "Cancelled. Nothing was kept of it. · loras", "download again"],
    ]);
  });

  it("says a LoRA's newer version on Civitai on its row, for Tab to fetch", () => {
    const newer = { folder: "loras", file: "soft_light.safetensors", modelId: 777, modelName: "Soft light", versionId: 1001, versionName: "v1", newer: { id: 1002, name: "v2", publishedAt: "", file: null, page: "https://civitai.com/models/777?modelVersionId=1002" }, checkedAt: "" } as UpdateRow;
    const d = {
      line: "lora:", parsed: parseSearch("lora:"), used: { loras: [{ file: "soft_light.safetensors", count: 3 }], models: [] }, families: [] as FamilyInfo[], drafts: [], places: [], prompts: [],
      found: undefined, count: undefined, loosen: undefined, placeOf: () => "", newer: (f: string) => (f === newer.file ? newer : undefined),
    } satisfies SearchData;
    const [loras] = valueRows(d, "lora", "");
    expect(loras!.rows[0]!.meta).toBe("3 renders · newer on Civitai: v2");
    expect(loras!.rows[0]!.value).toMatchObject({ kind: "lora", newer: { versionId: 1001 } });
  });

  it("reads `model updates`, apart from Afflatus's own updates", () => {
    for (const t of ["model updates", "lora updates", "newer models", "check my models"]) expect(parseCommand(t)).toEqual({ cmd: "model-updates" });
    expect(parseCommand("updates")).toEqual({ cmd: "check-updates" });
  });
});
