import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { useNewClock } from "../../src/timeline/clock";
import { Track, type TrackKeys } from "../../src/timeline/Track";
import { keepView, restoredView } from "../../src/timeline/track/KeptZoom";
import { STRIP } from "../../src/timeline/track/EndColumn";
import { PAD, ZOOM } from "../../src/timeline/model";
import { draw } from "./render";

/**
 * The track's zoom through what changes its clips (B16): fitted again when a clip is added, kept when one is split (S,
 * Ctrl+B, at In / Out) or brought back by Undo, so a zoom made to cut on a frame is not lost.
 */

const video = {
  id: "zz-test.video", family: "zz-test", title: "Video", output: "video", summary: "", version: 1,
  inputs: [{ id: "description", type: "prompt", label: "What happens" }],
} as unknown as RecipeInfo;
const take = (id: string, ms: number) => ({ id, asset: { id: `${id}-video`, name: "zz-test take.mp4", kind: "video", durationMs: ms }, startMs: 0, endMs: ms, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0 });
/** A rendered clip of `ms`, at `at`. */
const clip = (id: string, at: number, ms: number) =>
  ({ id, kind: "video", recipe: video.id, joined: "cut", join: null, atMs: at, lengthMs: ms, inputs: {}, music: null, take: take(`${id}-take`, ms), takes: [take(`${id}-take`, ms)], sound: "own", volume: 100, pictures: [] }) as unknown as Clip;
const timelineOf = (clips: Clip[]) => ({ id: "zz-test-zoom", name: "zz-test zoom", clips, durationMs: 0, music: null, source: null, recordings: [] }) as unknown as Timeline;

function track(first: Clip[], keys?: RefObject<TrackKeys | null>) {
  const zooms: number[] = [];
  function Rig({ clips }: { clips: Clip[] }) {
    const clock = useNewClock();
    return (
      <Track
        timeline={timelineOf(clips)} recipes={[video]} pps={40} onZoom={(pps) => zooms.push(pps)} selected={null} musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
        onStop={() => {}} onSelect={() => {}} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
        onClipSound={() => {}} onMusic={() => {}} onTrim={() => {}} onNewClip={() => {}} onSource={() => {}} onRecording={() => {}}
        onVoice={() => {}} onRecipe={() => {}} onSourceSettings={() => {}} onUpload={() => Promise.resolve(null)} range={null} onRange={() => {}} keys={keys}
      />
    );
  }
  const drawn = draw(<Rig clips={first} />);
  return { zooms, container: drawn.container, unmount: drawn.unmount, show: (clips: Clip[]) => drawn.rerender(<Rig clips={clips} />) };
}

/** A few frames gone by: a fit asked is made on the next animation frame. */
const frames = () => act(() => new Promise<void>((r) => setTimeout(r, 80)));

describe("the track's zoom, its clips changed (B16)", () => {
  it("is kept through a split and an Undo bringing a clip back; fitted again when a clip is added", async () => {
    const wide = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    try {
      const a = clip("zz-test-a", 0, 10_000);
      const b = clip("zz-test-b", 10_000, 5000);
      const { zooms, show } = track([a, b]);
      // fitted on arriving
      await waitFor(() => expect(zooms).toHaveLength(1));
      // S at 5 s: the clip in two, the same length
      const a1 = clip("zz-test-a", 0, 5000);
      const a2 = clip("zz-test-a2", 5000, 5000);
      show([a1, a2, b]);
      await frames();
      // the last clip removed, then brought back by Undo: shorter, then longer again, with a clip already seen
      show([a1, a2]);
      await frames();
      show([a1, a2, b]);
      await frames();
      expect(zooms).toHaveLength(1);
      // New clip: one never seen, the timeline longer
      show([a1, a2, b, clip("zz-test-c", 15_000, 5000)]);
      await waitFor(() => expect(zooms).toHaveLength(2));
    } finally {
      wide.mockRestore();
    }
  });
});

/**
 * The track's zoom and scroll kept per timeline in this browser (card #140): left zoomed in on a long timeline's middle and
 * come back to, it was fitted whole again.
 */
