import { describe, expect, it } from "vitest";
import { stepSaid } from "../src";

/** A pod's boot log steps, as the screens' phase line and the server's notices both say them. */

describe("a boot log's step in power-user words", () => {
  it("says start.sh's steps as what runs, keeping a pip count and a failed step's exit code", () => {
    expect(stepSaid("checking the GPU")).toBe("checking GPU");
    expect(stepSaid("preparing ComfyUI's folders")).toBe("creating model folders");
    expect(stepSaid("putting in the node packs (exit 1)")).toBe("linking node packs (exit 1)");
    expect(stepSaid("installing the Python packages of ComfyUI-KJNodes (3/14)")).toBe("pip: ComfyUI-KJNodes (3/14)");
    expect(stepSaid("installing the Python packages of insightface")).toBe("pip: insightface");
    expect(stepSaid("setting up ComfyUI-Manager")).toBe("configuring ComfyUI-Manager");
    expect(stepSaid("the GPU does not work on this host: CUDA unknown error")).toBe("GPU fault: CUDA unknown error");
  });

  it("leaves a step it does not know as the pod says it", () => {
    expect(stepSaid("starting ComfyUI")).toBe("starting ComfyUI");
    expect(stepSaid("something new (exit 2)")).toBe("something new (exit 2)");
  });
});
