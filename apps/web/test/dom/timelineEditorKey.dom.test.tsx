import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { TimelineEditor } from "../../src/screens/TimelineEditor";
import { draw } from "./render";

/** Each editor drawn: the timeline it was made for, and the one it is asked for at each render. */
const editors: Array<{ made: string; asked: string[] }> = [];

// the editor's state stood in for by one that remembers which timeline it was made for: still loading, the screen draws
// its skeleton
vi.mock("../../src/timeline/useTimelineEditor", () => ({
  useTimelineEditor(id: string) {
    const [mine] = useState(() => {
      const e = { made: id, asked: [] as string[] };
      editors.push(e);
      return e;
    });
    mine.asked.push(id);
    return { timeline: { isError: false }, t: undefined, shown: undefined };
  },
}));

describe("the timeline editor, another timeline opened (W-14)", () => {
  it("is made afresh: what it held for the one left is never run against the one opened", () => {
    const { rerender } = draw(<TimelineEditor params={{ id: "zz-test-a" }} />);
    // the route keeps its component and gives it the new id, as wouter's does
    rerender(<TimelineEditor params={{ id: "zz-test-b" }} />);
    expect(editors.map((e) => e.made)).toEqual(["zz-test-a", "zz-test-b"]);
    expect(editors.every((e) => e.asked.every((id) => id === e.made))).toBe(true);
  });
});
