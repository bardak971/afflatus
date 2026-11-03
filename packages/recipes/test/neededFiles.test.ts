import { describe, expect, it } from "vitest";
import { dryContext, neededSlots, parseInput, podSlotFiles, type Recipe } from "@afflatus/core";
import { familyById, recipeById, recipes, UPSCALE } from "../src";
import { fileGaps } from "../../../scripts/fileGaps";

/**
 * What a machine is sent for a job before any build (core podSlotFiles: the required slots, and the optional ones its
 * needs and needsWith ask for) against what its graph loads (card #226). Each time the two parted, a pod was billed for a
 * job that lacked a file, or waited for one its graph never loads.
 */

const recipe = (id: string) => recipeById(id)!;
/** A variant's input with `over` on it, parsed as a job's is. */
const inputOf = (r: Recipe<any>, over: Record<string, unknown> = {}, variant = 0) => parseInput(r, { ...r.variants[variant]!.input, ...over }) as Record<string, unknown>;
/** The slots a fresh pod is sent for it (nothing there yet, nothing on this PC). */
const sent = (r: Recipe<any>, input: Record<string, unknown>) => Object.keys(podSlotFiles(r, input, familyById(r.family)!.slots, null, null));
/** And a machine of the user's own that has only the family's required files. */
const onOwn = (r: Recipe<any>, input: Record<string, unknown>) => {
  const required = familyById(r.family)!.slots.filter((s) => !s.optional).map((s) => ({ id: s.id, file: s.get?.file ?? `${s.id}.safetensors` }));
  return Object.keys(podSlotFiles(r, input, familyById(r.family)!.slots, required, null, true));
};

describe("every recipe variant's graph loads only the family files its needs ask for, and asks for none it never loads", () => {
  for (const r of recipes) {
    it(r.id, () => {
      const gaps = r.variants.flatMap((v) => {
        const input = parseInput(r, v.input) as Record<string, unknown>;
        const ctx = (slots: Record<string, string>) => dryContext({ slots, uploads: v.uploads ?? {}, media: v.media ?? {}, canvas: v.canvas, ...(v.has ? { has: v.has } : {}) });
        return fileGaps(r, v, input, ctx).map((g) => `${v.name}: ${g}`);
      });
      expect(gaps).toEqual([]);
    });
  }
});

describe("the files asked for a job, as they went wrong before", () => {
  it("Turbo's LoRA for Qwen Edit on a model not made for few steps, and the reference turbo for H3's reference clip (35f5fda5)", () => {
    expect(sent(recipe("qwen.edit"), inputOf(recipe("qwen.edit"), { fast: true }))).toContain("editTurbo");
    expect(sent(recipe("h3.video"), inputOf(recipe("h3.video"), { fast: true, references: [{ asset: "r1", role: "person" }] }))).toContain("refTurbo");
  });

  it("a swap's Face refine alone is sent neither the swap's LoRA nor its model, which it never loads (9e0d8a81)", () => {
    const only = inputOf(recipe("h3.swap"), { faceRefine: true, faceRefineOnly: true, references: [{ asset: "r1", role: "person" }] });
    expect(sent(recipe("h3.swap"), only)).not.toContain("swapLora");
    expect(sent(recipe("h3.swap"), only)).not.toContain("swapUnet");
    expect(sent(recipe("h3.swap"), inputOf(recipe("h3.swap")))).toEqual(expect.arrayContaining(["swapLora", "swapUnet"]));
  });

  it("a swap enlarged by H3's latent upscaler is sent it (Timeline 19's swaps, blurred by a plain resize)", () => {
    expect(sent(recipe("h3.swap"), inputOf(recipe("h3.swap"), { upscale: UPSCALE.latent }))).toContain("latentUpscaler");
  });

  it("a Wan clip that carries on is sent SVI 2.0 Pro's LoRAs (card #107)", () => {
    expect(sent(recipe("wan.video"), inputOf(recipe("wan.video"), { previous: { asset: "c1" } }))).toEqual(expect.arrayContaining(["sviHigh", "sviLow"]));
  });
});

