import { describe, expect, it } from "vitest";
import { families, recipes } from "@afflatus/recipes";
import { firstOperation, forSaid, minimumSlots, otherWay, sizeSaid } from "../src/familyMinimum";

/**
 * A family's minimum (Settings › Models, "Get the minimum"): the files its first operation cannot run without, against the
 * recipes as they are. A family with no minimum, or one whose first operation needs a file left out of it, fails here.
 */

/** A family's slots as a ComfyUI that has none of its files scans them. */
const empty = (id: string) => families.find((f) => f.id === id)!.slots.map((s) => ({ id: s.id, optional: Boolean(s.optional), file: null, get: s.get, unless: s.unless }));
const firstOf = (id: string) => firstOperation(recipes.filter((r) => r.family === id))!;
const minimumOf = (id: string) => minimumSlots(empty(id), firstOf(id)).map((s) => s.id);

describe("each family's minimum", () => {
  for (const f of families) {
    it(`${f.name}: its first operation's files, each with an official download`, () => {
      const first = firstOf(f.id);
      expect(first, "a family with no operation offered").toBeTruthy();
      const least = minimumSlots(empty(f.id), first);
      expect(least.length, `${f.name} has no minimum`).toBeGreaterThan(0);
      // one press fetches it all: a file of the minimum with no download would leave the first render waiting
      expect(least.filter((s) => !s.get).map((s) => s.id)).toEqual([]);
      // every file the first operation asks for itself is in it
      for (const id of first.needs ?? []) expect(least.map((s) => s.id)).toContain(id);
      // and every file the family cannot run without, but for the other way of having the model
      for (const s of f.slots.filter((x) => !x.optional && !otherWay({ unless: x.unless }, empty(f.id)))) expect(least.map((x) => x.id)).toContain(s.id);
    });
  }

  it("is a picture for the image families, plain video with audio for H3", () => {
    expect(firstOf("sdxl").output).toBe("image");
    expect(firstOf("klein").output).toBe("image");
    expect(firstOf("h3").id).toBe("h3.video");
  });

  it("never fetches Swap's files for H3", () => {
    expect(minimumOf("h3").sort()).toEqual(["audioVae", "clip", "unet", "videoVae"]);
  });

  it("leaves FLUX.1's Kontext model to Edit", () => {
    expect(minimumOf("flux")).not.toContain("kontext");
  });

  it("is LTX 2.3's one checkpoint and its text encoder, not its split files too", () => {
    expect(minimumOf("ltx").sort()).toEqual(["checkpoint", "clip"]);
  });

  it("keeps the split files' way when a split file is already here", () => {
    // the scan makes the checkpoint optional once the split diffusion model is here (capabilities.ts slotFiles)
    const slots = empty("ltx").map((s) => (s.id === "unet" ? { ...s, file: "ltx-2.3-finetune.safetensors" } : s.id === "checkpoint" ? { ...s, optional: true } : s));
    expect(minimumSlots(slots, firstOf("ltx")).map((s) => s.id).sort()).toEqual(["audioVae", "clip", "projection", "unet", "videoVae"]);
  });
});

describe("what files weigh", () => {
  const sizes = { a: 2 * 2 ** 30, b: 2 ** 30 };
  it("is the sum of the sizes known", () => expect(sizeSaid(["a", "b"], sizes)).toBe("3.0 GB"));
  it("says a + when one is not known yet, never a guess", () => expect(sizeSaid(["a", "c"], sizes)).toBe("2.0 GB+"));
  it("is nothing when none is known", () => expect(sizeSaid(["c", undefined], sizes)).toBe(""));
});

describe("what an optional file is for", () => {
  it("is read from its hint", () => {
    expect(forSaid("For Face refine, 52 MB: the YOLOv8 face detector…")).toBe("for Face refine");
    expect(forSaid("Optional, for Pose from SDPose: ComfyUI's own whole-body pose model.")).toBe("for Pose from SDPose");
    expect(forSaid("For Swap character: akatz-ai's Character-Swap LoRA")).toBe("for Swap character");
  });
  it("is the operations it alone serves, else nothing", () => {
    expect(forSaid("Without it, Turbo is off.", ["Motion transfer"])).toBe("for Motion transfer only");
    expect(forSaid("Without it, Turbo is off.")).toBeNull();
  });
});
