import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeComfy, type FakeComfy } from "@afflatus/comfy/testing";
import { makeApp, post, referenceCatalog, until, type TestApp } from "./helpers";

/**
 * A form's files held together before it renders (modelSetCheck.ts, card #83): said to the form, refused at Render when the
 * mix is known to give black frames, said on the job otherwise, which runs.
 */

const HIGH = "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors";
const LOW = "wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors";
const FIVE_B = "wan2.2_ti2v_5B_fp16.safetensors";
const I2V_LOW = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors";

let fake: FakeComfy;
let t: TestApp;
beforeEach(async () => {
  fake = await startFakeComfy({
    catalog: referenceCatalog(),
    models: {
      diffusion_models: [HIGH, LOW, FIVE_B, I2V_LOW], vae: ["wan_2.1_vae.safetensors"], text_encoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
      loras: ["orbit_low_noise.safetensors", "film_grain.safetensors"],
    },
  });
  t = await makeApp({ comfyUrl: fake.url });
});
afterEach(async () => {
  await t.close();
  await fake.close();
});

const form = (input: Record<string, unknown>) => ({ recipe: "wan.video", input: { prompt: "A lighthouse at dusk, the camera pushes in slowly.", ...input } });

describe("a render's files held together", () => {
  it("says nothing of Wan's own pair", async () => {
    const res = await post(t.app, "/api/form/set-check", form({ model: HIGH, modelLow: LOW }));
    expect(res.json()).toEqual({ findings: [] });
  });

  it("refuses the 5B model in the high-noise place, to the form and at Render, before anything is queued", async () => {
    // from a picture: the build says itself that the 5B is no words-to-video model
    const picture = (await t.app.inject({ method: "POST", url: "/api/assets", headers: { "content-type": "image/png" }, payload: await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 120, b: 150 } } }).png().toBuffer() })).json() as { id: string };
    const fiveB = form({ model: FIVE_B, modelLow: I2V_LOW, start: picture.id });
    const said = (await post(t.app, "/api/form/set-check", fiveB)).json() as { findings: Array<{ at: string; black: boolean; text: string }> };
    expect(said.findings).toEqual([expect.objectContaining({ at: "model", black: true, text: expect.stringMatching(/^This model is Wan 2\.2 5B \(TI2V\)/) })]);
    const res = await post(t.app, "/api/jobs", fiveB);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/This model is Wan 2\.2 5B \(TI2V\).*It would give black or garbled frames, so it was not sent\./);
    expect(await t.db.selectFrom("jobs").select("id").execute()).toEqual([]);
  });

  it("runs a swapped pair and a LoRA in the wrong list, said on the job", async () => {
    const res = await post(t.app, "/api/jobs", form({ model: LOW, modelLow: HIGH, loras: [{ file: "orbit_low_noise.safetensors", weight: 1 }] }));
    expect(res.statusCode).toBe(200);
    const [id] = (res.json() as { ids: string[] }).ids;
    const warning = async () => (await t.db.selectFrom("jobs").select("warning").where("id", "=", id!).executeTakeFirst())?.warning ?? "";
    await until(async () => (await warning()).includes("LoRAs (low noise)"));
    const said = await warning();
    expect(said).toContain("This model is the pair's low-noise file: the High-noise model takes the high-noise one");
    expect(said).toContain("This model is the pair's high-noise file: the Low-noise model takes the low-noise one");
    expect(said).toContain("This LoRA is the low-noise file of a Wan LoRA: it goes in LoRAs (low noise).");
  });

  it("files a LoRA by the base model Civitai gave its hash, where its header says none", async () => {
    await t.db.insertInto("model_hashes").values({ folder: "loras", file: "film_grain.safetensors", size: 1, mtime: 1, sha256: "AB", hashed_at: "x", civitai_version: 7, hf_url: null, matched_at: "x", civitai_base: "SDXL 1.0" }).execute();
    const info = (await t.app.inject({ method: "GET", url: "/api/models/loras/info" })).json() as { items: Record<string, { base?: string; civitaiBase?: string }> };
    expect(info.items["film_grain.safetensors"]).toMatchObject({ base: "SDXL", civitaiBase: "SDXL 1.0" });
    const said = (await post(t.app, "/api/form/set-check", form({ model: HIGH, modelLow: LOW, loras: [{ file: "film_grain.safetensors", weight: 1 }] }))).json();
    expect(said.findings).toEqual([expect.objectContaining({ at: "loras", black: false, text: "This LoRA was trained for SDXL: on Wan 2.2 it does nothing." })]);
  });
});
