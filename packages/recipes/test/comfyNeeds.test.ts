import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { comfyOlderThan, comfySince, comfyTooOld, isCoreNode, tooOldSaid, parseInput, slowQuantKernels, torchBuild } from "@afflatus/core";
import { families, recipes } from "../src";

/** The node catalog in reference/, with where each node comes from (ComfyUI's own nodes.py and comfy_extras, or a custom pack). */
const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../reference/comfy-object-info.json", import.meta.url)), "utf-8")) as Record<string, { python_module?: string }>;

/** Every node type a recipe can send: its plainest form's, its options', and the extras it takes when there. */
const used = [...new Set(recipes.flatMap((r) => [...r.variants.flatMap((v) => r.nodes(parseInput(r, v.input))), ...(r.optionalNodes ?? [])]))];

describe("ComfyUI's own nodes, and the release each came with", () => {
  it("knows every node of ComfyUI's own a recipe uses, and takes no custom pack's node for one", () => {
    for (const n of used) {
      const module = catalog[n]?.python_module;
      if (!module) continue;
      expect(isCoreNode(n), `${n} (${module})`).toBe(!module.startsWith("custom_nodes"));
    }
  });

  it("says the newest release among nodes, and nothing for a pack's", () => {
    expect(comfySince(["KSampler", "MiniMaxH3ImageToVideo", "LTXVDualCFGGuider"])).toBe("0.32.0");
    expect(comfySince(["VHS_VideoCombine", "AfflatusFaceMatch"])).toBeNull();
  });

  it("judges only a plain release: unknown, a fake's or a fork's scheme is taken as new enough", () => {
    expect(comfyOlderThan("0.3.10", "0.30.0")).toBe(true);
    expect(comfyOlderThan("v0.41.2", "0.35.0")).toBe(false);
    expect(comfyOlderThan("0.35.0", "0.35.0")).toBe(false);
    for (const v of ["unknown", "0.0.0-fake", "0.41.2-dev", "", null, undefined]) expect(comfyOlderThan(v, "0.30.0"), String(v)).toBe(false);
  });
});

describe("the families a ComfyUI is too old for", () => {
  const names = (v: string) => comfyTooOld(v, families, recipes)?.families.map((f) => f.id) ?? [];

  it("flags the video families on an early-2025 ComfyUI and runs SDXL, FLUX and Z-Image as they are", () => {
    const old = comfyTooOld("0.3.10", families, recipes)!;
    expect(old.families.map((f) => f.id)).toEqual(expect.arrayContaining(["h3", "ltx", "ltx25", "qwen21", "klein", "wan", "qwen"]));
    expect(names("0.3.10")).not.toContain("sdxl");
    expect(names("0.3.10")).not.toContain("zimage");
    expect(old.families.find((f) => f.id === "h3")).toMatchObject({ name: "MiniMax H3", needs: "0.35.0", only: null });
    expect(old.needs).toBe("0.37.0");
  });

  it("names the forms a family runs only in part (H3's Motion transfer needs 0.35, its others 0.30)", () => {
    const h3 = comfyTooOld("0.34.0", families, recipes)!.families.find((f) => f.id === "h3")!;
    expect(h3.needs).toBe("0.35.0");
    expect(h3.only).toEqual([recipes.find((r) => r.id === "h3.motion")!.title]);
    expect(tooOldSaid(comfyTooOld("0.34.0", families, recipes)!)).toBe("Qwen Image 2.1, MiniMax H3 (Motion transfer)");
    // a family it runs a little of says how many of its forms it cannot, past two
    expect(tooOldSaid(comfyTooOld("0.3.10", families, recipes)!)).toMatch(/FLUX\.2 Klein \(\d of \d forms\)/);
  });

  it("says nothing of a ComfyUI that runs everything, or one whose version cannot be judged", () => {
    expect(comfyTooOld("0.42.5", families, recipes)).toBeNull();
    expect(comfyTooOld("0.0.0-fake", families, recipes)).toBeNull();
    expect(comfyTooOld("unknown", families, recipes)).toBeNull();
  });

  it("finds the pod image's ComfyUI new enough for every family", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../../deploy/runpod/base/Dockerfile", import.meta.url)), "utf-8");
    const pinned = /^ARG COMFYUI_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(pinned).toBeTruthy();
    expect(comfyTooOld(pinned!, families, recipes)).toBeNull();
  });
});

describe("the PyTorch a ComfyUI runs on", () => {
  it("reads its version and the CUDA it was built for", () => {
    expect(torchBuild("2.10.0+cu130")).toEqual({ torch: "2.10.0", cuda: "13.0" });
    expect(torchBuild("2.7.1+cu128")).toEqual({ torch: "2.7.1", cuda: "12.8" });
    expect(torchBuild("2.4.0+cu121")).toEqual({ torch: "2.4.0", cuda: "12.1" });
    expect(torchBuild("2.3.1+cu118")).toEqual({ torch: "2.3.1", cuda: "11.8" });
    expect(torchBuild("2.6.0+rocm6.2.4")).toEqual({ torch: "2.6.0", cuda: null });
    expect(torchBuild("2.5.1")).toEqual({ torch: "2.5.1", cuda: null });
    expect(torchBuild("2.9.0.dev20250801+cu130")).toEqual({ torch: "2.9.0", cuda: "13.0" });
    expect(torchBuild(undefined)).toBeNull();
    expect(torchBuild("not a version")).toBeNull();
  });

  it("says a CUDA older than 13 runs the int8 and NVFP4 files without ComfyUI's kernels, and nothing of 13 or a non-CUDA build", () => {
    expect(slowQuantKernels(torchBuild("2.7.1+cu128"))).toBe(true);
    expect(slowQuantKernels(torchBuild("2.10.0+cu130"))).toBe(false);
    expect(slowQuantKernels(torchBuild("2.6.0+rocm6.2.4"))).toBe(false);
    expect(slowQuantKernels(null)).toBe(false);
  });
});
