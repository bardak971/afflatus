import { describe, expect, it } from "vitest";
import { dryContext, parseInput } from "@afflatus/core";
import { familyById, recipeById } from "../src";
import { MOTION_RELIGHT, MOTION_REPLACE, motionReplace } from "../src/qwen21";
import { FACE_AT_NODE, FACE_NODE } from "../src/shared/face";

const recipe = recipeById("qwen21.motion-picture")!;
type Node = { class_type: string; inputs: Record<string, unknown> };
const build = (n: number, over: Record<string, unknown> = {}, has: (node: string) => boolean = () => true) => {
  const people = Array.from({ length: n }, (_, i) => ({ asset: `p${i}`, role: "person" }));
  const graph = recipe.build(
    parseInput(recipe, { source: "f", people, ...over }),
    dryContext({ has, uploads: { source: "f.png", ...Object.fromEntries(people.map((_, i) => [`people.${i}`, `p${i}.png`])) }, media: { source: { width: 480, height: 854 } } }),
  ).graph as Record<string, Node>;
  const nodes = Object.values(graph);
  return { graph, nodes, prompts: nodes.filter((x) => x.class_type === "TextEncodeQwenImage21").map((x) => x.inputs.prompt as string) };
};

describe("the picture for Motion transfer (qwen21.motion-picture)", () => {
  it("names every photo given, and replaces the head, not the person (HANDOVER-motion-picture-report.md)", () => {
    expect(build(1).prompts[0]).toBe(MOTION_REPLACE);
    const three = build(3).prompts[0]!;
    expect(three).toContain("the head of the person shown in <image2>, <image3> and <image4>");
    expect(three).toContain("every other person");
    expect(build(2).prompts[0]).toContain("<image2> and <image3>,");
    expect(motionReplace(1)).not.toMatch(/beard and their skin|phone-video/);
  });

  it("gives a form that kept the first defaults today's words, and sends words of the user's own as written", () => {
    const first =
      "Replace the main person in <image1> with the person in <image2>: their face, their hair, their beard and their skin. " +
      "They are lit exactly like the rest of <image1>: the same light and shadows on the face, the same soft, grainy phone-video look, so that they belong in the picture. " +
      "Keep everything else in <image1> exactly the same: their clothes, their pose, the people around them and the framing.";
    expect(build(2, { replace: first }).prompts[0]).toBe(motionReplace(2));
    expect(build(2, { replace: "Swap <image1>'s face with <image2>'s." }).prompts[0]).toBe("Swap <image1>'s face with <image2>'s.");
    expect(build(1).prompts[1]).toBe(MOTION_RELIGHT);
  });

  it("relights from the picture made alone: given the photos, the relight pasted them in as more people", () => {
    const relight = build(3).nodes.filter((x) => x.class_type === "TextEncodeQwenImage21")[1]!;
    expect(Object.keys(relight.inputs).filter((k) => k.startsWith("images."))).toEqual(["images.image_1"]);
  });

  it("scores the face where the frame's main person stands when the pack has Face At, else as before", () => {
    const at = build(2).nodes.find((x) => x.class_type === FACE_AT_NODE)!;
    const frame = build(2).nodes.find((x) => x.class_type === "TextEncodeQwenImage21")!.inputs["images.image_1"];
    expect(at.inputs.frame).toEqual(frame);
    expect(Object.keys(at.inputs).filter((k) => k.startsWith("photo_"))).toEqual(["photo_1", "photo_2"]);
    const older = build(2, {}, (node) => node !== FACE_AT_NODE).nodes;
    expect(older.some((x) => x.class_type === FACE_NODE) && !older.some((x) => x.class_type === FACE_AT_NODE)).toBe(true);
    // the photos are loaded once, for the edit and the score
    expect(build(2).nodes.filter((x) => x.class_type === "LoadImage")).toHaveLength(3);
  });
});

describe("Qwen Image 2.1's prompt rules", () => {
  const lint = (family: string, text: string) => familyById(family)?.lint?.({ text, main: "prompt", changes: { prompt: text } }).map((l) => l.text) ?? [];
  it("holds no word cap for 2.1 (its rewriter writes 400 to 500 words), where Qwen Image keeps 200", () => {
    const long = Array.from({ length: 450 }, () => "word").join(" ");
    expect(lint("qwen21", long)).toEqual([]);
    expect(lint("qwen", long)).toEqual([expect.stringMatching(/200/)]);
  });
});
