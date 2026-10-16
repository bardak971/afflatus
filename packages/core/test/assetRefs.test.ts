import { describe, expect, it } from "vitest";
import { formsWithout } from "../src";

const A = "a".repeat(32);
const B = "b".repeat(32);

describe("a draft's forms without some library items", () => {
  it("leaves out an input that held one, drops a list's entries that name one, and keeps everything else", () => {
    const forms = {
      sdxl: { prompt: `a cat ${A}`, image: A, steps: 30 },
      h3: { clip: { asset: A, at: 1200 }, refs: [{ asset: A, role: "face" }, { asset: B, role: "style" }], frames: [A, B], mask: B },
    };
    expect(formsWithout(forms, new Set([A]))).toEqual({
      // a prompt that mentions the id in its words is text, not a reference
      sdxl: { prompt: `a cat ${A}`, steps: 30 },
      h3: { refs: [{ asset: B, role: "style" }], frames: [B], mask: B },
    });
  });

  it("changes nothing when none is named", () => {
    const forms = { sdxl: { prompt: "a cat", image: B } };
    expect(formsWithout(forms, new Set([A]))).toEqual(forms);
  });
});
