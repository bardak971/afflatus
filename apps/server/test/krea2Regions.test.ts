import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { recipeById } from "@afflatus/recipes";
import { regionCast } from "../src/entities";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Krea 2's regions (card #271): a cast person in a box brings their words and their LoRA, held to that box by the regional
 * pack, as on the other families. Their picture is not sent: the pass that redrew each box's head from it was taken out
 * (2026-11-05), as it never made a person recognisable on a pod.
 */
let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({
    catalog: referenceCatalog(),
    models: {
      diffusion_models: ["krea2_turbo_fp8_scaled.safetensors"], text_encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vae: ["qwen_image_vae.safetensors"],
      loras: ["fabien_krea2.safetensors"], upscale_models: [],
    },
  });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const person = async (name: string, def: Record<string, unknown>) =>
  (await post(t.app, "/api/entities", { kind: "person", name, def: { sentence: `${name}, a man`, ...def } })).json().id as string;

const left = { x: 0, y: 0, w: 0.5, h: 1 };
const right = { x: 0.5, y: 0, w: 0.5, h: 1 };

describe("Krea 2's regions with cast people", () => {
  it("bring each person's words and LoRA into their box alone, and no picture of theirs", async () => {
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets?name=zz-test-a.png", headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, [200, 120, 40], [40, 60, 160])) })).json().id as string;
    const fabien = await person("zz-test Fabien", { pictures: [picture], models: { krea2: { lora: "fabien_krea2.safetensors", weight: 0.8, trigger: "" } } });
    const nicolas = await person("zz-test Nicolas", {});
    const krea2 = recipeById("krea2.text-to-picture")!;
    const regions = [{ id: "l", box: left, prompt: "in a grey coat", cast: fabien }, { id: "r", box: right, prompt: "in a blue jacket", cast: nicolas }];
    const cast = await regionCast(t.db, krea2, { prompt: "two friends in a park", regions });
    expect(cast.input.prompt).toBe("two friends in a park");
    expect(cast.input.regions).toEqual([
      { id: "l", box: left, prompt: "zz-test Fabien, a man. in a grey coat", cast: fabien, castLora: { file: "fabien_krea2.safetensors", weight: 0.8 } },
      { id: "r", box: right, prompt: "zz-test Nicolas, a man. in a blue jacket", cast: nicolas },
    ]);

    const sent = await post(t.app, "/api/jobs", { recipe: "krea2.text-to-picture", input: { prompt: "two friends in a park", regions } });
    expect(sent.statusCode, sent.body).toBe(200);
    await until(() => fake.prompts.size === 1);
    const graph = [...fake.prompts.values()][0]!;
    const of = (type: string) => Object.values(graph).filter((n) => n.class_type === type);
    // each box's words are its person's, read by its part of the picture alone; Fabien's LoRA gated to his box
    const boxes = of("Krea2RegionalPrompt");
    expect(boxes.map((n) => graph[(n.inputs.conditioning as [string, number])[0]]!.inputs.text)).toEqual([expect.stringContaining("zz-test Fabien"), expect.stringContaining("zz-test Nicolas")]);
    expect(graph[(boxes[0]!.inputs.loras as [string, number])[0]]!.inputs).toMatchObject({ lora_name: "fabien_krea2.safetensors", strength: 0.8 });
    expect(boxes[1]!.inputs.loras).toBeUndefined();
    // nothing of a pass from their picture: no upload, no Identity Edit
    expect(of("Krea2EditModelPatch")).toHaveLength(0);
    expect(of("LoadImage")).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
  });
});
