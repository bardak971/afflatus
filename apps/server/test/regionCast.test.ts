import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inputFiles } from "@afflatus/core";
import { recipeById } from "@afflatus/recipes";
import { newId, now, OWNER } from "../src/db";
import { compose, regionCast } from "../src/entities";
import { CHECKPOINT, makeApp, post, type TestApp } from "./helpers";

/**
 * A cast person in a region (card #271): their words and LoRA go into their own box alone, never into the picture's prompt,
 * whether the region names them by id (dropped from the cast strip) or by "@Name" in its own words.
 */
let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function person(name: string, def: Record<string, unknown>) {
  const id = newId();
  await t.db.insertInto("entities").values({ id, owner_id: OWNER, kind: "person", name, def: JSON.stringify(def), created_at: now(), updated_at: now() }).execute();
  return id;
}

const box = { x: 0, y: 0, w: 0.5, h: 1 };

describe("the people of a form's regions", () => {
  it("bring their words and LoRA into their box alone, on SDXL", async () => {
    const mira = await person("zz-test Mira", { tags: "1girl, long red hair", sentence: "a woman with long red hair", models: { sdxl: { lora: "mira.safetensors", weight: 0.7, trigger: "mira_v1" } } });
    const nico = await person("zz-test Nico", { tags: "1boy, short dark hair", sentence: "a man" });
    const sdxl = recipeById("sdxl.text-to-picture")!;
    const { input } = await compose(t.db, sdxl, {
      prompt: "two people on a bench", checkpoint: CHECKPOINT,
      regions: [{ id: "a", box, prompt: "red coat", cast: mira }, { id: "b", box: { ...box, x: 0.5 }, prompt: "@zz_test_Nico in a blue coat" }],
    }, null);
    expect(input.prompt).toBe("two people on a bench");
    expect(input.loras ?? []).toEqual([]);
    expect(input.regions).toEqual([
      { id: "a", box, prompt: "mira_v1, 1girl, long red hair, red coat", cast: mira, castLora: { file: "mira.safetensors", weight: 0.7 } },
      { id: "b", box: { ...box, x: 0.5 }, prompt: "1boy, short dark hair, in a blue coat", cast: nico },
    ]);
  });

  it("are said in sentences on a model that reads them, and a region takes no LoRA where its model has none for it", async () => {
    const mira = await person("zz-test Mira", { sentence: "a woman with long red hair", models: { moss: { lora: "mira_moss.safetensors", weight: 0.8, trigger: "" } } });
    const moss = recipeById("moss.text-to-picture")!;
    const { input, added } = await compose(t.db, moss, { prompt: "a poster", regions: [{ id: "a", box, prompt: "holding a lantern", cast: mira }] }, null);
    expect(input.regions).toEqual([{ id: "a", box, prompt: "a woman with long red hair. holding a lantern", cast: mira, castLora: { file: "mira_moss.safetensors", weight: 0.8 } }]);
    expect(added.words).toEqual([{ from: "zz-test Mira", text: "a woman with long red hair", kind: "person" }]);
    expect(added.loras).toEqual([{ from: "zz-test Mira", file: "mira_moss.safetensors" }]);
  });

  it("ask a machine for their LoRAs as the form's own list does (a pod is sent them)", () => {
    const sdxl = recipeById("sdxl.text-to-picture")!;
    const asked = inputFiles(sdxl.inputs, { checkpoint: CHECKPOINT, loras: [], regions: [{ id: "a", box, prompt: "x", lora: { file: "coat.safetensors", weight: 0.6 }, castLora: { file: "mira.safetensors", weight: 0.7 } }, { id: "b", box, prompt: "y", lora: { file: "off.safetensors", weight: 0 } }] });
    expect(asked.filter((f) => f.folder === "loras")).toEqual([{ input: "loras", file: "coat.safetensors", folder: "loras", kind: "lora" }, { input: "loras", file: "mira.safetensors", folder: "loras", kind: "lora" }]);
  });

  it("drop a person deleted since they were cast, and a box left with nothing in it is no box (card #300)", async () => {
    const moss = recipeById("moss.text-to-picture")!;
    const { input } = await regionCast(t.db, moss, { prompt: "a", regions: [{ id: "a", box, prompt: "", cast: "zz-test-gone" }, { id: "b", box, prompt: "a lamp", cast: "zz-test-gone" }] });
    expect(input.regions).toEqual([{ id: "a", box, prompt: "" }, { id: "b", box, prompt: "a lamp" }]);
  });

  it("put nobody in a text box: it draws letters, its caption is how they look (card #300)", async () => {
    const mira = await person("zz-test Mira", { sentence: "a woman with long red hair", models: { moss: { lora: "mira_moss.safetensors", weight: 0.8, trigger: "" } } });
    const moss = recipeById("moss.text-to-picture")!;
    const text = { id: "t", box, prompt: "bold serif", kind: "text", text: "OPEN", cast: mira, castLora: { file: "x.safetensors", weight: 1 } };
    const { input, words, loras } = await regionCast(t.db, moss, { prompt: "a", regions: [text] });
    expect(input.regions).toEqual([{ id: "t", box, prompt: "bold serif", kind: "text", text: "OPEN" }]);
    expect(words).toEqual([]);
    expect(loras).toEqual([]);
  });

  it("leaves regions with nobody in them as they were", async () => {
    const sdxl = recipeById("sdxl.text-to-picture")!;
    const asked = { prompt: "a", regions: [{ id: "a", box, prompt: "@nobody waves" }] };
    expect((await regionCast(t.db, sdxl, asked)).input).toEqual(asked);
  });

  it("are worked in for a render sent with no cast picked, the job's prompt untouched by them", async () => {
    const mira = await person("zz-test Mira", { tags: "1girl, long red hair", models: { sdxl: { lora: "mira.safetensors", weight: 0.7, trigger: "" } } });
    await post(t.app, "/api/queue/pause", {});
    const sent = await post(t.app, "/api/jobs", { recipe: "sdxl.text-to-picture", input: { prompt: "a bench", checkpoint: CHECKPOINT, regions: [{ id: "a", box, prompt: "red coat", cast: mira }] } });
    expect(sent.statusCode, sent.body).toBe(200);
    const job = await t.db.selectFrom("jobs").select(["inputs"]).where("id", "=", sent.json().ids[0]).executeTakeFirstOrThrow();
    const inputs = JSON.parse(job.inputs);
    expect(inputs.prompt).toBe("a bench");
    expect(inputs.regions[0]).toMatchObject({ prompt: "1girl, long red hair, red coat", castLora: { file: "mira.safetensors", weight: 0.7 } });
  });

  it("shows MOSS-Image's layout as the prompt as sent, the person worked into their box", async () => {
    const mira = await person("zz-test Mira", { sentence: "a woman with long red hair" });
    const asked = (await post(t.app, "/api/form/prompt", { recipe: "moss.text-to-picture", input: { prompt: "a poster", size: { width: 1024, height: 1024 }, regions: [{ id: "a", box, prompt: "", cast: mira }] } })).json();
    expect(asked.into).toBeNull();
    expect(JSON.parse(asked.layout)).toEqual({
      summary: { caption: "a poster" }, items: [{ label: "character", caption: "a woman with long red hair", bbox: [-512, -512, 512, 0] }], bbox_coord_space: "abs_centralized", bbox_format: "yxyx",
    });
    // no layout without a region, nor on a form that has none
    expect((await post(t.app, "/api/form/prompt", { recipe: "moss.text-to-picture", input: { prompt: "a poster" } })).json().layout).toBeUndefined();
    expect((await post(t.app, "/api/form/prompt", { recipe: "sdxl.text-to-picture", input: { prompt: "a" } })).json()).toEqual({ into: null, text: "" });
  });
});
