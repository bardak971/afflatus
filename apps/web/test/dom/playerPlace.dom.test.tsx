import { createRef } from "react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Clip } from "../../src/api";
import type { Clock } from "../../src/timeline/clock";
import { Player, type PlayerHandle } from "../../src/timeline/Player";
import { draw } from "./render";

/** A clip of 4 s with a take of its own, at `atMs` on the track. */
const clipOf = (name: string, atMs: number) => ({
  id: `zz-test-${name}`, kind: "video", recipe: null, joined: "cut", atMs, lengthMs: 4000, inputs: {}, music: null, sound: "own", volume: 100, fill: false, transition: null,
  take: { id: `zz-test-take-${name}`, asset: { id: `zz-test-video-${name}`, kind: "video", mime: "video/mp4", fps: 24, durationMs: 4000, width: 640, height: 360 }, headMs: 0, tailMs: 0, startMs: 0, endMs: 4000, roomMs: 4000 },
}) as unknown as Clip;

/** The editor's clock, as the player reports to it. */
function clockAt(ms: number): Clock {
  let now = ms;
  return { get: () => now, set: (next) => void (now = next), subscribe: () => () => {} };
}

const props = (clock: Clock, onTime = (ms: number) => clock.set(ms)) => ({ music: null, frame: null, onPlaying: () => {}, onTime, preview: null, playhead: clock.get });

describe("the timeline's player, put at the playhead (review B4)", () => {
  it("comes on the page at the playhead, not on the first clip, and says that moment (Play starts from it)", () => {
    // the stage back from the source lane or a recording band: a new player, the playhead put at 0:05 by hand while the
    // source stage held the clock at its own start, 0:08
    const clock = clockAt(8000);
    const onTime = vi.fn();
    const ref = createRef<PlayerHandle>();
    draw(<Player ref={ref} clips={[clipOf("a", 0), clipOf("b", 4000)]} {...props(clock, onTime)} playhead={() => 5000} playing={false} />);
    expect(ref.current!.where()).toMatchObject({ clip: { id: "zz-test-b" }, localMs: 1000 });
    expect(onTime).toHaveBeenLastCalledWith(5000);
  });

  it("leaves a playhead standing where nothing plays where it is, the next clip that plays waiting at its start", () => {
    const clock = clockAt(2000);
    const onTime = vi.fn();
    const ref = createRef<PlayerHandle>();
    // the clip at 0:00 has nothing to play yet: only B, from 0:04, plays
    draw(<Player ref={ref} clips={[clipOf("b", 4000)]} {...props(clock, onTime)} playing={false} />);
    expect(ref.current!.where()).toMatchObject({ clip: { id: "zz-test-b" }, localMs: 0 });
    expect(onTime).not.toHaveBeenCalled();
  });

  it("stays on the clip under the playhead when an Undo brings a clip back in front, paused", () => {
    const clock = clockAt(0);
    const ref = createRef<PlayerHandle>();
    const { rerender } = draw(<Player ref={ref} clips={[clipOf("b", 0), clipOf("c", 4000)]} {...props(clock)} playing={false} />);
    act(() => ref.current!.seek(5000));
    expect(ref.current!.where()).toMatchObject({ clip: { id: "zz-test-c" }, localMs: 1000 });
    // Ctrl+Z: clip A back in front, B and C moved on by its length; the playhead stands where it was, now in B
    rerender(<Player ref={ref} clips={[clipOf("a", 0), clipOf("b", 4000), clipOf("c", 8000)]} {...props(clock)} playing={false} />);
    expect(ref.current!.where()).toMatchObject({ clip: { id: "zz-test-b" }, localMs: 1000 });
    expect(clock.get()).toBe(5000);
  });

  it("goes on with the clip on screen when a clip before it is removed while it plays, without a seek", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const clock = clockAt(0);
    const ref = createRef<PlayerHandle>();
    const p = props(clock);
    const { rerender } = draw(<Player ref={ref} clips={[clipOf("a", 0), clipOf("b", 4000), clipOf("c", 8000)]} {...p} playing={false} />);
    act(() => ref.current!.seek(5000));
    rerender(<Player ref={ref} clips={[clipOf("a", 0), clipOf("b", 4000), clipOf("c", 8000)]} {...p} playing />);
    // A removed: B is the first clip now, the one on screen still (its index, 1, is C's now)
    rerender(<Player ref={ref} clips={[clipOf("b", 0), clipOf("c", 4000)]} {...p} playing />);
    expect(ref.current!.where()?.clip.id).toBe("zz-test-b");
  });
});
