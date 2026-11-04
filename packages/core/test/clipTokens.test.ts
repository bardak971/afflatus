import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clipBpe, clipChunks, clipPieces, estimatePieces, promptParts } from "../src/clipTokens";

// the merges CLIP's merges.txt applies to these prompts, kept in their order (the whole file is ComfyUI's, 570 kB): BPE
// with only them gives what it gives with all of them, since every merge it makes is among them
const count = clipBpe(readFileSync(new URL("./fixtures/clip-merges-subset.txt", import.meta.url), "utf8"));
const total = (text: string) => clipPieces(text).reduce((n, p) => n + count(p), 0);

// counted by Hugging Face's CLIPTokenizer (A1111's and ComfyUI's), the chunks by ComfyUI's tokenize_with_weights
const FISHERMAN = "Photorealistic portrait of an elderly fisherman, weathered skin, deep wrinkles, salt-and-pepper beard, wearing a yellow raincoat, standing on a wooden pier at dawn, soft golden light, mist over the harbor, shallow depth of field, 85mm lens, f/1.8, highly detailed, sharp focus, cinematic color grading, award-winning photograph, National Geographic style, intricate textures, volumetric lighting";
const KNOWN: Array<{ text: string; total?: number; chunks: number[] }> = [
  { text: "a photo of a cat", total: 5, chunks: [5] },
  { text: "masterpiece, best quality, 1girl, solo, long hair, looking at viewer, smile, blue eyes, blonde hair, dress", total: 26, chunks: [26] },
  { text: FISHERMAN, total: 86, chunks: [75, 11] },
  { text: "score_9, score_8_up, score_7_up, source_anime, 1girl, hatsune miku, twintails, aqua hair, (detached sleeves:1.1), necktie, thighhighs, 2024, 16:9, @artist, café, naïve résumé", total: 68, chunks: [63] },
  { text: "(masterpiece:1.2), (best quality), ((ultra-detailed)), [lowres], 1girl, red dress, \\(cosplay\\)", chunks: [22] },
  { text: "a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z, a, b, c, d, e, f, g, h, i, j, k, l, (red dress, blue sky:1.3), green grass", total: 89, chunks: [75, 9] },
];

describe("CLIP tokens of a prompt", () => {
  it("counts as CLIP's tokenizer counts", () => {
    for (const k of KNOWN) if (k.total !== undefined) expect(total(k.text), k.text).toBe(k.total);
  });

  it("cuts the chunks as ComfyUI does", () => {
    for (const k of KNOWN) expect(clipChunks(k.text, count), k.text).toEqual(k.chunks);
  });

  it("takes weights and brackets out, and escaped brackets as brackets", () => {
    expect(promptParts("a, (red dress:1.2), ((sky)), \\(b\\)")).toEqual(["a, ", "red dress", ", ", "sky", ", (b)"]);
    // a colon that is not a weight stays in the text
    expect(promptParts("(16:9 frame)")).toEqual(["16:9 frame"]);
  });

  it("moves a short weighted part whole into the next chunk, and cuts a long one", () => {
    const one = () => 1;
    // 74 tokens, then a part of 3: it does not fit in the one left, so it goes whole into the next chunk
    const words = Array.from({ length: 74 }, (_, i) => `w${i}`).join(" ").replace(/\d/g, "");
    expect(clipChunks(`${words} (x y z:1.1)`, one)).toEqual([74, 3]);
    // a part of 8 fills the chunk and goes on
    expect(clipChunks(`${words} (a b c d e f g h:1.1)`, one)).toEqual([75, 7]);
    expect(clipChunks("", one)).toEqual([0]);
  });

  it("estimates close to the count without the merges", () => {
    for (const k of KNOWN) {
      const guess = clipChunks(k.text, estimatePieces).reduce((a, b) => a + b, 0);
      const exact = k.chunks.reduce((a, b) => a + b, 0);
      expect(Math.abs(guess - exact) / exact, k.text).toBeLessThan(0.25);
    }
  });
});
