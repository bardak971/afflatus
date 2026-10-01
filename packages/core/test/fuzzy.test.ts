import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../src";

const files = ["Illustrious XL v1", "illustriousAnime_epitaph", "NoobAI XL", "ponyDiffusionV6XL", "flux-2-klein-base-4b", "Détails fins"];
const find = (q: string) => fuzzyFilter(files, q, (f) => f);

describe("fuzzy search", () => {
  it("finds what was typed exactly, whatever the case", () => {
    expect(find("noob")).toEqual(["NoobAI XL"]);
    expect(find("XL")).toHaveLength(4);
  });

  it("finds letters typed in order, with other letters between", () => {
    expect(find("ilxl")).toEqual(["Illustrious XL v1"]);
    expect(find("pnyv6")).toEqual(["ponyDiffusionV6XL"]);
    expect(find("klein4b")).toEqual(["flux-2-klein-base-4b"]);
  });

  it("takes several words in any order", () => {
    expect(find("xl illus")).toEqual(["Illustrious XL v1"]);
    expect(find("epitaph illustrious")).toEqual(["illustriousAnime_epitaph"]);
  });

  it("puts the closest first: the start of the name, then the start of a word, then anywhere", () => {
    expect(fuzzyFilter(["my anime mix", "anime_base", "superanime"], "anime", (f) => f)).toEqual(["anime_base", "my anime mix", "superanime"]);
    // typed as it is beats letters picked out along the name
    expect(fuzzyFilter(["a-n-i-m-e spread", "anime"], "anime", (f) => f)[0]).toBe("anime");
  });

  it("does not count accents", () => {
    expect(find("details")).toEqual(["Détails fins"]);
  });

  it("gives everything back, in order, when nothing is typed", () => {
    expect(find("  ")).toEqual(files);
  });

  it("does not match letters that only happen to appear far apart", () => {
    expect(fuzzyScore("zzz", "Illustrious XL")).toBeNull();
    expect(fuzzyScore("flux", "a very long name where f then l then u then x appear only by chance, far from each other")).toBeNull();
  });
});
