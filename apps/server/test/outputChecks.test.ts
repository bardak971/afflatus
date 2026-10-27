import { describe, expect, it } from "vitest";
import type { Recipe } from "@afflatus/core";
import { familyById } from "@afflatus/recipes";
import { checkOutput } from "../src/outputChecks";

const recipe = (main = "prompt", extra: string[] = []) =>
  ({ inputs: [{ id: main, type: "prompt", label: "Prompt" }, ...extra.map((id) => ({ id, type: "prompt", label: id, optional: true }))] }) as unknown as Recipe<any>;
const texts = (checks: ReturnType<typeof checkOutput>) => checks.map((c) => c.text);

describe("what the designer wrote, against the model's rules", () => {
  it("H3: labels, untagged speech, speech in plain quotes, a shot mark, dialogue in the soundscape, an artist in the music", () => {
    const r = recipe("description", ["soundscape", "music"]);
    expect(texts(checkOutput(r, familyById("h3"), { description: "integrated_multimodal_description: [Shot 1] She turns." }))).toEqual(expect.arrayContaining([expect.stringMatching(/field labels/), expect.stringMatching(/\[Shot 1\] itself/)]));
    expect(texts(checkOutput(r, familyById("h3"), { description: "The woman (S1) says: <d>Come here.</d>" }))).toEqual([expect.stringMatching(/without its language tag/)]);
    expect(texts(checkOutput(r, familyById("h3"), { description: 'She turns and says: "Come here."' }))).toEqual([expect.stringMatching(/plain quotes/)]);
    expect(checkOutput(r, familyById("h3"), { description: "The woman (S1) says: <d>[English] Come here.</d> The camera pushes in." })).toEqual([]);
    expect(texts(checkOutput(r, familyById("h3"), { soundscape: "Waves, and the song by a band on the radio", music: "Something by Hans Zimmer" }))).toEqual([expect.stringMatching(/Sound effects/), expect.stringMatching(/artist or song name/)]);
  });

  it("LTX: the audio sentence, the length, a list", () => {
    const r = recipe();
    expect(texts(checkOutput(r, familyById("ltx"), { prompt: "A man walks down a street at dusk, the camera following." }))).toEqual([expect.stringMatching(/No audio sentence/)]);
    expect(checkOutput(r, familyById("ltx"), { prompt: "A man walks down a street at dusk, the camera following. The audio is footsteps on wet stone, no music." })).toEqual([]);
    expect(texts(checkOutput(r, familyById("ltx"), { prompt: "- the man\n- the street\nThe audio is wind." }))).toEqual([expect.stringMatching(/A list/)]);
  });

  it("Wan: dialogue on a silent model, weights; FLUX, Klein, Krea 2, Qwen: weights, quality words, length; SDXL: underscores, quality tags, repeats, 75 words", () => {
    const r = recipe();
    expect(texts(checkOutput(r, familyById("wan"), { prompt: 'She turns and says: "Come here." The camera pushes in.' }))).toEqual([expect.stringMatching(/makes no sound/)]);
    expect(texts(checkOutput(r, familyById("flux"), { prompt: "A photograph of a (red dress:1.3), masterpiece, 8k" }))).toEqual([expect.stringMatching(/weight/), expect.stringMatching(/Quality words/)]);
    expect(checkOutput(r, familyById("krea2"), { prompt: "A watercolour of a harbour at dawn, three boats, soft light from the east." })).toEqual([]);
    expect(texts(checkOutput(r, familyById("qwen"), { prompt: Array(210).fill("word").join(" ") }))).toEqual([expect.stringMatching(/210 words/)]);
    expect(texts(checkOutput(r, familyById("sdxl"), { prompt: "1girl, long_hair, masterpiece, smile, smile, red eyes" }))).toEqual([
      expect.stringMatching(/Underscores/), expect.stringMatching(/Quality, score or rating tags/), expect.stringMatching(/Repeated tags: smile/),
    ]);
    expect(checkOutput(r, familyById("sdxl"), { prompt: "1girl, solo, long hair, red eyes, smile, upper body, indoors, soft lighting" })).toEqual([]);
  });

  it("a clip whose sound is a recording: a spoken line or a voice described is said, on Lip sync and under a recording alike (card #129)", () => {
    const h = recipe("description", ["soundscape", "music"]);
    // H3's own speech lines give way to the recording's: the line is said once, for what it is
    expect(texts(checkOutput(h, familyById("h3"), { description: "He smiles and says: <d>[English] Hello there.</d>" }, {}, "lipSync"))).toEqual([expect.stringMatching(/^A spoken line: the recording is what is said/)]);
    expect(texts(checkOutput(h, familyById("h3"), { description: 'She turns and says: "Come here."' }, {}, "over"))).toEqual([expect.stringMatching(/^A spoken line: the recording plays over this clip/)]);
    expect(texts(checkOutput(h, familyById("h3"), { description: "The man (S1) speaks calmly to the camera." }, {}, "lipSync"))).toEqual([expect.stringMatching(/^A voice described/)]);
    expect(texts(checkOutput(h, familyById("h3"), { description: "He speaks calmly to the camera.", soundscape: "a deep, warm voice in the room" }, {}, "lipSync"))).toEqual([expect.stringMatching(/^A voice described/)]);
    expect(checkOutput(h, familyById("h3"), { description: "She listens, her lips closed, as the voice-over plays." }, {}, "over")).toEqual([]);
    // LTX Lip sync's sound is the recording, pinned: no audio sentence asked; a clip it plays over still has one
    const r = recipe();
    expect(checkOutput(r, familyById("ltx"), { prompt: "A medium close-up of a man at a café terrace, speaking calmly to the camera." }, {}, "lipSync")).toEqual([]);
    expect(texts(checkOutput(r, familyById("ltx"), { prompt: "A man walks down a street at dusk." }, {}, "over"))).toEqual([expect.stringMatching(/No audio sentence/)]);
    expect(texts(checkOutput(r, familyById("ltx25"), { prompt: 'A man at a café terrace says quietly: "What a view."' }, {}, "lipSync"))).toEqual([expect.stringMatching(/^A spoken line/)]);
    // without a recording nothing of it is said
    expect(checkOutput(h, familyById("h3"), { description: "The woman (S1) says: <d>[English] Come here.</d>" })).toEqual([]);
  });

  it("a camera phrase carried over from the previous text is pointed out, on prose models only", () => {
    const r = recipe();
    const before = { prompt: "A woman on a terrace, shallow depth of field, golden hour." };
    expect(texts(checkOutput(r, familyById("flux"), { prompt: "A woman reads on a terrace, shallow depth of field." }, before))).toEqual([expect.stringMatching(/carried over.*shallow depth of field/)]);
    expect(checkOutput(r, familyById("flux"), { prompt: "A woman reads on a terrace in the shade." }, before)).toEqual([]);
    expect(checkOutput(r, familyById("sdxl"), { prompt: "1girl, terrace, bokeh" }, { prompt: "1girl, bokeh" })).toEqual([]);
  });

  it("says nothing about an empty or unchanged part, or a family it has no rules for", () => {
    expect(checkOutput(recipe(), familyById("h3"), {})).toEqual([]);
    expect(checkOutput(recipe(), familyById("tools"), { prompt: "(a:1.4) masterpiece" })).toEqual([]);
  });

  it("keeps each family's rules with the family (Family.lint): the order is the prompt's lines, a carried phrase, then the other parts'", () => {
    const r = recipe("description", ["soundscape"]);
    const lines = checkOutput(r, familyById("h3"), { description: 'She says: "Come here." Shallow depth of field.', soundscape: "a song on the radio" }, { description: "shallow depth of field" });
    expect(lines.map((l) => l.part)).toEqual(["description", "description", "soundscape"]);
    expect(lines[1]!.text).toMatch(/carried over/);
    // an imported workflow's family has no rules of its own: only the carried phrase is said
    const imported = { id: "workflow-x", name: "x", summary: "", promptStyle: "sentences" as const, slots: [], loraMatch: [] };
    expect(texts(checkOutput(recipe(), imported, { prompt: "(a:1.4) masterpiece, bokeh" }, { prompt: "bokeh" }))).toEqual([expect.stringMatching(/carried over/)]);
  });
});
