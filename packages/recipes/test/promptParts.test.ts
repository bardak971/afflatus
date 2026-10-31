import { describe, expect, it } from "vitest";
import { dryContext, parseInput, typedInto, type Recipe } from "@afflatus/core";
import { recipeById, recipes } from "../src/index";
import { swapFromParts, swapSent, SWAP_CAPTION, typedPrompt, type H3Swap } from "../src/h3/swap";
import { motionFromParts, motionTransferFromParts } from "../src/h3/motionTransfer";
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
    // a Motion transfer window after a swap (no Picture of its own) writes its prompt as carrying on
    expect(recipeById("h3.motion")!.promptFromParts!({ afterSwap: true, look: "", happens: "he waves" } as never)).toMatch(/carries on moving as in the clip before\. He waves\.$/);
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
    // a window after a swap (Swap motion's that carried on, card #42)
    const w = motion.variants.find((x) => (x.input as { afterSwap?: boolean }).afterSwap)!;
    expect(sent(motion, w as never, { description: "The man with short brown hair dances.", shot: "Medium" })).not.toContain("Medium shot.");
    expect(sent(motion, w as never, { description: "", look: "", happens: "he waves", shot: "Medium" })).toContain("Medium shot. The person carries on moving as in the clip before. He waves.");
  });

  it("are not glued in front of a prompt already in H3's layout, sent as written", () => {
    const v = h3Video.variants[0]!;
    const layout = "integrated_multimodal_description: [Shot 1] A red ball rolls.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A";
    expect(sent(h3Video, v as never, { description: layout, shot: "Medium" })).toContain(layout);
    expect(sent(h3Video, v as never, { description: layout, shot: "Medium" })).not.toContain("Medium shot.");
    expect(sent(h3Video, v as never, { description: "A red ball rolls.", shot: "Medium" })).toContain("Medium shot. A red ball rolls.");
  });
});

/**
 * Card #49: the fused turbo's preset wrote its prompt into "Prompt as sent", where the form showed it as typed and the parts'
 * prompt was hidden. No preset writes a form's prompt as sent; a draft or clip that kept the preset's text renders as before.
 */
describe("the prompt as sent of a form written from parts", () => {
  const FUSED = "minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors";
  const fromParts = recipes.filter((r) => r.partsInto);

  it("is written by no preset", () => {
    expect(fromParts.map((r) => r.id).sort()).toEqual(["h3.motion", "h3.swap"]);
    for (const r of fromParts) for (const p of r.presets ?? []) expect(Object.keys(p.values), `${r.id}: ${p.match}`).not.toContain(r.partsInto);
  });

  it("holding a text the form started on, is the parts' prompt: what an old swap on the fused turbo sends is unchanged", () => {
    const swap = recipeById("h3.swap")!;
    const parts = { inSource: "teest", look: "test", happens: "test", swapModel: FUSED };
    const written = swapFromParts(parts, 1);
    expect(written).toBe("Swap teest in <Video 1> with the character in <Picture 1>. The character in <Picture 1>: test. Test. Keep the motion, the gestures and the lip movements of <Video 1>. Keep the room of <Video 1> exactly as it is.");
    for (const started of swap.partsStartOn ?? []) {
      expect(typedInto(swap, started)).toBe(false);
      const input = parseInput(swap, { ...parts, source: { asset: "v1" }, who: started }) as H3Swap;
      expect(swapSent(input, 1)).toBe(written);
    }
    expect(swap.partsStartOn).toContain(SWAP_CAPTION);
  });
});

/** Card #49: the "?" of each text of an H3 form says that its tags are Afflatus's to write; Swap's prompt as sent says what they are. */
describe("the tags, said in the ? of the H3 forms' texts", () => {
  const noteOf = (recipe: string, input: string) => String((recipeById(recipe)!.inputs.find((i) => i.id === input) as { note?: string } | undefined)?.note ?? "");
  it("on every text the user writes but a typed prompt as sent", () => {
    const texts: Array<[string, string]> = [
      ["h3.video", "description"], ["h3.video", "subject"], ["h3.lipsync", "description"], ["h3.lipsync", "subject"],
      ["h3.swap", "inSource"], ["h3.swap", "look"], ["h3.swap", "happens"],
      ["h3.motion", "look"], ["h3.motion", "happens"], ["h3.motion", "description"],
    ];
    for (const [recipe, input] of texts) expect(noteOf(recipe, input), `${recipe} ${input}`).toMatch(/Afflatus adds/);
  });
  it("Swap's prompt as sent: what <Video 1> and <Picture 1> are, and that a typed prompt goes as it is", () => {
    const note = noteOf("h3.swap", "who");
    expect(note).toMatch(/<Video 1> is the source, <Picture 1> the person/);
    expect(note).toMatch(/typed: sent as is/);
  });
});
