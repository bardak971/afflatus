import { describe, expect, it } from "vitest";
import { families, recipes } from "@afflatus/recipes";
import type { AssetDetail, RecipeInfo } from "../src/api";
import { formDefaults } from "../src/form";
import { carried, handsOf, renderOf, toolOf } from "../src/viewer/shared";

// the built-in recipes as /api/recipes lists them (only what the form and the passes read)
const all = recipes.map((r) => ({ id: r.id, family: r.family, version: r.version, title: r.title, summary: r.summary, output: r.output, inputs: r.inputs, traits: null }) as unknown as RecipeInfo);
const byId = (id: string) => all.find((r) => r.id === id)!;
const FACE = "bbox/face_yolov8m.pt";
const HAND = "bbox/hand_yolov8s.pt";
const options = { detector: [FACE, HAND], checkpoint: ["mine.safetensors", "other.safetensors"] };

describe("the face detailer's form on a hand detector", () => {
  const fixFace = byId("sdxl.fix-face");
  const start = (stored: Record<string, unknown>) => {
    const { defaults } = formDefaults(fixFace, { options }, [], stored);
    return { ...defaults, ...stored };
  };

  it("starts the denoise, the crop factor and the prompt on hands", () => {
    expect(start({ detector: HAND })).toMatchObject({ strength: 0.35, faceCrop: 2, prompt: "natural hands, five fingers, detailed skin" });
  });

  it("keeps what was changed on purpose, and brings the face values back with a face detector", () => {
    expect(start({ detector: HAND, strength: 0.5, prompt: "gloves" })).toMatchObject({ strength: 0.5, faceCrop: 2, prompt: "gloves" });
    expect(start({ detector: FACE })).toMatchObject({ strength: 0.4, faceCrop: 3, prompt: "" });
    expect(start({})).toMatchObject({ detector: FACE, strength: 0.4, faceCrop: 3 });
  });
});

describe("the Hand refine pass", () => {
  it("is the picture's own family's face detailer, never Klein's", () => {
    expect(toolOf("h", all, families, "flux.text-to-picture", () => true)?.id).toBe("flux.fix-face");
    const fromKlein = toolOf("h", all, families, "klein.picture", (r) => r.id === "sdxl.fix-face");
    expect(fromKlein?.id).toBe("sdxl.fix-face");
    expect(toolOf("f", all, families, "klein.picture", () => true)?.id).toBe("klein.fix-face");
    expect(handsOf(byId("klein.fix-face"))).toBeUndefined();
    expect(handsOf(byId("sdxl.fix-face"))?.values).toMatchObject({ strength: 0.35, faceCrop: 2 });
  });
});

describe("a pass on an edited copy", () => {
  /** A mirrored copy of a picture rendered on its own checkpoint: no generation of its own, the render it was taken from beside it. */
  const copy = {
    generation: null,
    ancestor: { id: "g", recipe: "sdxl.text-to-picture", family: "sdxl", inputs: { prompt: "a lighthouse", checkpoint: "mine.safetensors", seed: 7, negative: "blurry" }, resolved: { seed: 7 }, tookMs: 1 },
  } satisfies Pick<AssetDetail, "generation" | "ancestor">;

  it("carries the render's checkpoint and prompt into the face detailer, not its seed", () => {
    const g = renderOf(copy)!;
    const made = byId(g.recipe);
    const tool = toolOf("f", all, families, made.id, () => false)!;
    expect(tool.id).toBe("sdxl.fix-face");
    const taken = carried(g, made, tool, false);
    expect(taken).toMatchObject({ checkpoint: "mine.safetensors", prompt: "a lighthouse", negative: "blurry" });
    expect(taken.seed).toBeUndefined();
  });

  it("carries nothing when nothing it comes from was rendered", () => {
    expect(renderOf({ generation: null, ancestor: null })).toBeNull();
  });
});
