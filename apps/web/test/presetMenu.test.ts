import { describe, expect, it } from "vitest";
import { presetOn } from "../src/screens/studio/PresetMenu";

const preset = (id: string, recipe: string, inputs: Record<string, unknown>) => ({ id, kind: "preset" as const, name: id, def: { recipe, inputs }, updatedAt: "" });

describe("the preset the form is on", () => {
  const presets = [preset("Miracle", "h3.video", { model: "m.safetensors", steps: 24 }), preset("model only", "h3.video", { model: "m.safetensors" }), preset("Krea", "krea2.text-to-picture", { model: "m.safetensors", steps: 24 })];
  it("is the one for this form whose every value is the form's, the one that sets the most when several are", () => {
    expect(presetOn(presets, { recipe: "h3.video", values: { model: "m.safetensors", steps: 24, prompt: "a" } })?.name).toBe("Miracle");
    expect(presetOn(presets, { recipe: "h3.video", values: { model: "m.safetensors", steps: 20 } })?.name).toBe("model only");
  });
  it("is none once a value it sets is changed, or for another form", () => {
    expect(presetOn(presets, { recipe: "h3.video", values: { model: "other.safetensors", steps: 24 } })).toBeNull();
    expect(presetOn(presets, { recipe: "wan.video", values: { model: "m.safetensors", steps: 24 } })).toBeNull();
    expect(presetOn(presets, undefined)).toBeNull();
  });
});
