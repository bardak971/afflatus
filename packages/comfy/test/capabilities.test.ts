import { afterEach, describe, expect, it } from "vitest";
import { defineFamily, defineRecipe, GraphBuilder, type NodeCatalog } from "@studai/core";
import { ComfyClient, detect, scan } from "../src";
import { startFakeComfy, type FakeComfy } from "../src/testing";

const family = defineFamily({
  id: "toy", name: "Toy", summary: "", promptStyle: "tags", loraMatch: [],
  slots: [
    { id: "vae", label: "VAE", folder: "vae", detect: ["toy.*fp16", "toy"], hint: "put toy_vae.safetensors in models/vae" },
    { id: "turbo", label: "Turbo LoRA", folder: "loras", detect: ["toy.*turbo"], hint: "optional", optional: true },
  ],
});

interface ToyInput {
  prompt: string;
  model: string;
  sampler: string;
  sharp: boolean;
}
const recipe = defineRecipe<ToyInput>({
  id: "toy.make", family: "toy", version: 1, title: "Make", summary: "", output: "image",
  inputs: [
    { id: "prompt", type: "prompt", label: "Tags", style: "tags" },
    { id: "model", type: "model", label: "Model", folder: "checkpoints" },
    { id: "sampler", type: "choice", label: "Sampler", options: { node: "Sampler", input: "method" }, extra: ["auto"], default: "auto" },
    { id: "sharp", type: "toggle", label: "Sharper", default: false },
  ],
  nodes: (i) => ["Loader", "Sampler", ...(i.sharp ? ["Sharpen"] : [])],
  build(i) {
    const g = new GraphBuilder();
    // "auto" is the form's own word: the node is given one of its choices
    const out = g.add("Sampler", { model: g.out("Loader", { file: i.model }), method: i.sampler === "auto" ? "euler" : i.sampler });
    return { graph: g.graph, phases: g.phases, outputs: [{ node: out, kind: "image", role: "result" }], totalSteps: 1, loads: [] };
  },
  variants: [
    { name: "plain", input: { prompt: "a", model: "m" } },
    { name: "sharp", input: { prompt: "a", model: "m", sharp: true } },
  ],
});

const catalog: NodeCatalog = {
  Loader: { input: { required: { file: [["m.safetensors"]] } }, output: ["MODEL"] },
  Sampler: { input: { required: { model: ["MODEL", {}], method: [["euler", "heun"]] } }, output: ["IMAGE"] },
  Sharpen: { input: { required: {} }, output: ["IMAGE"] },
};

let fake: FakeComfy | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
const run = async (init: Parameters<typeof startFakeComfy>[0], overrides = {}) => {
  fake = await startFakeComfy(init);
  return scan(new ComfyClient(fake.url), [family], [recipe], overrides);
};

describe("detect", () => {
  it("tries the patterns in order", () => {
    expect(detect(["toy_vae.safetensors", "toy_vae_fp16.safetensors"], ["toy.*fp16", "toy"])).toBe("toy_vae_fp16.safetensors");
    expect(detect(["other.safetensors"], ["toy"])).toBeNull();
  });
});

describe("scan", () => {
  it("reports a ready recipe with what it offers", async () => {
    const s = await run({ catalog, models: { vae: ["toy_vae.safetensors"], loras: [], checkpoints: ["m.safetensors"] } });
    expect(s.comfy).toMatchObject({ online: true, device: "fake gpu", nodes: 3 });
    expect(s.families[0]!.slots.map((x) => [x.id, x.file])).toEqual([["vae", "toy_vae.safetensors"], ["turbo", null]]);
    expect(s.recipes[0]).toEqual({
      id: "toy.make", ready: true, missingNodes: [], missingSlots: [], emptyInputs: [], missingFiles: [], missing: [], problems: [], limitedBy: [],
      options: { model: ["m.safetensors"], sampler: ["auto", "euler", "heun"] },
    });
  });

  it("says what is missing: a required file, a model to pick, a node", async () => {
    const { Sampler: _gone, ...without } = catalog;
    const s = await run({ catalog: without, models: { vae: [], loras: [], checkpoints: [] } });
    expect(s.recipes[0]).toMatchObject({ ready: false, missingNodes: ["Sampler"], missingSlots: ["vae"], emptyInputs: ["model"] });
  });

  it("is not ready when ComfyUI would refuse its graph: a choice the node does not offer", async () => {
    const other: NodeCatalog = { ...catalog, Sampler: { input: { required: { model: ["MODEL", {}], method: [["heun", "dpm"]] } }, output: ["IMAGE"] } };
    const s = await run({ catalog: other, models: { vae: ["toy_vae.safetensors"], loras: [], checkpoints: ["m.safetensors"] } });
    expect(s.recipes[0]).toMatchObject({ ready: false, missingNodes: [] });
    expect(s.recipes[0]!.problems[0]).toMatch(/"euler" is not a choice of "method"/);
  });

  it("keeps a recipe ready when only an option's node is missing", async () => {
    const { Sharpen: _gone, ...without } = catalog;
    const s = await run({ catalog: without, models: { vae: ["toy_vae.safetensors"], loras: [], checkpoints: ["m.safetensors"] } });
    expect(s.recipes[0]).toMatchObject({ ready: true, limitedBy: ["Sharpen"] });
  });

  it("says when a file the recipe names itself is not on this ComfyUI", async () => {
    fake = await startFakeComfy({ catalog, models: { vae: ["toy_vae.safetensors"], loras: [], checkpoints: ["m.safetensors"] } });
    const named = { ...recipe, files: [{ classType: "Loader", input: "file", file: "m.safetensors" }, { classType: "Loader", input: "file", file: "gone.safetensors" }] };
    const s = await scan(new ComfyClient(fake.url), [family], [named]);
    expect(s.recipes[0]).toMatchObject({ ready: false, missingFiles: ["gone.safetensors"] });
  });

  it("uses a slot set by hand, unless that file is gone", async () => {
    const models = { vae: ["toy_vae.safetensors", "mine.safetensors"], loras: [], checkpoints: ["m.safetensors"] };
    expect((await run({ catalog, models }, { toy: { vae: "mine.safetensors" } })).families[0]!.slots[0]!.file).toBe("mine.safetensors");
    await fake!.close();
    expect((await run({ catalog, models }, { toy: { vae: "deleted.safetensors" } })).families[0]!.slots[0]!.file).toBe("toy_vae.safetensors");
  });

  it("only reads", async () => {
    await run({ catalog, models: { vae: [], loras: [], checkpoints: [] } });
    expect(fake!.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });

  it("reports an unreachable ComfyUI instead of throwing", async () => {
    const s = await scan(new ComfyClient("http://127.0.0.1:9"), [family], [recipe]);
    expect(s.comfy.online).toBe(false);
    expect(s.recipes).toEqual([]);
  });
});
