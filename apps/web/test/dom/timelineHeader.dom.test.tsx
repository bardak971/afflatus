import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { Clip, Timeline } from "../../src/api";
import { TimelineHeader } from "../../src/timeline/EditorBars";
import { draw } from "./render";

const clip = (id: string, take: boolean): Clip => ({ id, kind: "video", take: take ? { id: `t-${id}` } : null, takes: [] }) as unknown as Clip;
const timeline = { id: "t", name: "zz-test timeline", durationMs: 23_000, undo: "Move clip 2", redo: null, exporting: false } as unknown as Timeline;

function header(missing: Clip[]) {
  const clips = [clip("a", true), clip("b", false)];
  draw(
    <TimelineHeader
      t={timeline} clips={clips} total={28_000} saveFailed={null} onRetrySave={() => {}} said={{ error: null, note: null }}
      undo={{ run: () => {}, pending: false }} redo={{ run: () => {}, pending: false }}
      missing={missing} allMs={5000} allOn={() => 5000} allBlocked={() => null} picked={{ size: 0, renderable: false }} rendering={false}
      onRename={() => {}} onRenderMissing={() => {}} onRenderPicked={() => {}} onFinish={() => {}} onExport={() => {}}
    />,
  );
}

describe("the timeline's header (review 4, P1 and P5)", () => {
  it("keeps Render all plain, its count in the accent: the inspector's button is the one coral", () => {
    header([clip("b", false)]);
    const all = screen.getByRole("button", { name: /^Render all/ });
    expect(all.className).not.toMatch(/\bbg-accent\b/);
    expect(all.querySelector(".bg-accent")?.textContent).toBe("1");
  });

  it("says what is left to render in a neutral chip, not the failure colour", () => {
    header([clip("b", false)]);
    const chip = screen.getByText(/^1 to render/);
    expect(chip.className).not.toMatch(/warn/);
  });

  it("names Finish and Export in words, as they open a dialog", () => {
    header([]);
    expect(screen.getByRole("button", { name: /Finish…/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export…/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Render all/ })).toBeNull();
  });
});
