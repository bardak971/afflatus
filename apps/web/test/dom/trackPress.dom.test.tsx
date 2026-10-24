import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { useNewClock } from "../../src/timeline/clock";
import { PAD } from "../../src/timeline/model";
import { Track } from "../../src/timeline/Track";
import { ROW } from "../../src/timeline/track/rows";
import { useEditorKeys } from "../../src/timeline/useEditorKeys";
import { draw } from "./render";

// card #77: Esc leaves no ring on the track, and a click on a selected clip's edge at the join's dot opens the join

const model = { id: "zz-test.video", family: "zz-test", title: "zz-test video", output: "video", summary: "", inputs: [{ id: "prompt", type: "prompt", label: "Prompt" }] } as unknown as RecipeInfo;
const video = (id: string) => ({ id, name: `zz-test ${id}`, kind: "video", mime: "video/mp4", fps: 24, durationMs: 6000 });
/** A rendered clip of 5 s (200 px at 40 px a second), with a second of its take left on each side to trim back. */
const clip = (id: string, at: number) =>
  ({
    id, kind: "video", recipe: model.id, joined: "cut", join: null, atMs: at, lengthMs: 5000, inputs: {}, music: null, sound: "own", volume: 100, pictures: [], takes: [],
    take: { id: `${id}-take`, asset: video(`${id}-video`), headMs: 0, tailMs: 0, startMs: 500, endMs: 5500, roomMs: 6000 },
  }) as unknown as Clip;
const clips = [clip("zz-a", 0), clip("zz-b", 5000)];
const timeline = { id: "zz-test-press", name: "zz-test press", clips, durationMs: 10_000, music: null, source: null, recordings: [] } as unknown as Timeline;
/** Where the join between the two clips is drawn on the track, its dot on the middle of the video row. */
const JOIN = { x: PAD + 200, y: ROW.top + ROW.height / 2 };

beforeAll(() => {
  // jsdom has no pointer capture; the edges take it on a press
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

/** The track and the editor's keys, `selected` held as the editor holds it. */
function rig(first: string | null) {
  const onOpenJoin = vi.fn();
  const onTrim = vi.fn();
  function Rig() {
    const clock = useNewClock();
    const [selected, setSelected] = useState<string | null>(first);
    const [, setPicked] = useState<Set<string>>(new Set());
    const range = useRef(null);
    const total = useRef(10_000);
    const loop = useRef(() => {});
    const player = useRef(null);
    useEditorKeys({
      clock, player, toggle: () => {}, undo: () => {}, canUndo: false, redo: () => {}, canRedo: false, remove: () => {}, move: () => {}, removePicked: () => false,
      rangeRef: range, setRange: () => {}, totalRef: total, toggleLoopNow: loop, frameMs: () => 40, selected, setSelected, setPicked,
    });
    return (
      <>
        <span data-testid="selected">{selected ?? ""}</span>
        <Track
          timeline={timeline} recipes={[model]} pps={40} onZoom={() => {}} selected={selected} musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
          onStop={() => {}} onSelect={setSelected} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
          onClipSound={() => {}} onMusic={() => {}} onTrim={onTrim} onNewClip={() => {}} onOpenJoin={(c) => onOpenJoin(c.id)} range={null} onRange={() => {}}
        />
      </>
    );
  }
  draw(<Rig />);
  return { onOpenJoin, onTrim };
}

const inTrack = () => Boolean(document.activeElement?.closest("[data-track]"));

describe("Esc on the track (card #77)", () => {
  it("lets go of the selected clip and leaves no track element focused, so no ring stays on it", () => {
    rig(null);
    const two = screen.getByRole("button", { name: /^Clip 2,/ });
    act(() => two.focus());
    fireEvent.click(two, { clientX: PAD + 300 });
    expect(screen.getByTestId("selected").textContent).toBe("zz-b");
    expect(inTrack()).toBe(true);
    fireEvent.keyDown(two, { key: "Escape" });
    expect(screen.getByTestId("selected").textContent).toBe("");
    expect(inTrack()).toBe(false);
  });

  it("leaves the join's dot as well once it was pressed", () => {
    rig("zz-b");
    const dot = screen.getByRole("button", { name: "The join before clip 2: a cut" });
    act(() => dot.focus());
    fireEvent.keyDown(dot, { key: "Escape" });
    expect(inTrack()).toBe(false);
  });

  it("leaves a focus outside the track where it is", () => {
    rig("zz-b");
    const outside = document.createElement("button");
    document.body.append(outside);
    act(() => outside.focus());
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("a selected clip's edge at a join (card #77, W-10 kept)", () => {
  it("opens the join on a click at the dot's spot on the start edge, trimming nothing", () => {
    const { onOpenJoin, onTrim } = rig("zz-b");
    const edge = screen.getByRole("separator", { name: "Drag to trim the start of the clip" });
    expect(edge.dataset.hint).toBe("click: the join · drag: trim the start");
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: JOIN.x + 4, clientY: JOIN.y });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: JOIN.x + 5, clientY: JOIN.y + 1 });
    expect(onOpenJoin).toHaveBeenCalledWith("zz-b");
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("opens the join after the clip on a click at the dot's spot on the end edge", () => {
    const { onOpenJoin, onTrim } = rig("zz-a");
    const edge = screen.getByRole("separator", { name: "Drag to trim the end of the clip" });
    expect(edge.dataset.hint).toBe("click: the join · drag: trim the end");
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: JOIN.x - 5, clientY: JOIN.y });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: JOIN.x - 5, clientY: JOIN.y });
    expect(onOpenJoin).toHaveBeenCalledWith("zz-b");
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("still trims on a drag from the dot's spot, the join left shut", () => {
    const { onOpenJoin, onTrim } = rig("zz-b");
    const edge = screen.getByRole("separator", { name: "Drag to trim the start of the clip" });
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: JOIN.x + 4, clientY: JOIN.y });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: JOIN.x + 24, clientY: JOIN.y });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: JOIN.x + 44, clientY: JOIN.y });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: JOIN.x + 44, clientY: JOIN.y });
    expect(onTrim).toHaveBeenCalledTimes(1);
    expect(onTrim.mock.calls[0]![1]).toEqual({ shownFromMs: 1500 });
    expect(onOpenJoin).not.toHaveBeenCalled();
  });

  it("is a drag, not a click, when the pointer went away and came back", () => {
    const { onOpenJoin } = rig("zz-b");
    const edge = screen.getByRole("separator", { name: "Drag to trim the start of the clip" });
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: JOIN.x + 4, clientY: JOIN.y });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: JOIN.x + 30, clientY: JOIN.y });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: JOIN.x + 4, clientY: JOIN.y });
    expect(onOpenJoin).not.toHaveBeenCalled();
  });

  it("opens nothing on a click on the edge away from the dot", () => {
    const { onOpenJoin, onTrim } = rig("zz-b");
    const edge = screen.getByRole("separator", { name: "Drag to trim the start of the clip" });
    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: JOIN.x + 4, clientY: ROW.top + 2 });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: JOIN.x + 4, clientY: ROW.top + 2 });
    expect(onOpenJoin).not.toHaveBeenCalled();
    expect(onTrim).not.toHaveBeenCalled();
  });

  it("says drag only on the first clip's start, where there is no join", () => {
    rig("zz-a");
    // the first clip is a video: its start edge is drawn, with no join before it
    expect(screen.getByRole("separator", { name: "Drag to trim the start of the clip" }).dataset.hint).toBe("drag: trim the start");
  });
});
