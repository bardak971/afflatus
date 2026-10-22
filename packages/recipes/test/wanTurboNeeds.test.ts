import { describe, expect, it } from "vitest";
import { wanVideo } from "../src/wan/video";

/** Turbo's LoRAs are asked of a machine only when Turbo is on and the model is not made for a few steps. */
describe("Wan's Turbo needs", () => {
  const needs = (input: Record<string, unknown>) => wanVideo.needsWith!({ start: "p", fast: true, turboIn: "From the name", model: "High\DasiwaWAN22I2V14BTruevision_snatchkissHighV11.safetensors", ...input } as never);
  it("asks the i2v LoRAs for a picture's clip, the t2v ones for words alone", () => {
    expect(needs({})).toEqual(["i2vTurboHigh", "i2vTurboLow"]);
    expect(needs({ start: undefined })).toEqual(["t2vTurboHigh", "t2vTurboLow"]);
  });
  it("asks nothing with Turbo off, or a model made for few steps (by its name, or said so)", () => {
    expect(needs({ fast: false })).toEqual([]);
    expect(needs({ model: "wan2.2_i2v_high_lightx2v_4steps.safetensors" })).toEqual([]);
    expect(needs({ turboIn: "Yes" })).toEqual([]);
    expect(needs({ model: "wan2.2_i2v_high_lightx2v_4steps.safetensors", turboIn: "No" })).toEqual(["i2vTurboHigh", "i2vTurboLow"]);
  });
});

describe("Turbo's LoRA in the other families", () => {
  it("a picture family asks its LoRA for each operation, unless its model is made for a few steps", async () => {
    const { qwenPicture, qwenRedraw, qwenEdit } = await import("../src/qwen/index");
    expect(qwenPicture.needsWith!({ fast: true, model: "qwen_image_fp8.safetensors" } as never)).toEqual(["turbo"]);
    expect(qwenRedraw.needsWith!({ fast: true } as never)).toEqual(["turbo"]);
    expect(qwenPicture.needsWith!({ fast: true, model: "qwen_image_lightning_8steps.safetensors" } as never)).toEqual([]);
    expect(qwenPicture.needsWith!({ fast: false } as never)).toEqual([]);
    expect(qwenEdit.needsWith!({ fast: true, model: "qwen_image_edit_2511_fp8.safetensors" } as never)).toEqual(["editTurbo"]);
    expect(qwenEdit.needsWith!({ fast: true, model: "qwen_image_edit_2511_lightning.safetensors" } as never)).toEqual([]);
  });

  it("H3 asks its turbo LoRA for a model that is not a turbo one; a reference clip, MiniMax's reference model and its own LoRA where the machine has no turbo LoRA", async () => {
    const { h3Video } = await import("../src/h3/video");
    const { h3LipSync } = await import("../src/h3/lipsync");
    const clip = { fast: true, turboIn: "From the name", hybrid: "From the name", references: [], refVideos: [], voice: null, model: "minimax_h3_fl2va.safetensors" };
    expect(h3Video.needsWith!(clip as never)).toEqual(["turbo"]);
    expect(h3LipSync.needsWith!(clip as never)).toEqual(["turbo"]);
    expect(h3Video.needsWith!({ ...clip, model: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors" } as never)).toEqual([]);
    // the reference model is optional in the family: asked for by no form, a fresh pod was sent the frames model and failed
    expect(h3Video.needsWith!({ ...clip, references: [{ asset: "a", role: "person" }] } as never)).toEqual(["refUnet", "refTurbo"]);
    expect(h3Video.needsWith!({ ...clip, references: [{ asset: "a", role: "person" }] } as never, { turbo: "minimax_h3_turbo.safetensors" })).toEqual(["refUnet"]);
    expect(h3Video.needsWith!({ ...clip, references: [{ asset: "a", role: "person" }] } as never, { refUnet: "minimax_h3_ref2va_turbo8.safetensors" })).toEqual(["refUnet"]);
    // a hybrid follows references itself
    expect(h3Video.needsWith!({ ...clip, model: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors", references: [{ asset: "a", role: "person" }] } as never)).toEqual([]);
    expect(h3Video.needsWith!({ ...clip, fast: false } as never)).toEqual([]);
  });
});

describe("Turbo's needs with the model left to the family's file (review K-10)", () => {
  it("read the file the build loads: a few-step file in the slot asks for no LoRA, a plain one does", async () => {
    const { qwenPicture, qwenEdit } = await import("../src/qwen/index");
    const { h3Video } = await import("../src/h3/video");
    expect(qwenPicture.needsWith!({ fast: true } as never, { unet: "qwen_image_lightning_8steps.safetensors" })).toEqual([]);
    expect(qwenPicture.needsWith!({ fast: true } as never, { unet: "qwen_image_fp8.safetensors" })).toEqual(["turbo"]);
    expect(qwenEdit.needsWith!({ fast: true } as never, { edit: "qwen_image_edit_2511_lightning.safetensors" })).toEqual([]);
    const clip = { fast: true, turboIn: "From the name", hybrid: "From the name", references: [], refVideos: [], voice: null };
    expect(h3Video.needsWith!(clip as never, { unet: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors" })).toEqual([]);
    expect(h3Video.needsWith!(clip as never, { unet: "minimax_h3_fl2va.safetensors" })).toEqual(["turbo"]);
    // Wan: the way's own usual file when the model picked is not for this way (or none is)
    const wan = { start: "p", fast: true, turboIn: "From the name" };
    expect(wanVideo.needsWith!(wan as never, { i2vHigh: "wan2.2_i2v_high_lightx2v_4steps.safetensors" })).toEqual([]);
    expect(wanVideo.needsWith!(wan as never, { i2vHigh: "wan2.2_i2v_high_noise_14B_fp8.safetensors" })).toEqual(["i2vTurboHigh", "i2vTurboLow"]);
  });
});