describe("the track's view, left and come back to (card #140)", () => {
  /** The track's scroller as a browser has it: 1000 px wide, its scroll said back, a scroll event as it moves. */
  function browser() {
    const sets: number[] = [];
    let left = 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "scrollLeft", "get").mockImplementation(() => left);
    vi.spyOn(HTMLElement.prototype, "scrollLeft", "set").mockImplementation(function (this: HTMLElement, v: number) {
      left = v;
      sets.push(v);
      this.dispatchEvent(new Event("scroll"));
    });
    return { sets, scroll: (el: HTMLElement, v: number) => { left = v; el.dispatchEvent(new Event("scroll")); } };
  }
  afterEach(() => vi.restoreAllMocks());
  const kept = () => JSON.parse(localStorage.getItem("afflatus.track.zoom") ?? "{}") as Record<string, { pps: number; fromMs: number; whole: boolean }>;
  const a = clip("zz-test-a", 0, 10_000);
  const b = clip("zz-test-b", 10_000, 5000);

  it("brings back the zoom and the scroll the timeline was left with, rather than fitting it", async () => {
    const { sets } = browser();
    keepView("zz-test-zoom", { pps: 80, fromMs: 2000, whole: false });
    const { zooms } = track([a, b]);
    await waitFor(() => expect(zooms).toEqual([80]));
    // a frame later, scrolled to 2 s at the view's left edge
    await waitFor(() => expect(sets.at(-1)).toBe(PAD + 2 * 80));
  });

  it("keeps a sane view of a timeline made shorter since: its end at the view's right, never past it; a bad zoom within bounds", () => {
    // 15 s left at 80 px a second in a 1000 px view: the left edge no later than 15 s less the view's 12.25 s
    expect(restoredView({ pps: 80, fromMs: 60_000, whole: false }, 15_000, 1000)).toEqual({ pps: 80, fromMs: 15_000 - (980 / 80) * 1000 });
    // the whole of it fits at that zoom: from the track's start
    expect(restoredView({ pps: 80, fromMs: 9000, whole: false }, 5000, 1000)).toEqual({ pps: 80, fromMs: (-PAD / 80) * 1000 });
    expect(restoredView({ pps: 5000, fromMs: 0, whole: false }, 15_000, 1000).pps).toBe(ZOOM.most);
    expect(restoredView({ pps: 0.01, fromMs: 0, whole: false }, 15_000, 1000).pps).toBe(ZOOM.least);
  });

  it("fits again a timeline left fitted (Fit all its last word), whatever its length now", async () => {
    browser();
    keepView("zz-test-zoom", { pps: 80, fromMs: 3000, whole: true });
    const { zooms } = track([a, b]);
    await waitFor(() => expect(zooms).toHaveLength(1));
    expect(zooms[0]).toBeCloseTo((1000 - STRIP - PAD * 3) / 15);
  });

  it("is written once the scroll stands still, not on each of its frames, and as the track goes", async () => {
    const { scroll } = browser();
    const write = vi.spyOn(localStorage, "setItem");
    const { zooms, container, unmount } = track([a, b]);
    await waitFor(() => expect(zooms).toHaveLength(1));
    const scroller = container.querySelector<HTMLElement>(".overflow-x-auto")!;
    const writes = () => write.mock.calls.filter(([k]) => k === "afflatus.track.zoom").length;
    const before = writes();
    // twenty frames of a scroll: nothing written meanwhile (the Rig's zoom stays at 40 px a second; fitted on arriving,
    // the whole timeline is what it was left with)
    for (let x = 1; x <= 20; x++) scroll(scroller, x * 20);
    expect(writes()).toBe(before);
    await waitFor(() => expect(kept()["zz-test-zoom"]).toEqual({ pps: 40, fromMs: ((400 - PAD) / 40) * 1000, whole: true, at: expect.any(Number) }), { timeout: 2000 });
    expect(writes()).toBe(before + 1);
    // scrolled again and left at once: kept all the same
    scroll(scroller, 800);
    unmount();
    expect(kept()["zz-test-zoom"]!.fromMs).toBe(((800 - PAD) / 40) * 1000);
  });

  it("brings a moment to the middle of the view at the zoom it has (a recording opened there)", async () => {
    const { sets } = browser();
    const keys = createRef<TrackKeys>();
    const { zooms } = track([a, b], keys);
    await waitFor(() => expect(zooms).toHaveLength(1));
    act(() => keys.current!.centre(16_000));
    expect(sets.at(-1)).toBe(PAD + 16 * 40 - 500);
  });
});
