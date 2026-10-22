import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { missingNodesSaid, nodesOfPack, packOfNode } from "../src/packs";

describe("a node ComfyUI lacks", () => {
  it("is said as the pack to install, each pack once, and how", () => {
    const said = missingNodesSaid(["MMH3UltimateUpscale", "MMH3TemporalSplitParams"]);
    expect(said).toMatch(/^ComfyUI needs the node pack Comfyui-MMH3-UltimateUpscale: in ComfyUI-Manager/);
    expect(said).toMatch(/github\.com\/bbaudio-2025\/Comfyui-MMH3-UltimateUpscale/);
    expect(said.match(/Comfyui-MMH3-UltimateUpscale:/g)).toHaveLength(1);
    expect(said).toMatch(/Restart ComfyUI after installing\.$/);
  });

  it("names Afflatus's own pack by where it is installed from, and lists node types no known pack brings", () => {
    const said = missingNodesSaid(["AfflatusH3SeamLatent", "VHS_VideoCombine", "SomeOddNode"]);
    expect(said).toMatch(/\(1\) Afflatus's own node pack \(afflatus-nodes\): Settings → ComfyUI/);
    expect(said).toMatch(/\(2\) the node pack comfyui-videohelpersuite/);
    expect(said).toMatch(/It also lacks the node SomeOddNode: ComfyUI-Manager's "Install Missing Custom Nodes"/);
    expect(missingNodesSaid(["SomeOddNode"])).toMatch(/^ComfyUI is missing the node SomeOddNode/);
    expect(packOfNode("KSampler")).toBeUndefined();
  });
});

describe("Afflatus's own pack in the catalogue", () => {
  it("lists every node the pack registers, read from its files (deprecated ones too)", () => {
    const dir = fileURLToPath(new URL("../../../comfy-nodes/afflatus-nodes/", import.meta.url));
    const registered = readdirSync(dir).filter((f) => f.endsWith(".py")).flatMap((f) => [...readFileSync(dir + f, "utf8").matchAll(/node_id\s*=\s*"([^"]+)"/g)].map((m) => m[1]!));
    expect(registered.length).toBeGreaterThan(15);
    expect(registered.filter((n) => !nodesOfPack("afflatus-nodes").includes(n))).toEqual([]);
    expect(packOfNode("AfflatusSwapPaste")?.own).toBe(true);
  });
});
