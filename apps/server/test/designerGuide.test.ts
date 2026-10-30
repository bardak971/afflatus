import { describe, expect, it } from "vitest";
import { families, recipeById } from "@afflatus/recipes";
import { guidedFamily, systemPrompt } from "../src/designerPrompt";

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

/** Card #129: Lip sync, a clip under a recording and Motion transfer are handed guides of their own, not the family's shot guide. */
describe("the designer's guide on a clip whose sound is a recording, and on Motion transfer", () => {
  const family = (id: string) => families.find((f) => f.id === id)!;
  const h3 = family("h3");
  const lipSync = { values: {}, seconds: 5.9, speaks: true, recording: { lipSync: true, seconds: 5.9 } };
  const over = { values: {}, seconds: 6, speaks: true, recording: { lipSync: false, seconds: 6 } };

  it("H3 Lip sync: the scene and how they speak, the recording's length said, no room for lines nor H3's speech rules", () => {
    const said = systemPrompt(recipeById("h3.lipsync")!, h3, "chat", lipSync);
    expect(said).toContain("In this clip the sound is a RECORDING, laid on it so that the mouth follows its words");
    expect(said).toContain("THE RECORDING of 5.9 seconds is what is said: the mouth follows it");
    expect(said).toContain("Never write a spoken line, a <d>…</d> tag, a speaker number (S1) or what a voice sounds like");
    expect(said).not.toContain("SPOKEN LINES");
    expect(said).not.toContain("Voices numbered (S1)");
    expect(said).not.toContain(h3.guide!.slice(0, 80));
    // H3's own layout rules stay, in the family's very words
    for (const line of ["Afflatus adds the model's layout itself (field labels, the [Shot 1] mark, the picture alignment lines)", "- The camera as type + amplitude + speed:", "- Write what you WANT, never what you do not want", "- A first frame: one clause of what it preserves"]) {
      expect(h3.guide).toContain(line);
      expect(said).toContain(line);
    }
    expect(said).toContain('Leave "Music" EMPTY');
    // its example writes no line and no voice
    const example = h3.recordingGuide!.lipSync.split("\nPrompt: ")[1]!;
    expect(example).not.toMatch(/<d>|\(S1\)|voice|"/);
  });

  it("LTX Lip sync: its one paragraph, the recording pinned, no audio sentence nor quoted line; 2.5's several shots left out", () => {
    for (const [id, fam] of [["ltx.lipsync", "ltx"], ["ltx25.lipsync", "ltx25"]] as const) {
      const said = systemPrompt(recipeById(id)!, family(fam), "chat", lipSync);
      expect(said).toContain("pinned under the clip from the first step");
      expect(said).toContain("ONE flowing paragraph in the present tense, chronological, 40 to 120 words");
      expect(said).toContain("THE RECORDING of 5.9 seconds is what is said");
      expect(said).not.toContain("The audio sentence is mandatory");
      expect(said).not.toContain("Speech in quotation marks");
      expect(said).not.toContain("SPOKEN LINES");
      expect(said).not.toContain("Several shots");
      expect(said).toContain(family(fam).guide!.match(/- A talking face[^\n]*/)![0]);
    }
  });

  it("a clip under a recording it plays over: the picture only, the people silent, on H3 and LTX alike, by the recording being there", () => {
    const h = systemPrompt(recipeById("h3.video")!, h3, "chat", over);
    expect(h).toContain("In this clip a RECORDING plays over the picture unchanged");
    expect(h).toContain("A RECORDING of 6 seconds plays over this clip and is all that is heard");
    expect(h).toContain("The clip is 6 seconds long");
    expect(h).not.toContain("SPOKEN LINES");
    expect(h).not.toContain("Voices numbered (S1)");
    const l = systemPrompt(recipeById("ltx25.video")!, family("ltx25"), "chat", over);
    expect(l).toContain("In this clip a RECORDING plays over the picture unchanged");
    expect(l).toContain("The audio sentence is the place's quiet ambience only");
    expect(l).not.toContain("Speech in quotation marks");
    // a clip of several shots is still the model's own there
    expect(l).toContain("Several shots (2.5 only)");
  });

  it("plain Video with audio is unchanged: H3's shot guide and the room for spoken lines", () => {
    const said = systemPrompt(recipeById("h3.video")!, h3, "chat", { values: {}, seconds: 8, speaks: true });
    expect(said).toContain(h3.guide!);
    expect(h3.guide).toMatch(/^MiniMax H3 makes the picture AND the sound \(voices, effects, music\) together\./);
    expect(said).toContain("SPOKEN LINES: about 20 words fit in this clip");
    expect(said).not.toContain("RECORDING");
  });

  it("Motion transfer: its boxes walked, the prompt as sent left to Afflatus, nothing of the camera or the words", () => {
    const said = systemPrompt(recipeById("h3.motion")!, h3, "chat", { values: {}, speaks: true });
    expect(said).toContain("A MOTION TRANSFER PROMPT is for MiniMax H3 held to a source video's pose");
    expect(said).toContain('Leave "Prompt as sent" empty: Afflatus writes it from the parts');
    expect(said).toMatch(/- look: "How they look"/);
    expect(said).toMatch(/- happens: "What happens"/);
    expect(said).not.toContain(h3.guide!.slice(0, 80));
    expect(said).not.toContain("SPOKEN LINES");
    // the positive-words rule in H3's own words
    expect(said).toContain(h3.guide!.match(/- Write what you WANT[^\n]*/)![0]);
  });

  it("the form's guide wins over the family's, a user's own family guide included", () => {
    const own = guidedFamily(h3, { designerGuides: { h3: "MY OWN H3 GUIDE" } });
    expect(systemPrompt(recipeById("h3.video")!, own, "chat", { values: {} })).toContain("MY OWN H3 GUIDE");
    for (const [id, ctx] of [["h3.motion", { values: {} }], ["h3.lipsync", lipSync], ["h3.swap", { values: {} }]] as const) {
      expect(systemPrompt(recipeById(id)!, own, "chat", ctx)).not.toContain("MY OWN H3 GUIDE");
    }
  });
});
