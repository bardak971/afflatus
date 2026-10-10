import { describe, expect, it } from "vitest";
import { dryContext, parseInput, type Graph } from "@afflatus/core";
import { inspect, recipeFromWorkflow, type WorkflowDef } from "../src";
import { catalog, wan } from "./fixtures";

const titled = (title: string) => ({ _meta: { title } });
const defOf = (graph: Graph, bindings: NonNullable<ReturnType<typeof inspect>["suggested"]>): WorkflowDef =>
  ({ id: "workflow.zz-test", title: "zz-test", model: "Wan 2.2", source: "t.json", graph: graph as WorkflowDef["graph"], bindings });

describe("the frame rate the length is counted in", () => {
  it("is the output's rate divided by the frame interpolation between the decode and it", () => {
    // the common shape: RIFE doubles Wan's 16 frames a second, and the combine plays them at 32
    const g: Graph = structuredClone(wan);
    g["70"] = { class_type: "RIFE VFI", inputs: { frames: ["8", 0], ckpt_name: "rife47.pth", clear_cache_after_n_frames: 10, multiplier: 2, fast_mode: true, ensemble: true, scale_factor: 1 } };
    g["63"]!.inputs.images = ["70", 0];
    g["63"]!.inputs.frame_rate = 32;
    const found = inspect(structuredClone(g), catalog);
    expect(found.suggested!.length).toMatchObject({ fps: 16 });
    const recipe = recipeFromWorkflow(defOf(g, found.suggested!));
    expect(recipe.inputs.find((i) => i.id === "seconds")).toMatchObject({ default: 5 });
    expect(recipe.traits?.fps).toBe(16);
    const built = recipe.build(parseInput(recipe, { seconds: 5 }), dryContext({ uploads: { startImage: "a.png", endImage: "b.png" } }));
    expect(built.graph["50"]!.inputs.length).toBe(81);
  });
  it("follows the output's rate to the number node it is read from", () => {
    const g: Graph = structuredClone(wan);
    g["99"] = { class_type: "PrimitiveFloat", inputs: { value: 24 }, ...titled("FPS") };
    g["63"]!.inputs.frame_rate = ["99", 0];
    expect(inspect(g, catalog).suggested!.length).toMatchObject({ fps: 24 });
  });
  it("is the result's, not that of a preview typed in first", () => {
    const g: Graph = structuredClone(wan);
    g["1"] = { class_type: "VHS_VideoCombine", inputs: { images: ["8", 0], frame_rate: 8, loop_count: 0, filename_prefix: "preview", format: "image/gif", pingpong: false, save_output: false } };
    expect(inspect(g, catalog).suggested!.length).toMatchObject({ fps: 16 });
  });
  it("says so when an interpolation's multiplier cannot be read", () => {
    const g: Graph = structuredClone(wan);
    g["71"] = { class_type: "SomeMath", inputs: { a: ["37", 0], b: ["38", 0] } };
    g["70"] = { class_type: "RIFE VFI", inputs: { frames: ["8", 0], ckpt_name: "rife47.pth", multiplier: ["71", 0] } };
    g["63"]!.inputs.images = ["70", 0];
    const found = inspect(g, catalog);
    expect(found.suggested!.length).toMatchObject({ fps: 16 });
    expect(found.notes.some((n) => /multiplier/.test(n))).toBe(true);
  });
});

describe("the start and end pictures", () => {
  // a third picture beside the start and the end, loaded before them (a lower id), going to a preview
  const withThird = (title: string): Graph => ({
    ...structuredClone(wan),
    "40": { class_type: "LoadImage", inputs: { image: "pose.png" }, ...titled(title) },
    "41": { class_type: "ImageScale", inputs: { image: ["40", 0], upscale_method: "nearest-exact", width: 512, height: 512, crop: "disabled" } },
    "42": { class_type: "PreviewImage", inputs: { images: ["41", 0] } },
  });
  it.each(["OpenPose reference", "Blend overlay", "Pose image"])("a picture titled %s is neither", (title) => {
    const s = inspect(withThird(title), catalog).suggested!;
    expect(s.startImage?.target.node).toBe("52");
    expect(s.endImage?.target.node).toBe("53");
    expect(s.pictures.map((p) => p.target.node)).toEqual(["40"]);
  });
  it("go by their wiring before their titles", () => {
    const g: Graph = structuredClone(wan);
    // titled the wrong way round: the start_image and end_image inputs they go into say what they are
    Object.assign(g["52"]!, titled("Last frame"));
    Object.assign(g["53"]!, titled("First frame"));
    const s = inspect(g, catalog).suggested!;
    expect(s.startImage?.target.node).toBe("52");
    expect(s.endImage?.target.node).toBe("53");
  });
  it("go by whole words of their titles when the wiring does not tell", () => {
    const g: Graph = structuredClone(wan);
    // both go into a node that takes both pictures: the wiring past it does not say which is which
    g["45"] = { class_type: "ImageBatch", inputs: { image1: ["52", 0], image2: ["53", 0] } };
    g["50"]!.inputs.start_image = ["45", 0];
    delete g["50"]!.inputs.end_image;
    Object.assign(g["52"]!, titled("OpenPose"));
    Object.assign(g["53"]!, titled("LastFrame"));
    const found = inspect(g, catalog);
    expect(found.images.find((i) => i.node === "53")?.role).toBe("end");
    expect(found.images.find((i) => i.node === "52")?.role).not.toBe("end");
  });
});
