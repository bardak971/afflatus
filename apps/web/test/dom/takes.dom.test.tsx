import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { Clip, Take } from "../../src/api";
import { TakeList } from "../../src/timeline/inspector/takes";
import { draw } from "./render";

/** A clip's takes, each with how much its face is its person's (Face Match), the closest one marked (card #18). */
const take = (id: string, face?: number): Take =>
  ({ id, asset: { id: `a-${id}`, width: 576, height: 1024, durationMs: 5000 }, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 0, endMs: 5000, createdAt: "", finishedFrom: null, joinKind: null, roomMs: 5000, renderMs: null, measure: face != null ? { luma: 100, sharp: 10, face } : null, recipe: null }) as unknown as Take;

function list(takes: Take[]) {
  const clip = { id: "c", kind: "video", takes, take: takes[0] } as unknown as Clip;
  draw(<TakeList clip={clip} take={takes[0]!} joinOf={() => undefined} smoothest={null} onPreview={() => {}} onPatch={() => {}} onRemoveTake={() => {}} />);
}

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
});
