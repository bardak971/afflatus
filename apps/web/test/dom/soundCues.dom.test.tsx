import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { CueValue, InputSpec } from "@afflatus/core";
import { Field } from "../../src/fields";
import { CueMarks } from "../../src/timeline/track/CueMarks";
import { fakeApi } from "./fakeApi";
import { draw } from "./render";

/** H3's sound cues in a form: one row per cue (its sound, its part, when it lands), and a ♪ on the clip where each lands. */

const cuesSpec = { id: "cues", type: "cues", label: "Sound cues", max: 6 } as InputSpec;
const specs: InputSpec[] = [
  { id: "seconds", type: "number", label: "Duration", min: 4, max: 15, step: 0.5, default: 5, unit: " s" },
  cuesSpec,
  { id: "cueSound", type: "choice", label: "In the take", options: ["The file's sound", "H3's own"], default: "The file's sound", showWhen: "cues" },
];
const door: CueValue = { asset: "zz-test-door", start: 0.1, seconds: 0.6, at: 2.4 };

function Cues({ start }: { start: CueValue[] }) {
  const [value, setValue] = useState<CueValue[]>(start);
  return (
    <>
      <Field spec={cuesSpec} value={value} values={{ seconds: 5, cues: value }} specs={specs} options={undefined} onChange={(v) => setValue(v as CueValue[])} />
      <output aria-label="value">{JSON.stringify(value)}</output>
    </>
  );
}
const valueShown = () => JSON.parse(screen.getByLabelText("value").textContent!) as CueValue[];

describe("sound cues in a form", () => {
  it("are a row each: the part used and when it lands, both set in place", async () => {
    fakeApi.on("GET /assets/:id", ({ params }) => ({ id: params.id, kind: "audio", name: "zz-test door.wav", durationMs: 2000, mime: "audio/wav" }));
    draw(<Cues start={[door]} />);
    expect(screen.getByText("1 of 6")).toBeTruthy();
    const starts = await screen.findByRole("textbox", { name: "Sound cue 1: the part used starts at, in seconds" });
    const ends = screen.getByRole("textbox", { name: "Sound cue 1: the part used ends at, in seconds" });
    const at = screen.getByRole("textbox", { name: "Sound cue 1: lands at, in seconds of the clip" });
    expect([(starts as HTMLInputElement).value, (ends as HTMLInputElement).value, (at as HTMLInputElement).value]).toEqual(["0.1", "0.7", "2.4"]);
    fireEvent.change(at, { target: { value: "3.2" } });
    fireEvent.blur(at);
    await waitFor(() => expect(valueShown()[0]).toMatchObject({ at: 3.2, start: 0.1, seconds: 0.6 }));
    fireEvent.change(ends, { target: { value: "1.5" } });
    fireEvent.blur(ends);
    await waitFor(() => expect(valueShown()[0]).toMatchObject({ start: 0.1, seconds: 1.4 }));
    // another can be added while there is room; one removed goes
    expect(screen.getByRole("button", { name: /Add a sound cue, or drop one here/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove sound cue 1" }));
    await waitFor(() => expect(valueShown()).toEqual([]));
  });

  it("says a cue that lands past the clip's end on its row", async () => {
    fakeApi.on("GET /assets/:id", ({ params }) => ({ id: params.id, kind: "audio", name: "zz-test door.wav", durationMs: 2000, mime: "audio/wav" }));
    draw(<Cues start={[door, { ...door, at: 6 }]} />);
    expect(await screen.findByText(/Lands past the clip's end \(5\.0 s\)/)).toBeTruthy();
    expect(screen.getAllByText(/Lands past the clip's end/)).toHaveLength(1);
  });

  it("start a sound added with all of it, cut where its file ends, landing at the clip's start", async () => {
    fakeApi.on("GET /assets/:id", ({ params }) => ({ id: params.id, kind: "audio", name: "zz-test clap.wav", durationMs: 800, mime: "audio/wav" }));
    draw(<Cues start={[{ asset: "zz-test-clap", start: 0, seconds: 15, at: 0 }]} />);
    await waitFor(() => expect(valueShown()[0]).toMatchObject({ start: 0, seconds: 0.8, at: 0 }));
  });
});

describe("sound cues on the track", () => {
  it("are a ♪ where each lands on the clip, none past what it shows", () => {
    const { container } = draw(
      <div style={{ position: "relative", width: 500 }}>
        <CueMarks inputs={{ cues: [door, { ...door, at: 0 }, { ...door, at: 9 }] }} specs={specs} lengthMs={5000} />
      </div>,
    );
    const marks = [...container.querySelectorAll<HTMLElement>("[data-cue-mark]")];
    expect(marks.map((m) => m.textContent)).toEqual(["♪", "♪"]);
    expect(marks.map((m) => m.style.left)).toEqual(["48%", "2%"]);
    expect(marks[0]!.dataset.tip).toBe("Sound cue 1: lands at 2.4 s, 0.6 s of its sound");
  });

  it("are none on a clip without cues, or of a model without them", () => {
    const { container } = draw(<CueMarks inputs={{ cues: [door] }} specs={[]} lengthMs={5000} />);
    expect(container.querySelector("[data-cue-mark]")).toBeNull();
  });
});
