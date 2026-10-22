import { describe, expect, it } from "vitest";
import { settleEdits, withFilledInputs, withServerInputs } from "../src/timeline/useClipEdits";

const none = new Set<string>();

describe("a clip's edit in the timeline editor", () => {
  it("is dropped once the server has it", () => {
    const edits = { c1: { prompt: "a walk", seed: 5 } };
    expect(settleEdits(edits, [{ id: "c1", inputs: { prompt: "a walk", seed: 5 } }], none)).toEqual({});
  });

  it("is dropped after a render moved the seed on the server", () => {
    // typed, saved, then the render's own PATCH moved the seed: the server has seed 6, the edit said 5
    let edits: Record<string, Record<string, unknown>> = { c1: { prompt: "a walk", seed: 5 } };
    edits = withServerInputs(edits, "c1", { prompt: "a walk", seed: 6 }, none);
    edits = settleEdits(edits, [{ id: "c1", inputs: { prompt: "a walk", seed: 6 } }], none);
    expect(edits).toEqual({});
    // a later change made on the server to that clip is then what shows
    expect(settleEdits(edits, [{ id: "c1", inputs: { prompt: "a run", seed: 6 } }], none)).toEqual({});
  });

  it("keeps what was typed since and is not saved yet", () => {
    const edits = { c1: { prompt: "a run", seed: 5 } };
    const unsaved = new Set(["c1"]);
    expect(withServerInputs(edits, "c1", { prompt: "a walk", seed: 6 }, unsaved)).toBe(edits);
    expect(settleEdits(edits, [{ id: "c1", inputs: { prompt: "a walk", seed: 6 } }], unsaved)).toBe(edits);
  });

  it("is not made for a clip that had none", () => {
    const edits = {};
    expect(withServerInputs(edits, "c1", { seed: 6 }, none)).toBe(edits);
  });
});

describe("a clip's save answered with what the server worked out (a voice's part)", () => {
  const sent = { description: "a talk", recording: "r1" };
  const kept = { description: "a talk", recording: "r1", recordingStart: 0, recordingSeconds: 7 };

  it("shows the form as kept, and is dropped once read back", () => {
    let edits: Record<string, Record<string, unknown>> = { c1: sent };
    edits = withFilledInputs(edits, "c1", sent, kept);
    expect(edits.c1).toEqual(kept);
    expect(settleEdits(edits, [{ id: "c1", inputs: kept }], none)).toEqual({});
  });

  it("leaves what was typed since as it is: its own save is answered the same way", () => {
    const typed = { c1: { description: "a talk", recording: "r2" } };
    expect(withFilledInputs(typed, "c1", sent, kept)).toBe(typed);
    expect(withFilledInputs({}, "c1", sent, kept)).toEqual({});
  });
});
