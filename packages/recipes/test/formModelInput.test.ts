import { describe, expect, it } from "vitest";
import { formDefaults, formModelInput, modelOf, type InputSpec } from "@afflatus/core";
import { recipeById } from "../src/index";

/**
 * Release review 0.9.0, B1: SCAIL-2 at 24 fps has no model input of its own, only Face refine's H3 model (family "h3"). Read
 * as the form's model, its renders were filed, forecast and warmed under the H3 file, and Generate refused a machine lacking it.
 */
const TURBO = "minimax_h3_fused_refdelta_r1024_turbo8.safetensors";

describe("the form's model input", () => {
  const scail = recipeById("scail.motion24")!;

  it("is not Face refine's H3 model on a SCAIL-2 form", () => {
    expect(scail.inputs.some((i) => i.type === "model" && i.id === "faceRefineModel")).toBe(true);
    expect(formModelInput(scail)).toBeUndefined();
    expect(modelOf(scail.inputs as InputSpec[], { faceRefineModel: TURBO, faceRefine: false })).toBeNull();
  });

  it("starts a SCAIL-2 form on no model file's own settings", () => {
    expect(formDefaults(scail as never, { options: { faceRefineModel: [TURBO] } }, [{ family: "scail", file: TURBO, values: { steps: 99 } }], {}).file).toBe("");
  });

  it("is still the recipe's own model on an H3 form and an LTX 2.5 one", () => {
    expect(formModelInput(recipeById("h3.video")!)?.id).toBe("model");
    expect(formModelInput(recipeById("ltx25.video")!)?.id).not.toBe("faceRefineModel");
  });

  it("takes an input of the recipe's own family", () => {
    const specs: InputSpec[] = [{ id: "other", type: "model", label: "Other", folder: "diffusion_models", family: "h3" }, { id: "mine", type: "model", label: "Mine", folder: "diffusion_models", family: "wan" }];
    expect(formModelInput({ family: "wan", inputs: specs })?.id).toBe("mine");
    expect(formModelInput({ inputs: specs })).toBeUndefined();
  });
});
