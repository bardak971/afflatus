import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Recipe } from "@afflatus/core";
import { recipeById } from "../src/index";
import { swapFromParts, SWAP_CAPTION, typedPrompt } from "../src/h3/swap";
import { motionFromParts } from "../src/h3/swapMotion";
import { motionTransferFromParts } from "../src/h3/motionTransfer";
import { h3Video } from "../src/h3/video";

/**
 * H3 prompts written from parts (card #34, the owner's mock of 2026-10-20): by rules, the prompt as sent shown and kept
 * when typed; an old draft's prompt sent as it was.
 */
describe("a swap's prompt from its parts", () => {
  it("is the LoRA's caption alone with no part, as before", () => {
    expect(swapFromParts({ inSource: "", look: "", happens: "" }, 1)).toBe(SWAP_CAPTION);
  });
  it("names the person the source shows in the caption, then how the one who goes in looks, then what happens", () => {
    expect(swapFromParts({ inSource: "the man in the grey hoodie", look: "a black leather jacket over a white t-shirt.", happens: "he dances and steps toward the camera" }, 1)).toBe(
      "Swap the man in the grey hoodie in <Video 1> with the character in <Picture 1>. The character in <Picture 1>: a black leather jacket over a white t-shirt. He dances and steps toward the camera.",
    );
  });
  it("adds the fused reference turbo's own sentences, as its preset had them", () => {
    expect(swapFromParts({ inSource: "", look: "", happens: "", swapModel: "minimax_h3_fused_refdelta_turbo.safetensors" }, 1)).toMatch(/^Swap the person .*Keep the room of <Video 1> exactly as it is\.$/);
  });
  it("takes a prompt the form starts on as empty, one typed as the user's", () => {
    expect(typedPrompt("")).toBe(false);
    expect(typedPrompt(SWAP_CAPTION)).toBe(false);
    expect(typedPrompt("Replace the woman in <Video 1> with the man in <Picture 1>.")).toBe(true);
  });
});

describe("a window that carries on, and a Motion transfer, from their parts", () => {
  it("says the person by how they look, carrying on, then what happens; nothing of the room", () => {
    expect(motionFromParts({ look: "short dark hair, a leather jacket", happens: "he spins and stops, arms out" })).toBe("The person, short dark hair, a leather jacket, carries on moving as in the clip before. He spins and stops, arms out.");
    expect(motionFromParts({ look: "", happens: "" })).toBe("The person carries on moving as in the clip before, with the same face, hair and clothes.");
  });
  it("Motion transfer: how they look, then what happens; empty with neither", () => {
    expect(motionTransferFromParts({ look: "a white shirt", happens: "he dances" })).toBe("The person: a white shirt. He dances.");
    expect(motionTransferFromParts({ look: "", happens: "" })).toBe("");
  });
});

describe("what a render sends", () => {
  const swap = recipeById("h3.swap") as Recipe<any>;
  const v = swap.variants[0]!;
  const prompt = (over: Record<string, unknown>) => {
    const built = swap.build(parseInput(swap, { ...(v.input as object), ...over }), dryContext(v));
    const enc = Object.values(built.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>).map((n) => String(n.inputs.prompt ?? n.inputs.text ?? ""));
    return enc.join(" | ");
  };
  it("an old draft's prompt as it was; the parts when it is left empty", () => {
    expect(prompt({ who: "Replace the woman in <Video 1> with the man in <Picture 1>.", inSource: "the boy" })).toContain("Replace the woman in <Video 1> with the man in <Picture 1>.");
    expect(prompt({ who: "", inSource: "the boy in red" })).toContain("Swap the boy in red in <Video 1>");
  });
  it("the fused turbo's own sentences for the file that renders, the form's Model left on its slot", () => {
    const fused = swap.build(parseInput(swap, { ...(v.input as object), who: "", inSource: "the boy" }), dryContext({ ...v, slots: { ...v.slots, swapUnet: "minimax_h3_fused_refdelta_r1024_turbo8.safetensors" } }));
    const said = Object.values(fused.graph as Record<string, { inputs: Record<string, unknown> }>).map((n) => String(n.inputs.prompt ?? "")).join(" | ");
    expect(said).toContain("Keep the room of <Video 1> exactly as it is.");
  });
  it("each form says which of its inputs is the prompt as sent", () => {
    expect(recipeById("h3.swap")!.partsInto).toBe("who");
    expect(recipeById("h3.motion")!.partsInto).toBe("description");
    expect(recipeById("h3.swapMotion")!.promptFromParts!({ ...(parseInput(recipeById("h3.swapMotion")!, { ...(v.input as object) }) as object), previous: { asset: "w1" }, look: "", happens: "he waves" } as never)).toMatch(/carries on moving as in the clip before\. He waves\.$/);
  });
});

describe("the shot's words (card #27)", () => {
  type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const sent = (r: Recipe<any>, v: { input: object; slots?: Record<string, string>; uploads?: Record<string, string>; media?: Record<string, unknown> }, over: Record<string, unknown>) =>
    Object.values(r.build(parseInput(r, { ...v.input, ...over }), dryContext(v as never)).graph as Graph).map((n) => String(n.inputs.prompt ?? "")).filter(Boolean).join(" | ");

  it("are in the prompt as sent where the render adds them, written from the parts", () => {
    expect(motionTransferFromParts({ look: "a white shirt", happens: "he dances", shot: "Wide" })).toBe("Wide shot. The person: a white shirt. He dances.");
    expect(motionFromParts({ look: "", happens: "he waves", shot: "Close-up" })).toBe("Close-up. The person carries on moving as in the clip before. He waves.");
    const motion = recipeById("h3.motion")!;
    const v = motion.variants[0]!;
    expect(sent(motion, v as never, { description: "", look: "a white shirt", happens: "he dances", shot: "Wide" })).toContain("Wide shot. The person: a white shirt. He dances.");
  });

  it("are never added to a prompt typed in Prompt as sent", () => {
    const motion = recipeById("h3.motion")!;
    const v = motion.variants[0]!;
    expect(sent(motion, v as never, { description: "A man dances in a living room.", shot: "Wide" })).not.toContain("Wide shot.");
    const swapMotion = recipeById("h3.swapMotion")!;
    const w = swapMotion.variants.find((x) => (x.input as { previous?: unknown }).previous)!;
    expect(sent(swapMotion, w as never, { who: "The man with short brown hair dances.", shot: "Medium" })).not.toContain("Medium shot.");
    expect(sent(swapMotion, w as never, { who: "", look: "", happens: "he waves", shot: "Medium" })).toContain("Medium shot. The person carries on moving as in the clip before. He waves.");
  });

  it("are not glued in front of a prompt already in H3's layout, sent as written", () => {
    const v = h3Video.variants[0]!;
    const layout = "integrated_multimodal_description: [Shot 1] A red ball rolls.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A";
    expect(sent(h3Video, v as never, { description: layout, shot: "Medium" })).toContain(layout);
    expect(sent(h3Video, v as never, { description: layout, shot: "Medium" })).not.toContain("Medium shot.");
    expect(sent(h3Video, v as never, { description: "A red ball rolls.", shot: "Medium" })).toContain("Medium shot. A red ball rolls.");
  });
});
