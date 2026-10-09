import { describe, expect, it } from "vitest";
import { RANDOM_SEED, type InputSpec } from "@afflatus/core";
import { reusedInputs } from "../src/viewer/shared";

const withSeed = { inputs: [{ id: "prompt", type: "prompt", label: "Prompt", style: "tags" }, { id: "noise", type: "seed", label: "Seed" }] as InputSpec[] };
const noSeed = { inputs: [{ id: "prompt", type: "prompt", label: "Prompt", style: "tags" }] as InputSpec[] };

describe("Reuse: a render's parameters for a new draft", () => {
  it("keeps the seed it was rendered with (L), even when the form drew it", () => {
    expect(reusedInputs({ inputs: { prompt: "a cup", noise: RANDOM_SEED }, resolved: { seed: 1645502859 } }, withSeed, "same")).toEqual({ prompt: "a cup", noise: 1645502859 });
  });

  it("rolls a new one (Shift+L)", () => {
    expect(reusedInputs({ inputs: { prompt: "a cup", noise: 7 }, resolved: { seed: 7 } }, withSeed, "new")).toEqual({ prompt: "a cup", noise: RANDOM_SEED });
  });

  it("falls back on the typed seed, rolls one when none is known, and hands a model with no seed none", () => {
    expect(reusedInputs({ inputs: { noise: 42 }, resolved: {} }, withSeed, "same")).toEqual({ noise: 42 });
    expect(reusedInputs({ inputs: { noise: RANDOM_SEED }, resolved: {} }, withSeed, "same")).toEqual({ noise: RANDOM_SEED });
    expect(reusedInputs({ inputs: { prompt: "a cup" }, resolved: { seed: 3 } }, noSeed, "same")).toEqual({ prompt: "a cup" });
    // the recipe is gone: the seed goes under its usual name
    expect(reusedInputs({ inputs: { seed: 5 }, resolved: { seed: 5 } }, undefined, "same")).toEqual({ seed: 5 });
  });
});
