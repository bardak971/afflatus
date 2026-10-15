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

  it("H3 asks its turbo LoRA for a model that is not a turbo one, nothing for a reference clip on MiniMax's reference model", async () => {
    const { h3Video } = await import("../src/h3/video");
    const { h3LipSync } = await import("../src/h3/lipsync");
    const clip = { fast: true, turboIn: "From the name", hybrid: "From the name", references: [], refVideos: [], voice: null, model: "minimax_h3_fl2va.safetensors" };
    expect(h3Video.needsWith!(clip as never)).toEqual(["turbo"]);
    expect(h3LipSync.needsWith!(clip as never)).toEqual(["turbo"]);
    expect(h3Video.needsWith!({ ...clip, model: "DasiwaMinimaxH3_dasiwaHybridTurboV3_int8.safetensors" } as never)).toEqual([]);
    expect(h3Video.needsWith!({ ...clip, references: [{ asset: "a", role: "person" }] } as never)).toEqual([]);
    expect(h3Video.needsWith!({ ...clip, fast: false } as never)).toEqual([]);
  });
});
