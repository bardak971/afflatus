import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makePng } from "@afflatus/comfy/testing";
import { keepPreview } from "../src/services";
import { makeStill, makeThumb } from "../src/thumbs";

/** The small gaps of the 2026-11-02 security review (card #254, I5 and I6). */
const dir = mkdtempSync(join(tmpdir(), "zz-test-gaps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A 1×1 GIF: a picture the image library decodes, which no upload, ComfyUI output or pod result is. */
const GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0, 0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0,
  1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b,
]);

describe("a thumbnail or a still of what ComfyUI or a pod sent", () => {
  it("is made of a PNG, a JPEG or a WebP only: anything else is not handed to the image library's decoders", async () => {
    const png = makePng(32, 24, [200, 120, 40], [40, 60, 160]);
    expect(await makeThumb(png)).not.toBeNull();
    expect(await makeStill(png)).not.toBeNull();
    expect(await makeThumb(GIF)).toBeNull();
    expect(await makeStill(GIF)).toBeNull();
  });
});

describe("a step's live preview kept for a measuring series", () => {
  it("is written under its prompt's id, and only an id of a uuid's letters: never outside its folder", () => {
    const kept = join(dir, "keep-previews");
    mkdirSync(kept);
    const keep = keepPreview(kept);
    const png = makePng(8, 8, [1, 2, 3], [4, 5, 6]);
    keep("../zz-test-out", { step: 1, steps: 8, sigma: 0.5 }, png, "image/png");
    keep("0f8b6c1e-2d3a-4b5c-9d8e-7f6a5b4c3d2e", { step: 1, steps: 8, sigma: 0.5 }, png, "image/png");
    return new Promise<void>((done) => setTimeout(() => {
      expect(existsSync(join(dir, "zz-test-out"))).toBe(false);
      expect(readdirSync(kept)).toEqual(["0f8b6c1e-2d3a-4b5c-9d8e-7f6a5b4c3d2e"]);
      done();
    }, 200));
  });
});
