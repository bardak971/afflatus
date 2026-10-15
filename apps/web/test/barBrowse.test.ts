import { describe, expect, it } from "vitest";
import type { BrowseBases, BrowseCard } from "../src/api";
import { askSaid, parseBrowse, siteQuery, toFind } from "../src/bar/browseSearch";
import { browseRows, browseValueRows } from "../src/bar/modelRows";
import { parseCommand } from "../src/bar/parse";

const families: BrowseBases["families"] = [
  { id: "klein", name: "FLUX.2 Klein", on: true, bases: ["Flux.2 Klein 9B", "Flux.2 Klein 4B"], hf: ["black-forest-labs/FLUX.2-klein-9B"] },
  { id: "wan", name: "Wan 2.2", on: true, bases: ["Wan Video 2.2 I2V-A14B"], hf: ["Wan-AI/Wan2.2-I2V-A14B"] },
  { id: "sdxl", name: "SDXL", on: false, bases: ["SDXL 1.0"], hf: [] },
];

describe("Civitai and Hugging Face searched from the bar", () => {
  it("is a search of a site only with civitai: or hf: in the line, anywhere", () => {
    expect(parseBrowse("soft light lora", families)).toBeNull();
    expect(parseBrowse("soft light civitai:", families)).toMatchObject({ site: "civitai", words: "soft light" });
    expect(parseBrowse("hf:wan lightning", families)).toMatchObject({ site: "huggingface", words: "wan lightning" });
  });

  it("reads the browser's filters as keys, and says the ones it cannot", () => {
    const a = parseBrowse("civitai: handheld type:lora base:wan sort:new period:week by:@maker all", families)!;
    expect(a).toMatchObject({ words: "handheld", types: ["LORA"], families: ["wan"], bases: ["Wan Video 2.2 I2V-A14B"], sort: "Newest", period: "Week", by: "maker", all: true, unknown: [] });
    // a family by part of its name; `new` bare is the newest
    expect(parseBrowse("civitai: new base:klein", families)).toMatchObject({ sort: "Newest", families: ["klein"] });
    expect(parseBrowse("civitai: type:zzz base:nope sort:loudest", families)!.unknown).toEqual(["type:zzz", "base:nope", "sort:loudest"]);
    // sort: by Hugging Face's own names there
    expect(parseBrowse("hf: wan sort:liked kind:loras base:wan", families)).toMatchObject({ sort: "likes", hfKind: "loras", hfBase: "Wan-AI/Wan2.2-I2V-A14B" });
  });

  it("knows which key's value is being typed", () => {
    expect(parseBrowse("civitai: soft type:lo", families)!.typing).toEqual({ key: "type", value: "lo" });
    expect(parseBrowse("civitai: soft type:lora ", families)!.typing).toBeNull();
  });

  it("opens Find models on what the bar asked: every filter said, the defaults where the bar said none", () => {
    expect(toFind(parseBrowse("civitai: handheld type:lora base:wan", families)!)).toEqual({ tab: "civitai", words: "handheld", by: "", types: ["LORA"], chosenFamilies: ["wan"], sort: "Most Downloaded", period: "AllTime" });
    expect(toFind(parseBrowse("hf: wan", families)!)).toEqual({ tab: "huggingface", words: "wan", by: "", hfBase: "", hfKind: "comfyui", hfSort: "downloads" });
    // the bar asks the site the same: without base:, the bases of the user's families that are on
    expect(siteQuery(parseBrowse("civitai: handheld", families)!, families)).toMatchObject({ site: "civitai", bases: ["Flux.2 Klein 9B", "Flux.2 Klein 4B", "Wan Video 2.2 I2V-A14B"], sort: "Most Downloaded" });
    expect(askSaid(parseBrowse("civitai: handheld type:lora base:klein by:maker", families)!, families)).toBe("“handheld” · LORA · FLUX.2 Klein · by maker");
  });

  it("lists Find models on the search first, then what it found, then a filter it could not read", () => {
    const card = { site: "civitai", id: "77", name: "Handheld Camera", type: "LORA", base: "Wan Video 2.2 I2V-A14B", creator: "maker", downloads: 1400, have: true, update: null, gated: false, versions: [] } as unknown as BrowseCard;
    const [s] = browseRows(parseBrowse("civitai: handheld type:zzz", families)!, [card], families);
    expect(s!.group).toBe("Civitai");
    expect(s!.rows.map((r) => [r.label, r.meta])).toEqual([
      ["Find models on Civitai", "“handheld”"],
      ["type:zzz is not read", "type: takes lora, checkpoint, vae, upscaler, controlnet, textencoder, unet, dora, locon"],
      ["Handheld Camera", "LORA · Wan Video 2.2 I2V-A14B · by maker · 1 thousand downloads · you have it"],
    ]);
  });

  it("offers a key's values while it is typed, each writing itself in the line", () => {
    const line = "civitai: soft type:lo";
    const [s] = browseValueRows(line, parseBrowse(line, families)!, families);
    expect(s!.rows.map((r) => [r.label, r.complete])).toEqual([["type:lora", "civitai: soft type:lora "], ["type:locon", "civitai: soft type:locon "]]);
    const bases = browseValueRows("hf: base:", parseBrowse("hf: base:", families)!, families)[0]!.rows.map((r) => r.label);
    expect(bases).toEqual(["base:klein", "base:wan"]);
  });

  it("reads `picked` and `get missing files`", () => {
    expect(parseCommand("picked")).toEqual({ cmd: "picked" });
    expect(parseCommand("picked files")).toEqual({ cmd: "picked" });
    for (const t of ["get missing files", "download missing models", "fetch the missing files"]) expect(parseCommand(t)).toEqual({ cmd: "get-missing" });
  });
});
