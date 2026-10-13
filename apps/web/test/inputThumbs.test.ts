import { describe, expect, it } from "vitest";
import type { InputSpec } from "@afflatus/core";
import { layoutOf, summariesOf, thumbsOf } from "../src/form";
import type { RecipeInfo } from "../src/api";

const lipSync: RecipeInfo = {
  id: "test.lipsync", family: "test", version: 1, title: "Lip sync", summary: "A test.", output: "video", traits: null,
  inputs: [
    { id: "recording", type: "audio", role: "sound", label: "Recording" },
    { id: "start", type: "image", role: "start", label: "First frame", optional: true },
    { id: "previous", type: "clip", role: "previous", label: "Previous clip", optional: true, frames: [22], fps: 24 },
  ] as InputSpec[],
};

describe("the small pictures of the Inputs part's folded line", () => {
  it("are drawn for the frames and clips chosen, never for a recording (it has no picture)", () => {
    const values = { recording: "zz-test-sound", start: "zz-test-picture", previous: { asset: "zz-test-clip" } };
    const said = summariesOf(lipSync, layoutOf(lipSync, values, ""), values, {});
    // the recording is chosen like a frame, and named in the line
    expect(said.framesChosen.map((i) => i.id)).toEqual(["recording", "start", "previous"]);
    expect(said.inputsSaid).toContain("recording");
    expect(thumbsOf(said.framesChosen, values).map((t) => t.id)).toEqual(["zz-test-picture", "zz-test-clip"]);
  });
});
