import { describe, expect, it } from "vitest";
import { families, recipeById } from "@afflatus/recipes";
import { systemPrompt } from "../src/designerPrompt";

/** A form whose prompt follows rules of its own: the designer is handed them over its family's (the swap, 2026-10-18). */
describe("the designer's guide", () => {
  const swap = recipeById("h3.swap")!;
  const h3 = families.find((f) => f.id === "h3");

  it("is the swap's own for a swap: the LoRA's sentence, the person named by what is visible, and Track's few words", () => {
    const said = systemPrompt(swap, h3, "chat", { values: {} });
    expect(said).toContain("A SWAP PROMPT is for akatz-ai's Character-Swap LoRA");
    expect(said).toContain('Never "character"');
    // positive words only: the guide asks for no negation, and itself proposes none of the old ones
    expect(said).toContain("Never a negation");
    expect(said).not.toContain('"Do not add any people');
    // the swap's two boxes are the designer's to write, Track among them, its note said
    expect(said).toMatch(/- who: "Prompt as sent"/);
    expect(said).toMatch(/- track: "Track".*what SAM 3 looks for/);
    // H3's own scene guide is not what it is handed
    if (h3?.guide) expect(said).not.toContain(h3.guide.slice(0, 60));
  });

  it("stays the family's for H3's other forms", () => {
    const said = systemPrompt(recipeById("h3.video")!, h3, "chat", { values: {} });
    expect(said).not.toContain("A SWAP PROMPT");
  });
});
