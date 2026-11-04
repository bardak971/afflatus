import { describe, expect, it } from "vitest";
import { dryContext, inBoxOf, MAX_BOXES, parseInput, type BuiltGraph, type Recipe, type RegionValue } from "@afflatus/core";
import { recipes } from "../src";
import { areaSize, FEATHER, kontextSize, pixelBox, planBox, type Box } from "../src/shared/boxEdit";

// Edit in a box (card #284): the crop round each box, the paste back, and the boxes one after another in one graph
const recipe = (id: string) => recipes.find((r) => r.id === id)!;
const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const nodes = (b: BuiltGraph, type: string) => Object.entries(b.graph).filter(([, n]) => n.class_type === type);
const QWEN21 = { unet: "qwen_image_2.1_int8_convrot.safetensors", clip: "qwen3vl_8b_int8_convrot.safetensors", vae: "qwen_image_2.1_vae_bf16.safetensors" };
const picture = { w: 1216, h: 832 };
const box = (x: number, y: number, w: number, h: number, prompt = "a deer drinking at the stream", id = `r${x}${y}`): RegionValue => ({ id, box: { x, y, w, h }, prompt });
const build = (r: Recipe<any>, input: Record<string, unknown>, has: (n: string) => boolean = () => true) =>
  r.build(parseInput(r, { source: "p", ...input }), dryContext({ slots: QWEN21, uploads: { source: "s.png" }, media: { source: { width: picture.w, height: picture.h } }, has }));

describe("where a box is cropped and pasted", () => {
  it("reads a box in shares of the picture as whole pixels within it, a sliver grown to the least box", () => {
    expect(pixelBox({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, picture)).toEqual({ x: 304, y: 416, w: 608, h: 208 });
    expect(pixelBox({ x: 0.999, y: 0, w: 0.001, h: 0.001 }, picture)).toMatchObject({ x: 1200, w: 16, h: 16 });
  });

  it("crops the box with its margin, within the picture, grown to the editor's shape so that both sides scale alike", () => {
    const working = areaSize(1024 * 1024, 32);
    const plan = planBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, picture, working);
    expect(inside(plan.box, plan.crop)).toBe(true);
    expect(inside(plan.crop, { x: 0, y: 0, ...picture })).toBe(true);
    // about 30 % of the box round it, at least
    expect(plan.box.x - plan.crop.x).toBeGreaterThanOrEqual(Math.floor(0.3 * Math.sqrt(plan.box.w * plan.box.h)) - 1);
    expect(plan.crop.w / plan.crop.h).toBeCloseTo(plan.work.w / plan.work.h, 1);
    expect(plan.work.w % 32 + plan.work.h % 32).toBe(0);
    expect(plan.inner).toEqual({ x: plan.box.x - plan.crop.x, y: plan.box.y - plan.crop.y, w: plan.box.w, h: plan.box.h });
  });

  it("fades the paste inside the box on every side but one the picture's own edge cuts", () => {
    const middle = planBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, picture, kontextSize);
    const f = Math.round(FEATHER * Math.min(middle.box.w, middle.box.h));
    expect(middle.feather).toEqual({ left: f, top: f, right: f, bottom: f });
    const corner = planBox({ x: 0, y: 0.7, w: 0.3, h: 0.3 }, picture, kontextSize);
    expect(corner.feather).toMatchObject({ left: 0, bottom: 0 });
    expect(corner.feather.top).toBeGreaterThan(0);
  });

  it("reads the colours round the box from the crop's bands about it, none when the box fills the picture", () => {
    const plan = planBox({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, picture, kontextSize);
    expect(plan.ring).toHaveLength(4);
    for (const band of plan.ring) expect(inside(band, { x: 0, y: 0, w: plan.crop.w, h: plan.crop.h }) && !inside(band, plan.inner)).toBe(true);
    expect(planBox({ x: 0, y: 0, w: 1, h: 1 }, picture, kontextSize).ring).toEqual([]);
  });

  it("brings a crop to the Kontext size nearest its shape, as FluxKontextImageScale does", () => {
    expect(kontextSize(1)).toEqual({ w: 1024, h: 1024 });
    expect(kontextSize(1.5)).toEqual({ w: 1248, h: 832 });
    expect(kontextSize(0.1)).toEqual({ w: 672, h: 1568 });
  });
});

