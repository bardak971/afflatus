import { describe, expect, it } from "vitest";
import type { Entity, FamilyInfo, Outfit, RecipeInfo } from "../src/api";
import { blankOutfit, outfitsOf } from "../src/screens/kit/shared";
import { bodyOf } from "../src/screens/kit/useEntityDraft";
import { presetGroups } from "../src/screens/kit/PresetList";

const outfit = (over: Partial<Outfit>): Outfit => ({ id: "o", name: "", tags: "", sentence: "", picture: null, ...over });

describe("an outfit that holds nothing", () => {
  it("is one with no name, no words and no picture", () => {
    expect(blankOutfit(outfit({}))).toBe(true);
    expect(blankOutfit(outfit({ name: "  " }))).toBe(true);
    expect(blankOutfit(outfit({ name: "Summer dress" }))).toBe(false);
    expect(blankOutfit(outfit({ tags: "white dress" }))).toBe(false);
    expect(blankOutfit(outfit({ picture: "p1" }))).toBe(false);
  });
  it("is not counted and not saved, while the others are", () => {
    const outfits = [outfit({ id: "a", name: "Summer dress" }), outfit({ id: "b" })];
    expect(outfitsOf(outfits).map((o) => o.id)).toEqual(["a"]);
    const person = { id: "p", kind: "person", name: " Her ", def: { pictures: [], tags: "", sentence: "", outfits } } as unknown as Entity;
    const body = bodyOf(person);
    expect(body.name).toBe("Her");
    expect((body.def as { outfits: Outfit[] }).outfits.map((o) => o.id)).toEqual(["a"]);
  });
});

describe("the presets' list order", () => {
  const families = [{ id: "sdxl", name: "SDXL" }, { id: "flux", name: "FLUX.1" }] as FamilyInfo[];
  const recipes = [{ id: "sdxl.t", family: "sdxl" }, { id: "flux.t", family: "flux" }] as RecipeInfo[];
  const preset = (id: string, recipe: string | null) => ({ id, kind: "preset", name: id, def: { recipe, inputs: {} } }) as unknown as Entity;
  it("groups by model as the families are listed, then any model, then a model no longer here", () => {
    const groups = presetGroups([preset("gone", "old.t"), preset("any", null), preset("f", "flux.t"), preset("s", "sdxl.t")], recipes, families);
    expect(groups.map((g) => g.key)).toEqual(["sdxl", "flux", "any", "gone"]);
    // the tab opens the first of them
    expect(groups[0]!.items[0]!.id).toBe("s");
  });
});
