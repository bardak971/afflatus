import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { wildcardFolders } from "../src/wildcardFiles";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