describe("an Edit in box of every instruction editor", () => {
  it("is there for Qwen Image Edit, Qwen Image 2.1, Klein and Kontext, hidden, its instruction each box's own", () => {
    for (const edit of ["qwen.edit", "qwen21.edit", "klein.edit", "flux.edit"]) {
      const r = recipe(inBoxOf(edit));
      expect(r, edit).toBeDefined();
      expect(r.hidden).toBe(true);
      expect(r.family).toBe(recipe(edit).family);
      expect(r.inputs.map((i) => i.id)).toEqual([...recipe(edit).inputs.filter((i) => i.id !== "prompt").map((i) => i.id), "boxes"]);
      expect(r.inputs.find((i) => i.id === "boxes")).toMatchObject({ type: "regions", max: MAX_BOXES });
    }
  });

  it("does the boxes one after another, each cropping what the one before left, the model loaded once", () => {
    const r = recipe("qwen21.edit-in-box");
    const b = build(r, { boxes: [box(0.1, 0.1, 0.2, 0.2, "a deer", "a"), box(0.6, 0.5, 0.3, 0.3, "a red bicycle", "b"), box(0.4, 0.05, 0.2, 0.2, "remove the lamp", "c")] });
    expect(nodes(b, "UNETLoader")).toHaveLength(1);
    expect(nodes(b, "VAELoader")).toHaveLength(1);
    expect(nodes(b, "KSampler")).toHaveLength(3);
    expect(b.passes).toHaveLength(3);
    expect(b.totalSteps).toBe(3 * 40);
    // each box's own instruction, in order
    expect(nodes(b, "TextEncodeQwenImage21").map(([, n]) => n.inputs.prompt)).toEqual(["a deer", "a red bicycle", "remove the lamp"]);
    // the pastes chained: each on the one before, the first on the picture
    const pastes = nodes(b, "ImageCompositeMasked");
    expect(pastes).toHaveLength(3);
    const load = nodes(b, "LoadImage").find(([, n]) => n.inputs.image === "s.png")![0];
    expect(pastes.map(([, n]) => (n.inputs.destination as [string, number])[0])).toEqual([load, pastes[0]![0], pastes[1]![0]]);
    // the second box's crop is of the picture the first left, not of the original
    const crops = nodes(b, "ImageScale").filter(([, n]) => n.inputs.upscale_method === "lanczos" && (b.graph[(n.inputs.image as [string, number])[0]]!.class_type === "ImageCrop"));
    const cropOf = (i: number) => b.graph[(crops[i]![1].inputs.image as [string, number])[0]]!.inputs.image as [string, number];
    expect(cropOf(1)[0]).toBe(pastes[0]![0]);
    expect(cropOf(2)[0]).toBe(pastes[1]![0]);
    // one picture comes out, the last paste
    expect(b.outputs).toEqual([{ node: expect.any(String), kind: "image", role: "result" }]);
    expect(b.graph[b.outputs[0]!.node]!.inputs.images).toEqual([pastes[2]![0], 0]);
  });

  it("takes the edit as three channels before matching and pasting it: Qwen Image 2.1 decodes four (RGBA)", () => {
    const b = build(recipe("qwen21.edit-in-box"), { boxes: [box(0.3, 0.3, 0.3, 0.3)] });
    const decode = nodes(b, "VAEDecode")[0]![0];
    const split = nodes(b, "SplitImageWithAlpha");
    expect(split.map(([, n]) => n.inputs.image)).toEqual([[decode, 0]]);
    // what is scaled back is the split's picture, never the decode's own
    expect(nodes(b, "ImageScale").some(([, n]) => (n.inputs.image as [string, number])[0] === decode)).toBe(false);
  });

  it("matches the colours at the box's edge where it can, and says so where this ComfyUI has no ColorTransfer", () => {
    const r = recipe("klein.edit-in-box");
    const matched = build(r, { boxes: [box(0.3, 0.3, 0.3, 0.3)] });
    const transfer = nodes(matched, "ColorTransfer");
    expect(transfer).toHaveLength(1);
    expect(transfer[0]![1].inputs).toMatchObject({ source_stats: "target_frame", "source_stats.target_index": 1, method: "reinhard_lab" });
    const plain = build(r, { boxes: [box(0.3, 0.3, 0.3, 0.3)] }, (n) => n !== "ColorTransfer");
    expect(nodes(plain, "ColorTransfer")).toHaveLength(0);
    expect(plain.warnings?.join(" ")).toContain("without matching their colours");
  });

  it("hands the editor its crop at its working size, the reference pictures as they were", () => {
    const r = recipe("qwen.edit-in-box");
    const b = r.build(parseInput(r, { source: "p", boxes: [box(0.3, 0.3, 0.3, 0.3)], references: [{ asset: "a", role: "object" }] }), dryContext({
      slots: { unet: "u", clip: "c", vae: "v", edit: "qwen_image_edit_2511.safetensors" }, uploads: { source: "s.png", "references.0": "a.png" }, media: { source: { width: picture.w, height: picture.h } },
    }));
    expect(nodes(b, "LoadImage").map(([, n]) => n.inputs.image).sort()).toEqual(["a.png", "s.png"]);
    const scale = b.graph[(nodes(b, "FluxKontextImageScale")[0]![1].inputs.image as [string, number])[0]]!;
    expect(scale.class_type).toBe("ImageScale");
    expect(kontextSize(Number(scale.inputs.width) / Number(scale.inputs.height))).toEqual({ w: scale.inputs.width, h: scale.inputs.height });
  });

  it("refuses no box, and a box that says nothing to do", () => {
    const r = recipe("flux.edit-in-box");
    const ctx = dryContext({ slots: { kontext: "k" }, uploads: { source: "s.png" }, media: { source: { width: 800, height: 600 } } });
    expect(() => r.build(parseInput(r, { source: "p", boxes: [] }), ctx)).toThrow("Draw a box");
    expect(() => r.build(parseInput(r, { source: "p", boxes: [box(0.1, 0.1, 0.2, 0.2), box(0.5, 0.5, 0.2, 0.2, " ")] }), ctx)).toThrow("Box 2 says nothing");
  });
});
