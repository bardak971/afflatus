import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePng, startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { recipeById } from "@afflatus/recipes";
import { regionCast } from "../src/entities";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * Krea 2's regions (card #271): a cast person in a box brings their picture too, the clearest of theirs, which goes up to
 * ComfyUI under the box's key and is the one their box is redrawn from (Identity Edit), each person their own.
 */
let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({
    catalog: referenceCatalog(),
    models: {
      diffusion_models: ["krea2_turbo_fp8_scaled.safetensors"], text_encoders: ["qwen3vl_4b_fp8_scaled.safetensors"], vae: ["qwen_image_vae.safetensors"],
      loras: ["krea2_identity_edit_v2_r128.safetensors"], upscale_models: [],
    },
  });
  t = await makeApp({ comfyUrl: fake.url });
  await t.services.queue.start();
});
afterEach(async () => {
  await t.close();
  await fake.close().catch(() => {});
});

const picture = async (name: string, rgb: [number, number, number]) =>
  (await t.app.inject({ method: "POST", url: `/api/assets?name=${name}`, headers: { "content-type": "image/png" }, payload: Buffer.from(makePng(64, 96, rgb, [40, 60, 160])) })).json().id as string;
const person = async (name: string, pictures: string[]) =>
  (await post(t.app, "/api/entities", { kind: "person", name, def: { pictures, sentence: `${name}, a man` } })).json().id as string;

const left = { x: 0, y: 0, w: 0.5, h: 1 };
const right = { x: 0.5, y: 0, w: 0.5, h: 1 };

describe("Krea 2's regions with cast people", () => {
  it("give each box its person's picture, never on a model whose regions take none", async () => {
    const [a, b] = [await picture("zz-test-a.png", [200, 120, 40]), await picture("zz-test-b.png", [20, 160, 90])];
    const fabien = await person("zz-test Fabien", [a]);
    const sdxl = recipeById("sdxl.text-to-picture")!;
    const krea2 = recipeById("krea2.text-to-picture")!;
    const regions = [{ id: "l", box: left, prompt: "in a grey coat", cast: fabien }];
    expect((await regionCast(t.db, krea2, { prompt: "a", regions })).input.regions).toMatchObject([{ id: "l", cast: fabien, castPicture: a }]);
    expect(((await regionCast(t.db, sdxl, { prompt: "a", regions })).input.regions as Array<Record<string, unknown>>)[0]!.castPicture).toBeUndefined();
    // a picture the form sent itself is not taken: the server puts the person's own
    const forged = [{ ...regions[0], castPicture: b }];
    expect((await regionCast(t.db, krea2, { prompt: "a", regions: forged })).input.regions).toMatchObject([{ castPicture: a }]);
  });

  it("send each person's picture to ComfyUI and redraw their box from it, each their own", async () => {
    const [a, b] = [await picture("zz-test-a.png", [200, 120, 40]), await picture("zz-test-b.png", [20, 160, 90])];
    const [fabien, nicolas] = [await person("zz-test Fabien", [a]), await person("zz-test Nicolas", [b])];
    const sent = await post(t.app, "/api/jobs", {
      recipe: "krea2.text-to-picture",
      input: { prompt: "two friends in a park", regions: [{ id: "l", box: left, prompt: "in a grey coat", cast: fabien }, { id: "r", box: right, prompt: "in a blue jacket", cast: nicolas }] },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    await until(() => fake.prompts.size === 1);
    const graph = [...fake.prompts.values()][0]!;
    const patches = Object.values(graph).filter((n) => n.class_type === "Krea2EditModelPatch");
    expect(patches).toHaveLength(2);
    // through Afflatus's Face Crop where the ComfyUI has it
    const sentAs = (id: string): unknown => (graph[id]!.class_type === "LoadImage" ? graph[id]!.inputs.image : sentAs((graph[id]!.inputs.image as [string, number])[0]));
    const loaded = patches.map((p) => sentAs((p.inputs.source_image_b as [string, number])[0]));
    expect(new Set(loaded).size).toBe(2);
    // (sent to ComfyUI's temp folder: its LoadImage reads the name with " [temp]")
    for (const name of loaded) expect(fake.uploads).toContain(String(name).replace(/ \[temp\]$/, ""));
    // each box's words are their person's, in their box alone
    const texts = Object.values(graph).filter((n) => n.class_type === "Krea2EditGroundedEncode").map((n) => n.inputs.prompt);
    expect(texts).toEqual([expect.stringContaining("zz-test Fabien"), expect.stringContaining("zz-test Nicolas")]);
  });
});
