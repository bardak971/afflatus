import { describe, expect, it } from "vitest";
import { dryContext, parseInput, pickChoice, type ChoiceInput } from "@afflatus/core";
import { h3Video, ltxVideo, tools, UPSCALE, wanVideo } from "../src";
import { DETECTOR_INPUT } from "../src/shared/detector";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const of = (graph: Graph, type: string) => Object.values(graph).filter((n) => n.class_type === type);
const picture = { width: 832, height: 1216 };
const wanSlots = { i2vHigh: "h.safetensors", i2vLow: "l.safetensors", clip: "c.safetensors", vae: "v.safetensors" };
const ltxSlots = { checkpoint: "ltx-2.3-22b-distilled-fp8.safetensors", clip: "gemma.safetensors", upscaler: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors" };
const h3Slots = { unet: "u.safetensors", clip: "c.safetensors", videoVae: "v.safetensors", audioVae: "a.safetensors" };
const ctx = (slots: Record<string, string>, has?: (t: string) => boolean) => dryContext({ slots, uploads: { start: "a.png" }, media: { start: picture }, ...(has ? { has } : {}) });

const wan = (over: Record<string, unknown>, has?: (t: string) => boolean) => wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", ...over }), ctx(wanSlots, has)).graph as Graph;
const ltx = (over: Record<string, unknown>) => ltxVideo.build(parseInput(ltxVideo, { prompt: "a", start: "p", ...over }), ctx(ltxSlots)).graph as Graph;
const h3 = (over: Record<string, unknown>) => h3Video.build(parseInput(h3Video, { description: "a", start: "p", ...over }), ctx(h3Slots)).graph as Graph;
const byModel = { upscale: UPSCALE.model, upscaleModel: "2x.pth" };

describe("RCAS after the upscale", () => {
  it("is off by default, with an upscale route or without", () => {
    for (const graph of [wan(byModel), ltx(byModel), h3(byModel), wan({})]) expect(of(graph, "ImageSharpenKJ")).toEqual([]);
  });
  it("sharpens the upscaled frames with RCAS at the strength asked for, in every video family", () => {
    for (const graph of [wan({ ...byModel, upscaleSharpen: 0.3 }), ltx({ ...byModel, upscaleSharpen: 0.3 }), h3({ ...byModel, upscaleSharpen: 0.3 })]) {
      const [sharp] = of(graph, "ImageSharpenKJ");
      expect(sharp?.inputs).toMatchObject({ method: "rcas", "method.strength": 0.3 });
      // after the upscale: what it sharpens comes out of the upscale model's chain
      const from = graph[(sharp!.inputs.image as [string, number])[0]]!;
      expect(["ImageScale", "RebatchImages"]).toContain(from.class_type);
    }
  });
  it("runs after RTX and SeedVR2 too", () => {
    expect(of(wan({ upscale: UPSCALE.rtx, upscaleSharpen: 0.3 }), "ImageSharpenKJ")).toHaveLength(1);
    const seedvr = wanVideo.build(parseInput(wanVideo, { prompt: "a", start: "p", upscale: UPSCALE.seedvr, upscaleSharpen: 0.3 }), ctx({ ...wanSlots, seedvr: "s.safetensors", seedvrVae: "sv.safetensors" })).graph as Graph;
    const [sharp] = of(seedvr, "ImageSharpenKJ");
    expect(sharp).toBeDefined();
  });
  it("does nothing without an upscale route, on H3's latent re-sample, or without KJNodes", () => {
    expect(of(wan({ upscaleSharpen: 0.3 }), "ImageSharpenKJ")).toEqual([]);
    expect(of(h3({ upscale: UPSCALE.latent, upscaleSharpen: 0.3 }), "ImageSharpenKJ")).toEqual([]);
    expect(of(wan({ ...byModel, upscaleSharpen: 0.3 }, (t) => t !== "ImageSharpenKJ"), "ImageSharpenKJ")).toEqual([]);
  });
  it("is offered on the three video forms, only when a pixel route is picked", () => {
    for (const recipe of [wanVideo, ltxVideo, h3Video]) {
      const input = recipe.inputs.find((i) => i.id === "upscaleSharpen");
      expect(input).toMatchObject({ type: "number", min: 0, max: 1, step: 0.05, default: 0 });
      expect(input?.showWhen).toEqual({ input: "upscale", in: [UPSCALE.model, UPSCALE.rtx, UPSCALE.seedvr] });
    }
  });
});

describe("the detectors as downloads", () => {
  it("are optional image-tools files that land in models/ultralytics/bbox", () => {
    const face = tools.slots.find((s) => s.id === "faceDetector");
    const hand = tools.slots.find((s) => s.id === "handDetector");
    expect(face).toMatchObject({ folder: "ultralytics", optional: true, get: { file: "bbox/face_yolov8m.pt", url: "https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt" } });
    expect(hand).toMatchObject({ folder: "ultralytics", optional: true, get: { file: "bbox/hand_yolov8s.pt", url: "https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8s.pt" } });
    // found as ComfyUI lists them, with the sub-folder in front (a backslash on Windows)
    expect(new RegExp(face!.detect[0]!, "i").test("bbox\\face_yolov8m.pt")).toBe(true);
    expect(face!.detect.some((d) => new RegExp(d, "i").test("bbox/hand_yolov8s.pt"))).toBe(false);
    expect(hand!.detect.some((d) => new RegExp(d, "i").test("bbox\\hand_yolov8s.pt"))).toBe(true);
  });
  it("leave the face detailer on a face detector when a hand detector is there too", () => {
    expect(pickChoice(DETECTOR_INPUT as ChoiceInput, ["bbox/hand_yolov8s.pt", "bbox/face_yolov8m.pt"])).toBe("bbox/face_yolov8m.pt");
    expect(pickChoice(DETECTOR_INPUT as ChoiceInput, ["bbox/hand_yolov8s.pt", "bbox/face_yolov8n.pt"])).toBe("bbox/face_yolov8n.pt");
  });
});
