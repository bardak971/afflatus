import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { useNewClock } from "../../src/timeline/clock";
import { PAD } from "../../src/timeline/model";
import { Track } from "../../src/timeline/Track";
import { STRIP } from "../../src/timeline/track/EndColumn";
import { ROW } from "../../src/timeline/track/rows";
import { draw } from "./render";

// how often the lanes under the clips are drawn: they are drawn with the Track, so they count its draws (perf review
// 2026-10-22, M-6 and L-33)
const drawn = vi.hoisted(() => ({ music: 0 }));
vi.mock("../../src/timeline/track/MusicLane", async (real) => {
  const lane = await real<typeof import("../../src/timeline/track/MusicLane")>();
  return { ...lane, MusicLane: (p: Parameters<typeof lane.MusicLane>[0]) => {
    drawn.music++;
    return lane.MusicLane(p);
  } };
});

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video with audio", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
  traits: { sound: true },
} as unknown as RecipeInfo;
/** A clip of 5 s: 200 px at 40 px a second; `made`, with a length of its own (not a plan), so marked `data-stage`. */
const clip = (id: string, at: number, made = false) =>
  ({ id, kind: "video", recipe: video.id, joined: "cut", join: null, atMs: at, lengthMs: made ? 5000 : 0, inputs: {}, music: null, take: null, takes: [], sound: "own", volume: 100, pictures: [] }) as unknown as Clip;
const timelineOf = (clips: Clip[]) => ({ id: "zz-test-renders", name: "zz-test renders", clips, durationMs: 15_000, music: null, source: null, recordings: [] }) as unknown as Timeline;

function track(clips: Clip[]) {
  function Rig() {
    const clock = useNewClock();
    return (
      <Track
        timeline={timelineOf(clips)} recipes={[video]} pps={40} onZoom={() => {}} selected={null} musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
        onStop={() => {}} onSelect={() => {}} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
        onClipSound={() => {}} onMusic={() => {}} onTrim={() => {}} onNewClip={() => {}} onSource={() => {}} onRecording={() => {}}
        range={null} onRange={() => {}}
      />
    );
  }
  return draw(<Rig />);
}

afterEach(() => vi.restoreAllMocks());

describe("the track drawn again only where something changed (perf review 2026-10-22)", () => {
  it("does not draw the whole track again at each step of a sideways scroll: the pinned end column alone follows it (M-6)", () => {
    // the view 400 px wide, three clips ending at 610 px: the end column is pinned at the view's right edge
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    let left = 0;
    vi.spyOn(HTMLElement.prototype, "scrollLeft", "get").mockImplementation(() => left);
    const { container } = track([clip("a", 0), clip("b", 5000), clip("c", 10_000)]);
    const scroller = container.querySelector<HTMLElement>(".overflow-x-auto")!;
    const strip = () => Number.parseFloat(container.querySelector<HTMLElement>("[data-end-strip]")!.style.left);
    expect(strip()).toBe(400 - STRIP);
    const before = drawn.music;
    for (let step = 1; step <= 20; step++) {
      left = step * 5;
      fireEvent.scroll(scroller);
    }
    // the strip followed the view; the lanes (and the Track that holds them) were not drawn once
    expect(strip()).toBe(400 + 100 - STRIP);
    expect(drawn.music - before).toBe(0);
  });

  it("does not draw the whole track again as the pointer comes near a join and leaves it: only that join's \"+\" shows (L-33)", () => {
    const { container, getByRole } = track([clip("a", 0), clip("b", 5000), clip("c", 10_000)]);
    const inner = container.querySelector<HTMLElement>(".overflow-x-auto > div")!;
    const plus = () => getByRole("button", { name: "Put a new clip between clip 1 and clip 2" }).className.split(" ").includes("opacity-100");
    const before = drawn.music;
    expect(plus()).toBe(false);
    fireEvent.pointerMove(inner, { clientX: PAD + 200, clientY: ROW.top + 10 });
    expect(plus()).toBe(true);
    fireEvent.pointerMove(inner, { clientX: PAD + 100, clientY: ROW.top + 10 });
    expect(plus()).toBe(false);
    fireEvent.pointerMove(inner, { clientX: PAD + 205, clientY: ROW.top + 10 });
    fireEvent.pointerLeave(inner);
    expect(plus()).toBe(false);
    expect(drawn.music - before).toBe(0);
  });

  it("measures the stage once as the frame card comes up, not at each move, and never the track's own clips (L-33)", () => {
    // the stage above the track, and clips that have their length (marked data-stage for the stage's colours)
    const stage = document.createElement("div");
    stage.setAttribute("data-stage", "");
    document.body.append(stage);
    try {
      const { container } = track([clip("a", 0, true), clip("b", 5000, true), clip("c", 10_000, true)]);
      expect(container.querySelectorAll("[data-stage]").length).toBe(3);
      const inner = container.querySelector<HTMLElement>(".overflow-x-auto > div")!;
      const measured = { stage: 0, clips: 0 };
      const read = Element.prototype.getBoundingClientRect;
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (this === stage) measured.stage++;
        else if (this.hasAttribute("data-stage")) measured.clips++;
        return read.call(this);
      });
      for (let x = 0; x < 20; x++) fireEvent.pointerMove(inner, { clientX: PAD + 20 + x * 25, clientY: ROW.top + 10 });
      expect(measured).toEqual({ stage: 1, clips: 0 });
      // the card put away and up again: the stage measured again, where it is now
      fireEvent.pointerLeave(inner);
      fireEvent.pointerMove(inner, { clientX: PAD + 30, clientY: ROW.top + 10 });
      fireEvent.pointerMove(inner, { clientX: PAD + 60, clientY: ROW.top + 10 });
      expect(measured).toEqual({ stage: 2, clips: 0 });
    } finally {
      stage.remove();
    }
  });
});
