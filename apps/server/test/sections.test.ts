import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { CHECKPOINT, makeApp, referenceCatalog, type TestApp } from "./helpers";

/** Saving a workflow whose form has sections: what they may point at. */
describe("saving a workflow with sections", () => {
  let fake: FakeComfy;
  let t: TestApp;
  beforeEach(async () => {
    fake = await startFakeComfy({ catalog: referenceCatalog() });
    t = await makeApp({ comfyUrl: fake.url });
  });
  afterEach(async () => {
    await t?.close();
    await fake?.close();
  });

  const graph = {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: CHECKPOINT } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "a parrot", clip: ["4", 1] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["6", 0], latent_image: ["5", 0] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "out" } },
  };
  const bindings = (sections: unknown[], toggles: unknown[] = []) => ({
    prompt: { node: "6", input: "text" }, seeds: [{ node: "3", input: "seed" }], loras: [],
    controls: [{ id: "ctl_3_steps", label: "Steps", target: { node: "3", input: "steps" }, kind: "number", default: 20, min: 1, max: 60, step: 1 }],
    toggles, sections, result: { node: "9", kind: "image", sound: false },
  });
  const save = (sections: unknown[], toggles: unknown[] = []) =>
    t.app.inject({ method: "POST", url: "/api/workflows", payload: { title: "Sections", model: "SDXL", graph, bindings: bindings(sections, toggles) } });

  it("takes sections that name its controls and switches, in any order", async () => {
    const toggle = { id: "sw_made_1", label: "Second pass", default: true, effects: [{ nodes: ["8"], activeWhen: true, mode: "bypass" }], writes: [], front: true, made: true };
    const res = await save([{ id: "sec_1", label: "Sampling", items: ["seed", { toggle: "sw_made_1", items: ["ctl_3_steps"] }] }], [toggle]);
    expect(res.statusCode, res.body).toBe(200);
    const def = (await t.app.inject({ method: "GET", url: `/api/workflows/${res.json().id}` })).json();
    expect(def.bindings.sections).toEqual([{ id: "sec_1", label: "Sampling", items: ["seed", { toggle: "sw_made_1", items: ["ctl_3_steps"] }] }]);
  });

  it("refuses a section whose switch is not in the mapping, or two sections of one id", async () => {
    const noSwitch = await save([{ id: "sec_1", label: "Sampling", items: [{ toggle: "sw_nowhere", items: [] }] }]);
    expect(noSwitch.statusCode).toBe(400);
    expect(noSwitch.json().error).toMatch(/switch that is not in the mapping/);
    const twice = await save([{ id: "sec_1", label: "A", items: [] }, { id: "sec_1", label: "B", items: [] }]);
    expect(twice.statusCode).toBe(400);
  });
});
