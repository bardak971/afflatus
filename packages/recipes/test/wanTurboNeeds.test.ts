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
