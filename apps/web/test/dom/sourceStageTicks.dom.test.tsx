import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import type { Asset } from "../../src/api";
import { useClockAs, useNewClock, type Clock } from "../../src/timeline/clock";
import { SourceStage } from "../../src/timeline/SourceStage";
import { draw } from "./render";

/**
 * The source played on the stage (P5): the moment said to the editor about 15 times a second, not at every frame, and
 * where it stopped said once paused; the source's picture maker redrawn when its half second changes, not at every tick.
 */

const video = { id: "zz-test-source", name: "zz-test source.mp4", kind: "video", durationMs: 20_000 } as unknown as Asset;

/** The animation frames, run by hand: each at the time given. */
function frames() {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => (queue.push(fn), queue.length));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return (now: number) => {
    const run = queue;
    queue = [];
    act(() => run.forEach((fn) => fn(now)));
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the source stage playing (P5)", () => {
  it("says where it stands about 15 times a second, and where it stopped once paused", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const frame = frames();
    const said: number[] = [];
    const stage = (playing: boolean) => (
      <SourceStage video={video} atMs={1000} fromMs={0} toMs={20_000} frame={null} playing={playing} onPlaying={() => {}} onTime={(ms) => said.push(ms)} startAt={1000} />
    );
    const { rerender, container } = draw(stage(true));
    const v = container.querySelector("video")!;
    said.length = 0;
    // one second at 60 frames a second
    for (let i = 1; i <= 60; i++) {
      v.currentTime = i / 60;
      frame(i * (1000 / 60));
    }
    expect(said.length).toBeGreaterThanOrEqual(13);
    expect(said.length).toBeLessThanOrEqual(16);
    // paused between two moments said: the last frame's
    v.currentTime = 61 / 60;
    rerender(stage(false));
    expect(said.at(-1)).toBeCloseTo(1000 + (61 / 60) * 1000);
  });
});

describe("a part reading the clock to the half second (useClockAs)", () => {
  it("is drawn again only when its half second changes", () => {
    let clock!: Clock;
    let drawn = 0;
    function Half() {
      clock = useNewClock();
      const at = useClockAs(clock, (ms) => Math.round(ms / 500) * 500);
      drawn++;
      return <span>{at}</span>;
    }
    const { container } = draw(<Half />);
    const before = drawn;
    // each tick of its own, as the stage's frames come
    for (let ms = 0; ms <= 1000; ms += 16) act(() => clock.set(ms));
    expect(container.textContent).toBe("1000");
    // 0 → 500 → 1000: two redraws for 63 ticks
    expect(drawn - before).toBe(2);
  });
});
