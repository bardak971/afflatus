import { afterEach, describe, expect, it } from "vitest";
import { defineFamily, defineRecipe, GraphBuilder, type NodeCatalog } from "@afflatus/core";
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
      // the files its family uses here, for the settings the form starts by them: only those found
      slots: { vae: "toy_vae.safetensors" },
    });
  });

  it("marks a recipe that cannot say what it needs not ready, with its error, and still scans the others", async () => {
    const broken = defineRecipe<ToyInput>({ ...recipe, id: "toy.broken", nodes: () => { throw new Error("an unknown Director version"); } });
    fake = await startFakeComfy({ catalog, models: { vae: ["toy_vae.safetensors"], loras: [], checkpoints: ["m.safetensors"] } });
    const s = await scan(new ComfyClient(fake.url), [family], [broken, recipe]);
    expect(s.recipes.map((r) => [r.id, r.ready])).toEqual([["toy.broken", false], ["toy.make", true]]);
    expect(s.recipes[0]!.problems).toEqual(["an unknown Director version"]);
  });

  it("offers no download for a file only hidden recipes use (review K-9)", async () => {
    const get = { file: "toy_swap.safetensors", url: "https://example.com/toy_swap.safetensors" };
    const withSwap = defineFamily({ ...family, slots: [...family.slots, { id: "swap", label: "Swap LoRA", folder: "loras", detect: ["toy.*swap"], hint: "for Swap", optional: true, get, onlyFor: ["toy.swap"] }] });
    const swap = defineRecipe<ToyInput>({ ...recipe, id: "toy.swap", hidden: true });
    fake = await startFakeComfy({ catalog, models: { vae: ["toy_vae.safetensors"], loras: [], checkpoints: ["m.safetensors"] } });
    const hidden = await scan(new ComfyClient(fake.url), [withSwap], [recipe, swap]);
    expect(hidden.families[0]!.slots.find((x) => x.id === "swap")!.get).toBeUndefined();
    // shown again, it is offered again
    const shown = await scan(new ComfyClient(fake.url), [withSwap], [recipe, { ...swap, hidden: undefined }]);
    expect(shown.families[0]!.slots.find((x) => x.id === "swap")!.get).toEqual(get);
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

  it("takes a file for the family when its weights say so, whatever its name; a file known to be another family's goes last", async () => {
    const big = defineFamily({
      id: "big", name: "Big", summary: "", promptStyle: "sentences", loraMatch: [],
      slots: [{ id: "unet", label: "Diffusion model", folder: "diffusion_models", detect: ["big"], hint: "put big.safetensors in models/diffusion_models" }],
    });
    const make = defineRecipe<ToyInput>({
      ...recipe, id: "big.make", family: "big",
      inputs: recipe.inputs.map((i) => (i.id === "model" ? { id: "model", type: "model", label: "Model", folder: "diffusion_models", slot: "unet", match: ["big"] } : i)),
    });
    const files = ["nameless_v3.safetensors", "big_fp8.safetensors", "someone_else.safetensors", "mystery.safetensors"];
    fake = await startFakeComfy({ catalog, models: { vae: [], loras: [], checkpoints: [], diffusion_models: files } });
    const known: Record<string, { base?: string }> = { "nameless_v3.safetensors": { base: "Big" }, "someone_else.safetensors": { base: "SDXL" }, "mystery.safetensors": {} };
    const s = await scan(new ComfyClient(fake.url), [big], [make], {}, (folder, file) => (folder === "diffusion_models" ? known[file] : undefined));
    // the slot: the name wins for the default; the nameless file is a choice all the same
    expect(s.families[0]!.slots[0]).toMatchObject({ file: "big_fp8.safetensors", choices: ["big_fp8.safetensors", "nameless_v3.safetensors"] });
    // the form: the usual file, the named one, the one the weights vouch for, the unknown, and the other family's last
    expect(s.recipes[0]!.options.model).toEqual(["big_fp8.safetensors", "nameless_v3.safetensors", "mystery.safetensors", "someone_else.safetensors"]);
    // with no named file at all, the weights pick the slot's default
    await fake.close();
    fake = await startFakeComfy({ catalog, models: { vae: [], loras: [], checkpoints: [], diffusion_models: ["nameless_v3.safetensors", "mystery.safetensors"] } });
    const t = await scan(new ComfyClient(fake.url), [big], [make], {}, (_f, file) => known[file]);
    expect(t.families[0]!.slots[0]!.file).toBe("nameless_v3.safetensors");
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

describe("scan, what is kept between scans", () => {
  const fakes: FakeComfy[] = [];
  afterEach(async () => {
    await Promise.all(fakes.splice(0).map((f) => f.close()));
  });
  /** The toy recipe, counting how often it is built: readiness builds its plain form once per node list. */
  const counted = () => {
    const r = { ...recipe, id: "toy.counted", built: 0 };
    r.build = (i, ctx) => {
      r.built++;
      return recipe.build(i, ctx);
    };
    return r;
  };
  const machine = async (nodes: NodeCatalog) => {
    const f = await startFakeComfy({ catalog: nodes, models: { checkpoints: ["m.safetensors"], vae: ["toy_vae.safetensors"] } });
    fakes.push(f);
    return new ComfyClient(f.url);
  };

  it("works a recipe's readiness out once for machines with the same node list, and again for another list", async () => {
    const r = counted();
    const [a, b] = await Promise.all([machine(catalog), machine(catalog)]);
    const [sa, sb] = await Promise.all([scan(a, [family], [r]), scan(b, [family], [r])]);
    expect(r.built).toBe(1);
    expect(sa.recipes[0]!.ready).toBe(true);
    expect(sb.recipes[0]).toEqual(sa.recipes[0]);
    // the same machine asked again: nothing built
    await scan(a, [family], [r]);
    expect(r.built).toBe(1);
    // a machine without the sampler's "heun": another list, worked out on its own
    const other = await machine({ ...catalog, Sampler: { input: { required: { model: ["MODEL", {}], method: [["euler"]] } }, output: ["IMAGE"] } });
    await scan(other, [family], [r]);
    expect(r.built).toBe(2);
  });

  it("takes the node list it is given instead of fetching it", async () => {
    const client = await machine(catalog);
    const s = await scan(client, [family], [recipe], {}, undefined, async () => catalog);
    expect(s.recipes[0]!.ready).toBe(true);
    expect(fakes[0]!.calls).not.toContain("GET /object_info");
    expect(fakes[0]!.calls).toContain("GET /models/checkpoints");
  });
});
