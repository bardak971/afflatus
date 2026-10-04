import { describe, expect, it } from "vitest";
import type { Recipe } from "@afflatus/core";
import { checkOutput } from "../src/outputChecks";

const recipe = (main = "prompt", extra: string[] = []) =>
  ({ inputs: [{ id: main, type: "prompt", label: "Prompt" }, ...extra.map((id) => ({ id, type: "prompt", label: id, optional: true }))] }) as unknown as Recipe<any>;
const texts = (checks: ReturnType<typeof checkOutput>) => checks.map((c) => c.text);

describe("what the designer wrote, against the model's rules", () => {
  it("H3: labels, untagged speech, speech in plain quotes, a shot mark, dialogue in the soundscape, an artist in the music", () => {
    const r = recipe("description", ["soundscape", "music"]);
    expect(texts(checkOutput(r, "h3", { description: "integrated_multimodal_description: [Shot 1] She turns." }))).toEqual(expect.arrayContaining([expect.stringMatching(/field labels/), expect.stringMatching(/\[Shot 1\] itself/)]));
    expect(texts(checkOutput(r, "h3", { description: "The woman (S1) says: <d>Come here.</d>" }))).toEqual([expect.stringMatching(/without its language tag/)]);
    expect(texts(checkOutput(r, "h3", { description: 'She turns and says: "Come here."' }))).toEqual([expect.stringMatching(/plain quotes/)]);
    expect(checkOutput(r, "h3", { description: "The woman (S1) says: <d>[English] Come here.</d> The camera pushes in." })).toEqual([]);
    expect(texts(checkOutput(r, "h3", { soundscape: "Waves, and the song by a band on the radio", music: "Something by Hans Zimmer" }))).toEqual([expect.stringMatching(/Sound effects/), expect.stringMatching(/artist or song name/)]);
  });

  it("LTX: the audio sentence, the length, a list", () => {
    const r = recipe();
    expect(texts(checkOutput(r, "ltx", { prompt: "A man walks down a street at dusk, the camera following." }))).toEqual([expect.stringMatching(/No audio sentence/)]);
    expect(checkOutput(r, "ltx", { prompt: "A man walks down a street at dusk, the camera following. The audio is footsteps on wet stone, no music." })).toEqual([]);
    expect(texts(checkOutput(r, "ltx", { prompt: "- the man\n- the street\nThe audio is wind." }))).toEqual([expect.stringMatching(/A list/)]);
  });

  it("Wan: dialogue on a silent model, weights; FLUX, Klein, Krea 2, Qwen: weights, quality words, length; SDXL: underscores, quality tags, repeats, 75 words", () => {
    const r = recipe();
    expect(texts(checkOutput(r, "wan", { prompt: 'She turns and says: "Come here." The camera pushes in.' }))).toEqual([expect.stringMatching(/makes no sound/)]);
    expect(texts(checkOutput(r, "flux", { prompt: "A photograph of a (red dress:1.3), masterpiece, 8k" }))).toEqual([expect.stringMatching(/weight/), expect.stringMatching(/Quality words/)]);
    expect(checkOutput(r, "krea2", { prompt: "A watercolour of a harbour at dawn, three boats, soft light from the east." })).toEqual([]);
    expect(texts(checkOutput(r, "qwen", { prompt: Array(210).fill("word").join(" ") }))).toEqual([expect.stringMatching(/210 words/)]);
    expect(texts(checkOutput(r, "sdxl", { prompt: "1girl, long_hair, masterpiece, smile, smile, red eyes" }))).toEqual([
      expect.stringMatching(/Underscores/), expect.stringMatching(/Quality, score or rating tags/), expect.stringMatching(/Repeated tags: smile/),
    ]);
    expect(checkOutput(r, "sdxl", { prompt: "1girl, solo, long hair, red eyes, smile, upper body, indoors, soft lighting" })).toEqual([]);
  });

  it("a camera phrase carried over from the previous text is pointed out, on prose models only", () => {
    const r = recipe();
    const before = { prompt: "A woman on a terrace, shallow depth of field, golden hour." };
    expect(texts(checkOutput(r, "flux", { prompt: "A woman reads on a terrace, shallow depth of field." }, before))).toEqual([expect.stringMatching(/carried over.*shallow depth of field/)]);
    expect(checkOutput(r, "flux", { prompt: "A woman reads on a terrace in the shade." }, before)).toEqual([]);
    expect(checkOutput(r, "sdxl", { prompt: "1girl, terrace, bokeh" }, { prompt: "1girl, bokeh" })).toEqual([]);
  });

  it("says nothing about an empty or unchanged part, or a family it has no rules for", () => {
    expect(checkOutput(recipe(), "h3", {})).toEqual([]);
    expect(checkOutput(recipe(), "tools", { prompt: "(a:1.4) masterpiece" })).toEqual([]);
  });
});
