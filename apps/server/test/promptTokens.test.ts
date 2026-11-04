import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSettings } from "../src/settings";
import { makeApp, post, type TestApp } from "./helpers";

let t: TestApp;
let comfyDir: string;
beforeEach(async () => {
  t = await makeApp();
  comfyDir = mkdtempSync(join(tmpdir(), "afflatus-clip-"));
});
afterEach(async () => {
  await t.close();
  rmSync(comfyDir, { recursive: true, force: true });
});

const PROMPT = "Photorealistic portrait of an elderly fisherman, weathered skin, deep wrinkles, salt-and-pepper beard, wearing a yellow raincoat, standing on a wooden pier at dawn, soft golden light, mist over the harbor, shallow depth of field, 85mm lens, f/1.8, highly detailed, sharp focus, cinematic color grading, award-winning photograph, National Geographic style, intricate textures, volumetric lighting";

describe("the CLIP token count", () => {
  it("is exact with ComfyUI's tokenizer file, a guess without it", async () => {
    const guess = (await post(t.app, "/api/prompt/tokens", { text: PROMPT })).json();
    expect(guess.exact).toBe(false);
    expect(guess.chunks).toHaveLength(2);
    // ComfyUI's folder with its tokenizer (here the merges this prompt uses, core's test fixture)
    mkdirSync(join(comfyDir, "comfy", "sd1_tokenizer"), { recursive: true });
    copyFileSync(fileURLToPath(new URL("../../../packages/core/test/fixtures/clip-merges-subset.txt", import.meta.url)), join(comfyDir, "comfy", "sd1_tokenizer", "merges.txt"));
    await writeSettings(t.db, { comfyDir });
    expect((await post(t.app, "/api/prompt/tokens", { text: PROMPT })).json()).toEqual({ chunks: [75, 11], exact: true });
    expect((await post(t.app, "/api/prompt/tokens", { text: "" })).json()).toEqual({ chunks: [0], exact: true });
  });
});
