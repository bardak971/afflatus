import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import type { RecipeInfo } from "../src/api";
import { lighter, memoryThatRanOut, shorterStretch } from "../src/screens/queue/retry";

const recipe = (inputs: InputSpec[]): RecipeInfo => ({ id: "h3.video", family: "h3", version: 1, title: "Video", summary: "A clip.", output: "video", inputs, traits: null });
const video = recipe([
  { id: "shortSide", type: "number", label: "Short side", min: 256, max: 1080, step: 64, default: 704, unit: " px" },
  { id: "seconds", type: "number", label: "Length", min: 1, max: 10, step: 0.5, default: 5, unit: " s" },
  { id: "upscale", type: "choice", label: "Upscale", options: ["Off", "Latent: re-sampled"], default: "Off" },
  { id: "upscaleChunk", type: "number", label: "Stretch", min: 17, max: 81, step: 8, default: 49 },
]);

describe("the lighter retry after running out of memory", () => {
  it("takes one step off the size first", () => {
    expect(lighter(video, { shortSide: 704, seconds: 5 })).toEqual({ change: { shortSide: 640 }, label: "Retry at 640 px" });
  });
  it("shortens the clip by about a second when the size is already as small as it goes", () => {
    expect(lighter(video, { shortSide: 256, seconds: 5 })).toEqual({ change: { seconds: 4 }, label: "Retry at 4 s" });
  });
  it("offers nothing when neither can go lower, or the job is unknown", () => {
    expect(lighter(video, { shortSide: 256, seconds: 1 })).toBeNull();
    expect(lighter(undefined, { shortSide: 704 })).toBeNull();
    expect(lighter(video, null)).toBeNull();
  });
});

describe("which memory ran out", () => {
  it("tells the card from the machine", () => {
    expect(memoryThatRanOut("CUDA out of memory. Tried to allocate 2 GiB")).toBe("vram");
    expect(memoryThatRanOut("DefaultCPUAllocator: not enough memory")).toBe("ram");
    expect(memoryThatRanOut("KeyError: 'model'")).toBeNull();
    expect(memoryThatRanOut(null)).toBeNull();
  });
});

describe("the shorter stretch after a latent upscale ran out of memory", () => {
  it("takes two steps off the stretch of a latent upscale", () => {
    expect(shorterStretch(video, { upscale: "Latent: re-sampled", upscaleChunk: 49 })).toEqual({ change: { upscaleChunk: 33 }, label: "Retry with 33-frame stretches" });
  });
  it("offers nothing when the upscale was not latent, or the stretch is as short as it goes", () => {
    expect(shorterStretch(video, { upscale: "Off", upscaleChunk: 49 })).toBeNull();
    expect(shorterStretch(video, { upscale: "Latent: re-sampled", upscaleChunk: 17 })).toBeNull();
  });
});