describe("the files asked for a job (card #226)", () => {
  it("Edit with a fine-tune of Kontext picked is not sent FLUX.1 Kontext; left alone, it is", () => {
    const edit = recipe("flux.edit");
    expect(sent(edit, inputOf(edit, { model: "my_kontext_finetune.safetensors" }))).not.toContain("kontext");
    expect(neededSlots(edit, inputOf(edit, { model: "my_kontext_finetune.safetensors" }))).toEqual([]);
    expect(sent(edit, inputOf(edit))).toContain("kontext");
  });

  it("a swap's Show the mask asks for SAM 3 alone: not the swap's LoRA, model or RIFE, and builds without them", () => {
    const swap = recipe("h3.swap");
    const at = swap.variants.findIndex((v) => v.name.startsWith("Show the mask"));
    const input = inputOf(swap, { smooth: true }, at);
    expect(sent(swap, input)).toContain("swapSam");
    for (const id of ["swapLora", "swapUnet", "rife"]) expect(sent(swap, input)).not.toContain(id);
    const v = swap.variants[at]!;
    const { swapLora: _l, swapUnet: _u, ...slots } = v.slots ?? {};
    expect(() => swap.build(input as never, dryContext({ slots, uploads: v.uploads ?? {}, media: v.media ?? {} }))).not.toThrow();
  });

  it("Krea 2's style reference images are sent its style-reference LoRA, unless one is picked in its row", () => {
    const krea = recipe("krea2.text-to-picture");
    const styled = { references: [{ asset: "a", role: "style" }] };
    expect(sent(krea, inputOf(krea, styled))).toContain("styleRef");
    expect(sent(krea, inputOf(krea, { ...styled, styleLora: "my_style.safetensors" }))).not.toContain("styleRef");
  });

  it("FLUX.1's txt2img with the look of a picture is sent Redux and its vision model", () => {
    expect(sent(recipe("flux.text-to-picture"), inputOf(recipe("flux.text-to-picture"), { look: "l1" }))).toEqual(expect.arrayContaining(["redux", "vision"]));
    expect(sent(recipe("flux.text-to-picture"), inputOf(recipe("flux.text-to-picture")))).not.toContain("redux");
  });

  it("a Wan clip from words alone is sent the two t2v models, each unless a model made for words is picked", () => {
    const wan = recipe("wan.video");
    expect(sent(wan, inputOf(wan, { start: undefined }))).toEqual(expect.arrayContaining(["t2vHigh", "t2vLow"]));
    expect(sent(wan, inputOf(wan, { start: undefined, model: "wan2.2_t2v_high_noise_14B_mine.safetensors" }))).not.toContain("t2vHigh");
    expect(sent(wan, inputOf(wan, { start: "p1" }))).not.toContain("t2vHigh");
  });

  it("LTX in two passes is sent the latent upscaler; a machine of the user's own without it renders in one pass rather than wait", () => {
    for (const id of ["ltx.video", "ltx25.video"]) {
      const ltx = recipe(id);
      expect(sent(ltx, inputOf(ltx, { twoPass: true }))).toContain("upscaler");
      expect(sent(ltx, inputOf(ltx, { twoPass: false }))).not.toContain("upscaler");
      expect(onOwn(ltx, inputOf(ltx, { twoPass: true }))).not.toContain("upscaler");
    }
  });

  it("Z-Image's inpaint and outpaint are sent its inpaint patch; a machine of the user's own without it draws without it", () => {
    for (const id of ["zimage.paint-over", "zimage.outpaint"]) {
      expect(sent(recipe(id), inputOf(recipe(id)))).toContain("inpaintCn");
      expect(onOwn(recipe(id), inputOf(recipe(id)))).not.toContain("inpaintCn");
    }
  });
});
