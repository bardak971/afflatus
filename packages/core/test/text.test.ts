import { describe, expect, it } from "vitest";
import { isModelFile, MODEL_EXT, modelStem, plural, shortGpu, slug } from "../src";

describe("model files, one list for every place", () => {
  it("knows every extension a loader lists, whatever the case", () => {
    for (const f of ["a.safetensors", "a.SFT", "a.ckpt", "a.pt", "a.pth", "a.bin", "a.gguf", "a.onnx"]) expect(isModelFile(f)).toBe(true);
    for (const f of ["a.png", "a.safetensors.part", "safetensors", "a.engine"]) expect(isModelFile(f)).toBe(false);
    expect(MODEL_EXT.test("Wan\\x.GGUF")).toBe(true);
  });

  it("names a file without its folder and its extension (the .bin and .onnx two places missed)", () => {
    expect(modelStem("Wan\\wan_2.1_vae.safetensors")).toBe("wan_2.1_vae");
    expect(modelStem("detectors/face_yolov8m.onnx")).toBe("face_yolov8m");
    expect(modelStem("clip/model.bin")).toBe("model");
    expect(modelStem("notes.txt")).toBe("notes.txt");
  });
});

describe("slug and plural", () => {
  it("folds accents, keeps no dash at an end, stops at the length asked", () => {
    expect(slug("Crème brûlée")).toBe("creme-brulee");
    expect(slug("  Été / pluie!! ")).toBe("ete-pluie");
    expect(slug("夜の街")).toBe("");
    expect(slug("abc def ghi", 8)).toBe("abc-def");
  });

  it("says a count with its word", () => {
    expect(plural(1, "clip")).toBe("1 clip");
    expect(plural(0, "clip")).toBe("0 clips");
    expect(plural(2, "person", "people")).toBe("2 people");
  });
});

describe("a GPU's short name", () => {
  it("is one name whether ComfyUI or RunPod says it", () => {
    expect(shortGpu("cuda:0 NVIDIA GeForce RTX 4070 Ti : cudaMallocAsync")).toBe("RTX 4070 Ti");
    expect(shortGpu("NVIDIA GeForce RTX 4070 Ti")).toBe("RTX 4070 Ti");
    expect(shortGpu("NVIDIA RTX 6000 Ada Generation")).toBe("RTX 6000 Ada");
    expect(shortGpu("NVIDIA A40")).toBe("A40");
  });
});
