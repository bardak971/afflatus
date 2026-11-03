import { describe, expect, it } from "vitest";
import { h3Form, H3_DROPS, H3_INPUT_IDS } from "../src/h3/form";
import { h3LipSync } from "../src/h3/lipsync";
import { h3MotionTransfer } from "../src/h3/motionTransfer";
import { h3Swap } from "../src/h3/swap";
import { h3Video } from "../src/h3/video";

// every H3 form alike (the owner, 2026-10-20; card #227): each takes every H3 input and trait, or says why it does not
const FORMS = [h3Video, h3LipSync, h3Swap, h3MotionTransfer];

describe("H3 forms made by h3Form", () => {
  it.each(FORMS.map((r) => [r.id, r] as const))("%s takes every H3 input, or drops it with why", (id, recipe) => {
    const drop = H3_DROPS.get(id);
    expect(drop, `${id} is not made by h3Form`).toBeDefined();
    const ids = new Set(recipe.inputs.map((i) => i.id));
    for (const shared of H3_INPUT_IDS) expect(ids.has(shared) || Boolean(drop![shared]?.trim()), `${id} · ${shared}`).toBe(true);
    for (const dropped of Object.keys(drop!)) expect(H3_INPUT_IDS, `${id} drops ${dropped}`).toContain(dropped);
  });

  it.each(FORMS.map((r) => [r.id, r] as const))("%s has every trait of H3's clip, but those of an input it drops", (id, recipe) => {
    const drop = H3_DROPS.get(id)!;
    for (const [trait, value] of Object.entries(h3Video.traits!)) {
      const named = typeof value === "string" && H3_INPUT_IDS.includes(value) && drop[value] !== undefined;
      expect(trait in recipe.traits!, `${id} · ${trait}`).toBe(!named);
    }
    // a frame a form cannot be given is said false by the trait that offers it
    expect(recipe.traits!.startFrame).toBe(drop.start === undefined);
    expect(recipe.traits!.endAnchor).toBe(drop.next === undefined);
  });

  it("keeps the face carried on Video with audio and Lip sync only, the other two waiting for their test (card #224)", () => {
    for (const r of [h3Video, h3LipSync]) expect(r.traits).toMatchObject({ faceCarried: "faceCarried", holdFace: "holdFace" });
    for (const r of [h3Swap, h3MotionTransfer]) {
      expect(r.traits!.faceCarried).toBeUndefined();
      expect(H3_DROPS.get(r.id)!.faceCarried).toMatch(/card #224/);
      expect(H3_DROPS.get(r.id)!.holdFace).toMatch(/card #224/);
    }
  });

  it("refuses a form that leaves an H3 input out without saying why, or drops one H3 does not have", () => {
    const spec = { id: "zz.h3", version: 1, title: "zz", summary: "zz", variants: [], built: (input: never) => ({ clip: input }) };
    expect(() => h3Form({ ...spec, inputs: { lay: (shared) => shared.filter((i) => i.id !== "seed") } })).toThrow(/leaves out H3's seed/);
    expect(() => h3Form({ ...spec, inputs: { drop: { nothing: "zz" } } })).toThrow(/drops nothing/);
    H3_DROPS.delete("zz.h3");
  });

  // the server reads a job whose form cannot be parsed by its family's slots (machineScans' filesUsed): a swap's needs read
  // its input alone, and the clip made from it (asClip, which reads parsed inputs) only where a part needs it
  it("reads a swap's needs, and any form's finishing, on an input that cannot be parsed", () => {
    const raw = { source: { asset: "zz-test-source" }, sourceStart: -1, who: "the man", references: [] };
    expect(() => h3Swap.needsWith!(raw as never, {})).not.toThrow();
    for (const r of FORMS) expect(r.finishing!(raw as never)).toBeNull();
  });

  it("gives every H3 form the same optional nodes, and H3's Sound chapter last", () => {
    for (const r of FORMS) {
      expect(r.optionalNodes).toEqual(expect.arrayContaining(h3Video.optionalNodes!));
      expect(r.chapters?.at(-1)?.id).toBe("sound");
    }
  });
});
