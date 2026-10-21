import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Clip, Take } from "../../src/api";
import { TakeList } from "../../src/timeline/inspector/takes";
import { draw } from "./render";

/** A clip's takes, each with how much its face is its person's (Face Match), the closest one marked (card #18). */
const take = (id: string, face?: number): Take =>
  ({ id, asset: { id: `a-${id}`, width: 576, height: 1024, durationMs: 5000 }, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 0, endMs: 5000, createdAt: "", finishedFrom: null, joinKind: null, roomMs: 5000, renderMs: null, measure: face != null ? { luma: 100, sharp: 10, face } : null, recipe: null }) as unknown as Take;

function list(takes: Take[], onFacePass?: (t: Take) => void) {
  const clip = { id: "c", kind: "video", takes, take: takes[0] } as unknown as Clip;
  draw(<TakeList clip={clip} take={takes[0]!} joinOf={() => undefined} smoothest={null} onPreview={() => {}} onPatch={() => {}} onRemoveTake={() => {}} onFacePass={onFacePass} />);
}
/** The rows' titles, top to bottom. */
const order = () => screen.getAllByText(/^Take \d$/).map((e) => e.textContent);

describe("the takes of a clip, with their face figure", () => {
  it("says each take's face and marks the closest", () => {
    list([take("1", 0.52), take("2", 0.71), take("3", 0.48)]);
    expect(screen.getByText("face 0.71")).toBeTruthy();
    expect(screen.getByText("face 0.48")).toBeTruthy();
    const marked = screen.getByText("closest face");
    expect(marked.closest("div")!.textContent).toMatch(/Take 2/);
  });

  it("marks none with a single take measured, says nothing for a take not measured", () => {
    list([take("1", 0.6), take("2")]);
    expect(screen.getByText("face 0.60")).toBeTruthy();
    expect(screen.queryByText("closest face")).toBeNull();
  });

  it("sorts the closest face first, each take keeping its number", () => {
    list([take("1", 0.52), take("2", 0.71), take("3", 0.48)]);
    expect(order()).toEqual(["Take 1", "Take 2", "Take 3"]);
    fireEvent.click(screen.getByRole("button", { name: "Closest face first" }));
    expect(order()).toEqual(["Take 2", "Take 1", "Take 3"]);
  });
});

describe("a take's Face pass", () => {
  it("is offered on a take, and its take says what it is", () => {
    const asked: string[] = [];
    const pass = { ...take("2", 0.7), finishedFrom: "1", facePass: true } as Take;
    list([take("1", 0.5), pass], (t) => asked.push(t.id));
    expect(screen.getByText("face pass of take 1")).toBeTruthy();
    // a Face pass of a Face pass is not offered
    expect(screen.queryByRole("button", { name: "Face pass of take 2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Face pass of take 1" }));
    expect(asked).toEqual(["1"]);
  });

  it("is not offered where the model has no Face refine", () => {
    list([take("1", 0.5)]);
    expect(screen.queryByRole("button", { name: /Face pass/ })).toBeNull();
  });
});
