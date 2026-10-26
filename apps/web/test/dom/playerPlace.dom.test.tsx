import { createRef, useState } from "react";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Clip } from "../../src/api";
import { useNewClock, type Clock } from "../../src/timeline/clock";
import { Player, type PlayerHandle } from "../../src/timeline/Player";
import { usePlayhead } from "../../src/timeline/usePlayhead";
import { useRange } from "../../src/timeline/useRange";
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

const props = (clock: Clock, onTime = (ms: number) => clock.set(ms)) => ({ music: null, frame: null, onPlaying: () => {}, onTime, preview: null, playhead: () => ({ ms: clock.get(), held: false }) });

describe("the timeline's player, put at the playhead (review B4)", () => {
  it("comes on the page at the playhead, not on the first clip, and says that moment (Play starts from it)", () => {
    // the stage back from the source lane or a recording band: a new player, the playhead put at 0:05 by hand while the
    // source stage held the clock at its own start, 0:08
    const clock = clockAt(8000);
    const onTime = vi.fn();
    const ref = createRef<PlayerHandle>();
    draw(<Player ref={ref} clips={[clipOf("a", 0), clipOf("b", 4000)]} {...props(clock, onTime)} playhead={() => ({ ms: 5000, held: false })} playing={false} />);
    expect(ref.current!.where()).toMatchObject({ clip: { id: "zz-test-b" }, localMs: 1000 });
    expect(onTime).toHaveBeenLastCalledWith(5000);
  });

  it("leaves a playhead put on a clip with nothing to play where it is, the clip after waiting at its start", () => {
    const clock = clockAt(8000);
    const onTime = vi.fn();
    const ref = createRef<PlayerHandle>();
    // put by hand on a clip not rendered yet between A and B: what plays there is B's start
    draw(<Player ref={ref} clips={[clipOf("a", 0), clipOf("b", 4000)]} {...props(clock, onTime)} playhead={() => ({ ms: 4000, held: true })} playing={false} />);
    expect(ref.current!.where()).toMatchObject({ clip: { id: "zz-test-b" }, localMs: 0 });
    expect(onTime).not.toHaveBeenCalled();
  });

  it("leaves a playhead where nothing plays where it is (a clip with no take but a length), the clip after waiting", () => {
    const clock = clockAt(1000);
    const onTime = vi.fn();
    const ref = createRef<PlayerHandle>();
    // only B, from 0:04, plays: the playhead at 0:01 stands on a clip with a length and nothing to play
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

describe("Play, from the playhead put by hand", () => {
  /** The editor's transport, as useTimelineEditor wires it: the playhead handed to the range's Play through a ref. */
  function rig() {
    const seen: { r?: ReturnType<typeof useRange>; p?: ReturnType<typeof usePlayhead>; clock?: Clock; playing?: boolean } = {};
    const seek = vi.fn();
    const clips = [clipOf("a", 0), clipOf("b", 4000)];
    function Transport() {
      const clock = useNewClock();
      const [playing, setPlaying] = useState(false);
      const player = { current: { seek, fullscreen: () => {}, where: () => null } };
      const playhead = { current: () => ({ ms: clock.get() }) };
      const r = useRange({ id: "zz-test-timeline", clips, durationMs: 8000, clock, playhead, player, playing, setPlaying, on: { after: () => {}, select: () => {}, note: () => {}, say: () => {}, writeBetween: () => {}, askRemoval: async () => true } });
      const p = usePlayhead({ clock, clips, endMs: 8000, player, rangeRef: r.rangeRef, loopRef: r.loopRef, playingRange: r.playingRange, setPlaying });
      // (every clip plays: the track's time is what plays, as useTimelineEditor's playheadNow then gives it)
      playhead.current = () => ({ ms: p.cursor ?? clock.get() });
      Object.assign(seen, { r, p, clock, playing });
      return null;
    }
    draw(<Transport />);
    return { seen, seek };
  }

  it("starts at the cursor, not from the top, when the clock said the end (put there while the stage showed the source)", () => {
    const { seen, seek } = rig();
    // the source's stage held the clock at its own start, past the clips; a click on the track put the playhead at 0:05
    act(() => seen.clock!.set(8000));
    act(() => seen.p!.setCursor(5000));
    act(() => seen.r!.toggle());
    expect(seek).toHaveBeenLastCalledWith(5000);
    expect(seen.playing).toBe(true);
  });

  it("does not seek when the playhead is where what plays is", () => {
    const { seen, seek } = rig();
    act(() => seen.clock!.set(5000));
    act(() => seen.r!.toggle());
    expect(seek).not.toHaveBeenCalled();
    expect(seen.playing).toBe(true);
  });

  it("plays a range from the cursor when it stands inside it", () => {
    const { seen, seek } = rig();
    act(() => seen.r!.setRange({ inMs: 1000, outMs: 7000 }));
    act(() => seen.clock!.set(500));
    act(() => seen.p!.setCursor(5000));
    act(() => seen.r!.toggle());
    expect(seek).toHaveBeenLastCalledWith(5000);
  });
});
