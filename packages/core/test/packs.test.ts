import { describe, expect, it } from "vitest";
import { missingNodesSaid, packOfNode } from "../src/packs";

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
