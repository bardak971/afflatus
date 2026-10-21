import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { layout } from "../../src/timeline/model";
import { RecordingBands } from "../../src/timeline/track/RecordingBand";
import { draw } from "./render";

/** A Lip sync model: its clips take a recording part by part. */
const model = {
  id: "zz-test.lipsync", family: "zz-test", title: "zz-test lip sync", output: "video", summary: "",
  inputs: [{ id: "recording", type: "audio", role: "sound", label: "Recording", window: { start: "recordingStart", seconds: "recordingSeconds" } }],
} as unknown as RecipeInfo;
const sound = { id: "zz-test-talk", name: "zz-test talk.wav", kind: "audio", durationMs: 15000 };
const part = (id: string, start: number, seconds: number) =>
  ({ id, kind: "video", recipe: model.id, joined: "continue", atMs: start * 1000, lengthMs: seconds * 1000, inputs: { recording: sound.id, recordingStart: start, recordingSeconds: seconds }, music: null, take: null, takes: [] }) as unknown as Clip;
const clips = [part("c1", 2, 4.7), part("c2", 6.7, 5.5)];
const timeline = { id: "zz-test-tl", clips, recordings: [{ asset: sound, parked: 1 }] } as unknown as Timeline;

function band() {
  const asked: string[] = [];
  draw(<RecordingBands timeline={timeline} slots={layout(clips, 40, [model])} recipes={[model]} pps={40} onTrim={(a, f, t) => asked.push(`${a} ${f}–${t}`)} onSelect={(c) => asked.push(`open ${c}`)} />);
  return asked;
}

describe("a recording on the Audio row", () => {
  it("is one band under its clips: its name, the stretch they use, what a trim set aside", () => {
    band();
    expect(screen.getByLabelText("Recording zz-test talk.wav, 0:02.0–0:12.2, 1 set aside")).toBeTruthy();
  });

  it("opens its first clip on a click, and slips when its body is dragged", () => {
    const asked = band();
    const body = screen.getByRole("button", { name: /Recording zz-test talk\.wav/ });
    fireEvent.pointerDown(body, { button: 0, clientX: 100 });
    fireEvent.pointerUp(body, { clientX: 100 });
    expect(asked).toEqual(["open c1"]);
    // 40 px a second: dragged 40 px to the left, the recording slides a second later under its clips
    fireEvent.pointerDown(body, { button: 0, clientX: 100 });
    fireEvent.pointerMove(body, { clientX: 60 });
    fireEvent.pointerUp(body, { clientX: 60 });
    expect(asked.at(-1)).toBe("zz-test-talk 3000–13200");
  });
});
