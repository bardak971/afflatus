import { describe, expect, it } from "vitest";
import type { RegionValue } from "@afflatus/core";
import type { RecipeInfo } from "../src/api";
import { boxesWhy, boxInHand } from "../src/paintFix/BoxBar";
import { startEditor, type BoxEditor } from "../src/paintFix/boxEditors";
import { boxesIgnored } from "../src/paintFix/FixBar";
import { boxInputs } from "../src/paintFix/useFixJob";

// Edit in a box (card #284): which editor a picture starts on, which box the bar's field holds, what is sent
const editor = (family: string, ready = true): BoxEditor => ({ family, name: family, ready, recipe: { id: `${family}.edit-in-box` } as RecipeInfo });
const box = (id: string, prompt = ""): RegionValue => ({ id, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, prompt });

describe("the editor an Edit in box starts on", () => {
  const editors = [editor("qwen21", false), editor("qwen"), editor("klein"), editor("flux")];

  it("is the picture's own model's, else the one Settings names, else the first that is ready", () => {
    expect(startEditor(editors, "klein", "qwen")?.family).toBe("klein");
    expect(startEditor(editors, "sdxl", "flux")?.family).toBe("flux");
    expect(startEditor(editors, "sdxl", "zimage")?.family).toBe("qwen");
    expect(startEditor([], "klein", "qwen")).toBeUndefined();
  });

  it("stays on the one Settings names when its files are missing: the bar says so rather than switch", () => {
    expect(startEditor(editors, undefined, "qwen21")?.family).toBe("qwen21");
  });
});

describe("the box the bar's field holds", () => {
  it("is the one picked, else the first that says nothing yet, else the last drawn", () => {
    const boxes = [box("a", "a deer"), box("b"), box("c", "remove the lamp")];
    expect(boxInHand(boxes, "c")?.id).toBe("c");
    expect(boxInHand(boxes, null)?.id).toBe("b");
    expect(boxInHand([box("a", "x"), box("b", "y")], "gone")?.id).toBe("b");
    expect(boxInHand([], null)).toBeUndefined();
  });

  it("is not sent while a box says nothing to do", () => {
    expect(boxesWhy([box("a", "a deer"), box("b", "  ")])).toBe("Box 2 says nothing to do yet");
    expect(boxesWhy([box("a", "a deer")])).toBeNull();
  });
});

describe("what an Edit in box sends", () => {
  it("each box's place and its instruction, trimmed, nothing of a region's cast or LoRA, then the ⚙ rows", () => {
    const sent = boxInputs([{ ...box("a", " a deer "), cast: "p1", lora: { file: "l.safetensors", weight: 1 } }], { steps: 20 });
    expect(sent).toEqual({ boxes: [{ id: "a", box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, prompt: "a deer" }], steps: 20 });
  });
});

describe("what Fix's bar says of edit boxes under a painted mask", () => {
  it("names how many boxes the fix leaves out", () => {
    expect(boxesIgnored(1)).toBe("Fix uses the mask · the 1 box is ignored");
    expect(boxesIgnored(3)).toBe("Fix uses the mask · the 3 boxes are ignored");
  });
});
