import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { Clip, RecipeInfo, Timeline } from "../../src/api";
import { useNewClock } from "../../src/timeline/clock";
import { Track } from "../../src/timeline/Track";
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

function track(first: Clip[]) {
  const zooms: number[] = [];
  function Rig({ clips }: { clips: Clip[] }) {
    const clock = useNewClock();
    return (
      <Track
        timeline={timelineOf(clips)} recipes={[video]} pps={40} onZoom={(pps) => zooms.push(pps)} selected={null} musicSelected={false} clock={clock} cursorMs={null} running={null} busy={false}
        onStop={() => {}} onSelect={() => {}} onSelectMusic={() => {}} onSeek={() => {}} onMove={() => {}} onInsert={() => {}} onPin={() => {}}
        onClipSound={() => {}} onMusic={() => {}} onTrim={() => {}} onNewClip={() => {}} onSource={() => {}} onRecording={() => {}}
        onVoice={() => {}} onRecipe={() => {}} onSourceSettings={() => {}} onUpload={() => Promise.resolve(null)} range={null} onRange={() => {}}
      />
    );
  }
  const drawn = draw(<Rig clips={first} />);
  return { zooms, show: (clips: Clip[]) => drawn.rerender(<Rig clips={clips} />) };
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
