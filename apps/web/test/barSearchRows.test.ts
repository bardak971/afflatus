import { describe, expect, it } from "vitest";
import type { FamilyInfo } from "../src/api";
import type { Item } from "../src/bar/items";
import { prepare } from "../src/bar/match";
import { parseSearch } from "../src/bar/search";
import { filterOf, keyRows, loosened, resultSections, valueRows, type SearchData } from "../src/bar/searchRows";

const families = [{ id: "klein", name: "FLUX.2 Klein" }, { id: "sdxl", name: "SDXL" }] as FamilyInfo[];
const used = {
  loras: [{ file: "loras/warm_light_v2.safetensors", count: 12 }, { file: "film-grain.safetensors", count: 1 }],
  models: [{ file: "illustrious-xl.safetensors", count: 30 }],
};
const place = (kind: "project" | "folder", id: string, label: string, inbox?: true): Item => ({
  key: `${kind}:${id}`, kind, label, meta: "", group: "Projects & folders", verb: "open", p: prepare(label), ...(inbox ? { inbox } : {}),
  entry: (kind === "project" ? { kind, id, label, updatedAt: "" } : { kind, id, label, project: "p1", updatedAt: "" }) as Item["entry"],
});
const places = [place("project", "none", "Inbox", true), place("project", "p1", "Showcase"), place("folder", "f1", "night shots")];
const drafts: Item[] = [{ key: "draft:d1", kind: "draft", label: "Harbor walk", meta: "", group: "Drafts", verb: "open", p: prepare("Harbor walk"), entry: { kind: "draft", id: "d1", label: "Harbor walk", updatedAt: "" } as Item["entry"] }];
const of = (line: string) => filterOf({ parsed: parseSearch(line, ["klein", "sdxl"]), used, families, drafts, places });

describe("the render search's keys as the library's list query", () => {
  it("asks for every project's renders, of a kind, with the words in name and prompt", () => {
    expect(of("video: harbor").filter).toEqual({ all: true, kind: "video", q: "harbor" });
    expect(of("sound:").filter.kind).toBe("audio");
    expect(of('prompt:"red bicycle" studio').filter.q).toBe("studio red bicycle");
  });

  it("finds a LoRA, a model and a place by part of their name", () => {
    expect(of("lora:warm").filter.lora).toBe("loras/warm_light_v2.safetensors");
    expect(of("model:klein").filter.family).toBe("klein");
    expect(of("model:flux.2").filter.family).toBe("klein");
    expect(of("model:illustrious").filter.model).toBe("illustrious-xl.safetensors");
    expect(of("in:show").filter.project).toBe("p1");
    expect(of("in:night").filter.folder).toBe("f1");
    expect(of("in:inbox").filter.project).toBe("none");
    expect(of("draft:harbor").filter.draft).toBe("d1");
  });

  it("says a value that names nothing, and a minus it cannot read", () => {
    expect(of("lora:zzz").missing.map((t) => t.key)).toEqual(["lora"]);
    expect(of("since:soon").missing.map((t) => t.key)).toEqual(["since"]);
    expect(of("-lora:warm").unsupported.map((t) => t.key)).toEqual(["lora"]);
    expect(of("-kept").filter.unkept).toBe(true);
  });

  it("takes one key off at a time for the counts of what nothing matched", () => {
    const parts = loosened({ parsed: parseSearch("video: kept harbor"), used, families, drafts, places });
    expect(parts.map((p) => (p.token === "words" ? "words" : p.token.key))).toEqual(["video", "kept", "words"]);
    expect(parts[0]!.filter).toEqual({ all: true, kept: true, q: "harbor" });
    expect(parts[2]!.filter).toEqual({ all: true, kind: "video", kept: true });
  });
});

describe("the render search's rows", () => {
  const data = (line: string, over: Partial<SearchData> = {}): SearchData => ({
    line, parsed: parseSearch(line), used, families, drafts, places, prompts: [], found: undefined, count: undefined, loosen: undefined, placeOf: () => "", ...over,
  });

  it("offers the keys a name begins, each writing its key", () => {
    expect(keyRows("image: lo", "lo").map((r) => [r.label, r.complete])).toEqual([["lora:", "image: lora:"]]);
  });

  it("lists a key's values, the most used first, each writing its value and naming what Tab acts on", () => {
    const [loras] = valueRows(data("lora:"), "lora", "");
    expect(loras!.rows.map((r) => [r.label, r.meta, r.complete])).toEqual([["warm_light_v2", "12 renders", "lora:warm_light_v2 "], ["film-grain", "1 render", "lora:film-grain "]]);
    expect(loras!.rows[0]!.value).toEqual({ kind: "lora", file: "loras/warm_light_v2.safetensors" });
    const [fams] = valueRows(data("model:kl"), "model", "kl");
    expect(fams!.rows.map((r) => r.complete)).toEqual(["model:klein "]);
    expect(valueRows(data('in:"night'), "in", "night")[0]!.rows.map((r) => r.complete)).toEqual(['in:"night shots" ']);
  });

  it("says nothing matched, and which key to take off, by how much each would find", () => {
    const d = data("video: kept harbor", { found: [], count: 0, loosen: [{ token: parseSearch("video: kept harbor").tokens[1]!, count: 4 }, { token: "words", count: 0 }] });
    const out = resultSections(d, [], []);
    expect(out.map((s) => s.group)).toEqual(["No render has all of these", "Without one of them"]);
    expect(out[1]!.rows.map((r) => [r.label, r.meta, r.complete])).toEqual([["Without kept", "4 renders", "video: harbor"]]);
  });

  it("names the key that finds nothing, Enter taking it off", () => {
    const d = data("image: lora:zzz harbor");
    const out = resultSections(d, [d.parsed.tokens[1]!], []);
    expect(out[0]!.rows.map((r) => [r.label, r.complete])).toEqual([["No lora called “zzz”", "image: harbor"]]);
  });
});
