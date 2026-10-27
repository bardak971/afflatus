import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { CHECKPOINT, makeApp, post, referenceCatalog, type TestApp } from "./helpers";

// A job sent without a form (the API, a tool) starts on what its model file starts on, as the form would (card #125):
// sent through the API, a distilled Klein file rendered at the base model's 20 steps and CFG 5.

let fake: FakeComfy;
let t: TestApp;
const DMD = "zz-dmd2-merge.safetensors";

beforeEach(async () => {
  fake = await startFakeComfy({ catalog: referenceCatalog(), models: { checkpoints: [CHECKPOINT, DMD], loras: [], upscale_models: [] } });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const queued = async (input: Record<string, unknown>) => {
  const res = await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "a cat", ...input } });
  expect(res.statusCode).toBe(200);
  const row = await t.db.selectFrom("jobs").select("inputs").where("id", "=", res.json().ids[0]).executeTakeFirstOrThrow();
  return JSON.parse(row.inputs) as Record<string, unknown>;
};

describe("a job sent without a form starts on its model file's values", () => {
  it("takes the file's line where the form leaves an input out, and keeps what it sends", async () => {
    const lined = await queued({ checkpoint: DMD });
    expect(lined).toMatchObject({ steps: 8, cfg: 1, sampler: "lcm", scheduler: "sgm_uniform" });
    expect(await queued({ checkpoint: DMD, steps: 6 })).toMatchObject({ steps: 6, cfg: 1 });
    // a file of no line: the recipe's own defaults, as before
    const plain = await queued({ checkpoint: CHECKPOINT });
    expect(plain.steps).not.toBe(8);
  });

  it("takes what was saved for the file over its line", async () => {
    expect((await t.app.inject({ method: "PUT", url: "/api/model-settings", payload: { family: "sdxl", file: DMD, values: { steps: 10 } } })).statusCode).toBe(200);
    const saved = await queued({ checkpoint: DMD });
    expect(saved.steps).toBe(10);
    // with something saved the line no longer applies, as in the form
    expect(saved.cfg).not.toBe(1);
  });
});
