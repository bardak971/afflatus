import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../src/api";
import { carryOver } from "../src/picker";
import { ownInputs } from "../src/viewer/shared";

const recipe = (id: string, inputs: InputSpec[]): RecipeInfo => ({ id, family: "k", version: 1, title: id, summary: `${id}.`, output: "image", inputs, traits: null });
const base: InputSpec[] = [
  { id: "prompt", type: "prompt", label: "Prompt", style: "tags" },
  { id: "loras", type: "loras", label: "LoRAs", max: 6 },
];
const txt2img = recipe("k.txt2img", base);
const inpaint = recipe("k.inpaint", [{ id: "source", type: "image", role: "source", label: "Image" }, ...base]);

/** A picture made with a cast: the server worked her words and her LoRA in, and kept what was typed beside it. */
const made = {
  inputs: { prompt: "her_character, brown hair, holding a cup", loras: [{ file: "her.safetensors", weight: 0.7 }] },
  asked: { prompt: "holding a cup" },
};

describe("what a tool opened on a result carries", () => {
  it("is what was typed when the cast goes along too: its words are not carried and given again", () => {
    expect(carryOver(txt2img, inpaint, ownInputs(made, true), undefined)).toEqual({ prompt: "holding a cup" });
  });

  it("is what it rendered with when no cast goes along (queued at once), or when nothing was kept beside it", () => {
    expect(carryOver(txt2img, inpaint, ownInputs(made, false), undefined)).toEqual(made.inputs);
    expect(ownInputs({ inputs: made.inputs }, true)).toBe(made.inputs);
  });
});
