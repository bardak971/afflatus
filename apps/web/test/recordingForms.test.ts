import { describe, expect, it } from "vitest";
import type { RecipeInfo } from "../src/api";
import { recordingFormOptions } from "../src/timeline/recordingForms";

/**
 * A clip's model list under a recording (cards #72, #82): Lip sync, whose mouth follows its part, then the forms the recording
 * plays over, Wan among them, each saying how it meets the clip before.
 */
const window = { start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness", goesOn: "recordingGoesOn", leadIn: "recordingLeadIn" };
const lipSync = {
  id: "zz-test.lipsync", family: "zz-h3", title: "Lip sync", output: "video", summary: "", version: 1,
  inputs: [{ id: "recording", type: "audio", role: "sound", label: "Recording", window: { ...window, fits: { frames: 362, fps: 24, pad: 0.25, min: 4 } } }],
  traits: { sound: true, continues: "clip", latentNodes: ["zz-test-seam"], fps: 24, frameGrid: { step: 17, offset: 5 } },
} as unknown as RecipeInfo;
const wan = {
  id: "zz-test.wan", family: "zz-wan", title: "Video", output: "video", summary: "", version: 1,
  inputs: [{ id: "recording", type: "audio", role: "sound", label: "Recording", optional: true, internal: true, window: { ...window, fits: { frames: 241, fps: 16, pad: 0.25, min: 1, grid: { step: 4, offset: 1 } } } }],
  traits: { sound: false, continues: "clip", fps: 16, frameGrid: { step: 4, offset: 1 } },
} as unknown as RecipeInfo;
const families = [{ id: "zz-h3", name: "MiniMax H3" }, { id: "zz-wan", name: "Wan 2.2" }];

describe("the model list under a recording", () => {
  it("lists Wan as a form the recording plays over, carrying on after a Wan clip and a cut after an H3 one", () => {
    const after = (prior: RecipeInfo | undefined) => recordingFormOptions([wan, lipSync], families, prior).map((o) => [o.label, o.note]);
    expect(after(wan)).toEqual([["MiniMax H3 · Lip sync", "the mouth follows its part · a hard cut"], ["Wan 2.2 · Video", "plays over · carries on"]]);
    expect(after(lipSync)).toEqual([["MiniMax H3 · Lip sync", "the mouth follows its part · seamless"], ["Wan 2.2 · Video", "plays over · a hard cut"]]);
    expect(after(undefined)[1]).toEqual(["Wan 2.2 · Video", "plays over"]);
  });
});
