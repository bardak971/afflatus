import { describe, expect, it } from "vitest";
import type { RecipeInfo } from "../src/api";
import { inputMissing } from "../src/screens/studio/missing";

const recipe = (inputs: unknown[]) => ({ id: "r", inputs }) as unknown as RecipeInfo;
const img2img = recipe([{ id: "prompt", type: "prompt", label: "Prompt" }, { id: "source", type: "image", role: "source", label: "Image" }, { id: "denoise", type: "number", label: "Denoise" }]);
const inpaint = recipe([{ id: "source", type: "image", role: "source", label: "Image" }, { id: "mask", type: "image", role: "mask", of: "source", label: "Mask" }]);

describe("Generate waits for the inputs a recipe cannot do without", () => {
  it("an img2img with no picture waits, as an Inpaint with no mask does, and says which", () => {
    expect(inputMissing(img2img, { prompt: "a cat" })).toBe("Add the image first (Inputs).");
    expect(inputMissing(img2img, { prompt: "a cat", source: "a1" })).toBeNull();
    expect(inputMissing(inpaint, {})).toBe("Add the image first (Inputs).");
    expect(inputMissing(inpaint, { source: "a1" })).toBe("Paint the mask first (Inputs).");
    expect(inputMissing(inpaint, { source: "a1", mask: "m1" })).toBeNull();
  });

  it("a video or a sound the recipe needs holds it too; an optional input, or no recipe, never does", () => {
    expect(inputMissing(recipe([{ id: "video", type: "clip", role: "source", label: "Video", frames: [1], fps: 24 }]), {})).toBe("Add the video first (Inputs).");
    expect(inputMissing(recipe([{ id: "voice", type: "audio", role: "voice", label: "Voice" }]), {})).toBe("Add the voice first (Inputs).");
    expect(inputMissing(recipe([{ id: "start", type: "image", role: "start", label: "Start frame", optional: true }]), {})).toBeNull();
    expect(inputMissing(undefined, {})).toBeNull();
  });

  it("a text the recipe cannot do without, left empty, is asked for as the clip inspector asks (card #165)", () => {
    const h3 = recipe([{ id: "description", type: "prompt", label: "What happens", placeholder: "She walks…" }, { id: "music", type: "prompt", label: "Music", optional: true }]);
    expect(inputMissing(h3, { description: "  " })).toBe("Write what happens first.");
    expect(inputMissing(h3, { description: "A boat." })).toBeNull();
    // a text with a default of its own falls back on it; an imported workflow's example does not
    expect(inputMissing(recipe([{ id: "prompt", type: "prompt", label: "Prompt", default: "a cat" }]), { prompt: "" })).toBeNull();
    expect(inputMissing(recipe([{ id: "prompt", type: "prompt", label: "Prompt", default: "a cat", example: true }]), { prompt: "" })).toBe("Write prompt first.");
  });

  it("a mix of inputs the recipe refuses holds it, in the recipe's words, as the server refuses the job (card #219)", () => {
    const krea = { ...recipe([{ id: "prompt", type: "prompt", label: "Prompt" }, { id: "person", type: "references", label: "Person" }, { id: "references", type: "references", label: "Style" }]),
      refuses: [{ when: { all: [{ input: "person", filled: true }, { input: "references", filled: true }] }, why: "Not both." }] } as RecipeInfo;
    const pic = [{ asset: "a1", role: "person" }];
    expect(inputMissing(krea, { prompt: "a cat", person: pic, references: pic })).toBe("Not both.");
    expect(inputMissing(krea, { prompt: "a cat", person: pic, references: [] })).toBeNull();
    // an input still missing is said first
    expect(inputMissing(krea, { prompt: "", person: pic, references: pic })).toBe("Write prompt first.");
  });
});
