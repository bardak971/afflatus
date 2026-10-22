import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isNvidiaRtx, missingNodesSaid, nodesOfPack, packOfNode } from "../src/packs";

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

describe("an NVIDIA RTX card, by the name ComfyUI gives its device", () => {
  // the names as /system_stats has them (review of 0.6.0, N-13: an MX450, a 940MX, a Turing T1000 or a mining card were
  // taken for RTX ones, and offered RTX VSR they cannot run)
  const said = (name: string) => `cuda:0 ${name} : cudaMallocAsync`;
  it.each([
    "NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 3060", "NVIDIA GeForce RTX 4060 Laptop GPU", "NVIDIA RTX A6000", "Quadro RTX 4000",
    "NVIDIA RTX 2000 Ada Generation", "NVIDIA TITAN RTX", "NVIDIA A40", "NVIDIA L40S", "NVIDIA A100-SXM4-80GB", "NVIDIA H100 80GB HBM3",
    "NVIDIA L4", "Tesla T4", "NVIDIA A10G",
  ])("%s is one", (name) => expect(isNvidiaRtx(said(name))).toBe(true));
  it.each([
    "NVIDIA GeForce GTX 1080 Ti", "NVIDIA GeForce GT 1030", "NVIDIA GeForce MX450", "NVIDIA GeForce MX 450", "NVIDIA GeForce 940MX",
    "Quadro GP100", "Quadro GV100", "Quadro P4000", "Quadro T1000", "NVIDIA T400", "NVIDIA T1000 8GB", "NVIDIA T1200 Laptop GPU",
    "NVIDIA P102-100", "NVIDIA CMP 30HX", "Tesla V100-SXM2-16GB", "Tesla P100-PCIE-16GB", "NVIDIA TITAN V", "NVIDIA TITAN Xp",
    "AMD Radeon RX 7900 XTX",
  ])("%s is not", (name) => expect(isNvidiaRtx(said(name))).toBe(false));
});
