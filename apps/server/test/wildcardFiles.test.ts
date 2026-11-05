import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recipeById } from "@afflatus/recipes";
import { missingWildcards, NO_WILDCARDS, settleTexts, wildcardFolders } from "../src/wildcardFiles";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the wildcard folders", () => {
  it("are Afflatus's own first, then the packs' that are there, whatever the pack folder's case", async () => {
    dir = mkdtempSync(join(tmpdir(), "afflatus-wildf-"));
    const data = join(dir, "data");
    const comfy = join(dir, "ComfyUI");
    mkdirSync(join(data, "wildcards"), { recursive: true });
    mkdirSync(join(comfy, "custom_nodes", "comfyui-impact-pack", "custom_wildcards"), { recursive: true });
    mkdirSync(join(comfy, "custom_nodes", "comfyui-DynamicPrompts", "wildcards"), { recursive: true });
    // a pack the files are not read from
    mkdirSync(join(comfy, "custom_nodes", "other-pack", "wildcards"), { recursive: true });
    const folders = await wildcardFolders(data, comfy);
    expect(folders[0]).toEqual({ path: join(data, "wildcards"), from: "Afflatus" });
    expect(folders.slice(1).map((f) => f.path).sort()).toEqual([
      join(comfy, "custom_nodes", "comfyui-DynamicPrompts", "wildcards"),
      join(comfy, "custom_nodes", "comfyui-impact-pack", "custom_wildcards"),
    ].sort());
    // no data folder, no ComfyUI folder: none
    expect(await wildcardFolders(null, "")).toEqual([]);
  });
});

describe("the choices in a form's regions (card #300)", () => {
  const box = { x: 0, y: 0, w: 0.5, h: 1 };

  it("are settled as the prompt's are, each box's and a text box's letters, the same picks for the same seed", async () => {
    const moss = recipeById("moss.text-to-picture")!;
    const input = { prompt: "a {red|blue} poster", seed: 7, regions: [{ id: "a", box, prompt: "a {red|blue} coat" }, { id: "t", box, prompt: "{bold|thin} serif", kind: "text", text: "{OPEN|SHUT}" }] };
    const out = await settleTexts(NO_WILDCARDS, moss, input);
    const regions = out.regions as Array<{ prompt: string; text?: string }>;
    expect(regions[0]!.prompt).toMatch(/^a (red|blue) coat$/);
    expect(regions[1]!.prompt).toMatch(/^(bold|thin) serif$/);
    expect(regions[1]!.text).toMatch(/^(OPEN|SHUT)$/);
    expect(await settleTexts(NO_WILDCARDS, moss, input)).toEqual(out);
    // the form's own values are not changed in place
    expect(input.regions[0]!.prompt).toBe("a {red|blue} coat");
  });

  it("refuse a wildcard file that is not there, naming the region", async () => {
    const moss = recipeById("moss.text-to-picture")!;
    await expect(settleTexts(NO_WILDCARDS, moss, { prompt: "a", regions: [{ id: "a", box, prompt: "a __zz_test_nowhere__ coat" }] })).rejects.toThrow(/^Region 1: .*zz_test_nowhere/);
  });
});

describe("the wildcard names no file answers (card #318)", () => {
  it("are said of a prompt as it is written: a file of the name in any folder answers it", async () => {
    dir = mkdtempSync(join(tmpdir(), "afflatus-wildm-"));
    mkdirSync(join(dir, "wildcards", "clothes"), { recursive: true });
    writeFileSync(join(dir, "wildcards", "Colors.txt"), "red\nblue\n");
    writeFileSync(join(dir, "wildcards", "clothes", "hats.txt"), "beret\n");
    const places = { dataDir: dir, comfyDir: async () => "" };
    expect(await missingWildcards(places, "a __colors__ dress, __hats__, __clothes/hats__, __zz_test_nowhere__ and __ZZ_test_nowhere__")).toEqual(["zz_test_nowhere"]);
    expect(await missingWildcards(places, "no names, {a|b}")).toEqual([]);
    expect(await missingWildcards(NO_WILDCARDS, "__colors__")).toEqual(["colors"]);
  });
});
