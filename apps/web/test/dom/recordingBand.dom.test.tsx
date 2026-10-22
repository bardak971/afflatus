import { describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
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
  return { asked, ...draw(<RecordingBands timeline={timeline} slots={layout(clips, 40, [model])} recipes={[model]} pps={40} onTrim={(a, f, t) => void asked.push(`${a} ${f}–${t}`)} onSelect={(c) => asked.push(`open ${c}`)} />) };
}

describe("a recording on the Audio row", () => {
  it("is one band under its clips: its name, the stretch they use, what a trim set aside", () => {
    band();
    expect(screen.getByLabelText("Recording zz-test talk.wav, 0:02.0–0:12.2, 1 set aside")).toBeTruthy();
  });

  it("opens its first clip on a click, and slips when its body is dragged", () => {
    const { asked } = band();
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

  it("moves its start by its left edge and its end by its right one, one trim a release", () => {
    const { asked, container } = band();
    const start = container.querySelector<HTMLElement>('[data-tip^="Drag: where the recording starts"]')!;
    const end = container.querySelector<HTMLElement>('[data-tip^="Drag: where the recording ends"]')!;
    // 40 px a second: the left edge dragged 40 px to the right starts it a second later, its end where it was
    fireEvent.pointerDown(start, { button: 0, clientX: 100 });
    fireEvent.pointerMove(start, { clientX: 140 });
    fireEvent.pointerUp(start, { clientX: 140 });
    expect(asked).toEqual(["zz-test-talk 3000–12200"]);
    // the right edge dragged 40 px to the left ends it a second sooner, its start where it was
    fireEvent.pointerDown(end, { button: 0, clientX: 500 });
    fireEvent.pointerMove(end, { clientX: 460 });
    fireEvent.pointerUp(end, { clientX: 460 });
    expect(asked).toEqual(["zz-test-talk 3000–12200", "zz-test-talk 2000–11200"]);
    // a press on an edge without a move trims nothing: it opens the first clip, as a click on the band does
    fireEvent.pointerDown(end, { button: 0, clientX: 500 });
    fireEvent.pointerUp(end, { clientX: 500 });
    expect(asked.slice(2)).toEqual(["open c1"]);
  });
  it("draws the stretch released until its clips read back have it, and the old one again when it is not made (W-9)", async () => {
    const answers: Array<(taken: boolean) => void> = [];
    const onTrim = () => new Promise<boolean>((done) => answers.push(done));
    const bands = (cs: Clip[]) => <RecordingBands timeline={{ ...timeline, clips: cs }} slots={layout(cs, 40, [model])} recipes={[model]} pps={40} onTrim={onTrim} onSelect={() => {}} />;
    const { container, rerender } = draw(bands(clips));
    const pull = (by: number) => {
      const start = container.querySelector<HTMLElement>('[data-tip^="Drag: where the recording starts"]')!;
      fireEvent.pointerDown(start, { button: 0, clientX: 100 });
      fireEvent.pointerMove(start, { clientX: 100 + by });
      fireEvent.pointerUp(start, { clientX: 100 + by });
    };
    // 40 px a second: its start a second later, drawn so while it is sent, and taken
    pull(40);
    expect(screen.getByLabelText("Recording zz-test talk.wav: 0:03.0–0:12.2")).toBeTruthy();
    await act(async () => answers[0]!(true));
    expect(screen.getByLabelText("Recording zz-test talk.wav: 0:03.0–0:12.2")).toBeTruthy();
    // its clips made anew from there, read back: what they say is drawn
    const anew = [part("c3", 3.1, 4.7), part("c4", 7.8, 4.4)];
    rerender(bands(anew));
    expect(screen.getByLabelText("Recording zz-test talk.wav: 0:03.1–0:12.2")).toBeTruthy();
    // one not made (asked first, or failed): its clips' stretch again at once
    pull(40);
    expect(screen.getByLabelText("Recording zz-test talk.wav: 0:04.1–0:12.2")).toBeTruthy();
    await act(async () => answers[1]!(false));
    expect(screen.getByLabelText("Recording zz-test talk.wav: 0:03.1–0:12.2")).toBeTruthy();
  });
});
