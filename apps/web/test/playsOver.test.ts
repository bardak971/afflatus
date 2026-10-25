import { describe, expect, it } from "vitest";
import type { Clip, RecipeInfo } from "../src/api";
import { overPart, playsOver } from "../src/timeline/track/RecordingBand";

/**
 * Whether a recording plays over a clip (cards #72, #88): only a clip in a form it plays over that has a part of it, and the
 * track says which part. A clip with the recording set and no part (Timeline 10's clip past the recording's end) is not one.
 */
const window = { start: "recordingStart", seconds: "recordingSeconds", even: "evenLoudness", goesOn: "recordingGoesOn", leadIn: "recordingLeadIn", fits: { frames: 362, fps: 24, pad: 0.25, min: 4 } };
const recording = { id: "recording", type: "audio", role: "sound", label: "Recording", window };
const lipSync = { id: "zz-test.lipsync", family: "zz-h3", title: "Lip sync", output: "video", inputs: [recording], traits: { sound: true } } as unknown as RecipeInfo;
const video = { id: "zz-test.video", family: "zz-h3", title: "Video with audio", output: "video", inputs: [{ ...recording, optional: true, internal: true }], traits: { sound: true } } as unknown as RecipeInfo;
const recipes = [lipSync, video];
const clip = (recipe: string, inputs: Record<string, unknown>) => ({ id: "zz-test-clip", kind: "video", recipe, inputs }) as unknown as Clip;

describe("a recording playing over a clip", () => {
  it("is said with its part on a Video with audio clip under it", () => {
    const c = clip("zz-test.video", { recording: "zz-test-song", recordingStart: 10.9, recordingSeconds: 7.6 });
    expect(playsOver(c, recipes)).toBe(true);
    expect(overPart(c, recipes)).toBe("0:10.9–0:18.5");
  });

  it("never with no part of it to play, nor on Lip sync, nor with no recording", () => {
    expect(playsOver(clip("zz-test.video", { recording: "zz-test-song", recordingStart: 7.6, recordingSeconds: 0 }), recipes)).toBe(false);
    expect(playsOver(clip("zz-test.video", { recording: "zz-test-song" }), recipes)).toBe(false);
    expect(playsOver(clip("zz-test.lipsync", { recording: "zz-test-song", recordingStart: 0, recordingSeconds: 5 }), recipes)).toBe(false);
    // Timeline 10's clip 2 once its recording was taken off: its old part left in its form
    expect(playsOver(clip("zz-test.video", { recordingStart: 0, recordingSeconds: 7.6 }), recipes)).toBe(false);
  });
});
