import { useRef, useState, type MutableRefObject } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset, Clip, Take } from "../../src/api";
import { useHandover } from "../../src/timeline/useHandover";

/** A clip with only what the hand-over reads. */
const clip = (over: Partial<Clip> & { id: string }): Clip =>
  ({ kind: "video", recipe: "h3.video", inputs: {}, atMs: 0, lengthMs: 3000, takes: [], pictures: [], joined: "cut", join: null, sound: "own", volume: 100, fill: false, soundAsset: null, still: null, take: null, transition: null, ...over }) as unknown as Clip;
const take = (id: string, over: Partial<Take> = {}): Take => ({ id, headMs: 0, tailMs: 0, trimStartMs: 0, trimEndMs: 0, startMs: 500, endMs: 3500, asset: { id: `zz-test-${id}`, durationMs: 4000 } as Asset, ...over }) as Take;

/** A video as the hand-over sees it: where it is, paused or not, and every seek it is given (in ms). */
function video(atMs: number) {
  let time = atMs / 1000;
  const v = {
    seeks: [] as number[],
    paused: true,
    ended: false,
    readyState: 4,
    muted: false,
    volume: 1,
    playbackRate: 1,
    style: { opacity: "" },
    get currentTime() {
      return time;
    },
    set currentTime(s: number) {
      time = s;
      v.seeks.push(Math.round(s * 1000));
    },
    /** Where it got to by playing, not a seek. */
    runTo(ms: number) {
      time = ms / 1000;
    },
    play: vi.fn(() => {
      v.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      v.paused = true;
    }),
    animate: vi.fn(),
  };
  return v;
}
type Video = ReturnType<typeof video>;

/** The page's clock, as the frame loop reads it. */
let now = 0;
afterEach(() => vi.restoreAllMocks());

/** The hand-over over `seq`, as the Player drives it: `place` moves on to a clip and starts its join afresh. */
function play(seq: Clip[], videos: Record<string, Video>, slowSeeks: boolean) {
  vi.spyOn(performance, "now").mockImplementation(() => now);
  // the frame loop is driven by hand here, step by step
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  let step: MutableRefObject<() => boolean> | undefined;
  let setAt: (i: number) => void = () => {};
  const flags = { fadeOn: { current: false }, handReady: { current: false }, armed: { current: false } };
  function Harness() {
    const [at, set] = useState(0);
    setAt = set;
    const els = useRef(new Map(Object.entries(videos) as unknown as [string, HTMLVideoElement][]));
    step = useHandover({
      seq, at, playing: true, els, pos: useRef({ key: "", local: 0, at: 0 }), said: useRef(0), masterRef: useRef(1), ...flags,
      fadedIn: useRef(false), thaw: useRef(0), crossOn: useRef(false), cross: () => {}, setFrozen: () => {}, setFading: () => {},
      place: (i) => {
        flags.fadeOn.current = false;
        flags.handReady.current = false;
        flags.armed.current = false;
        setAt(i);
      },
      onPlaying: () => {}, onTime: () => {}, tuneMusic: () => {}, keyOf: (c) => c.id, startOf: (c) => c.take?.startMs ?? 0, slowSeeks,
    });
    return null;
  }
  render(<Harness />);
  /** One frame of the loop at `t` ms. */
  return (t: number) => act(() => {
    now = t;
    step!.current();
  });
}

describe("the clip after, put where its pre-roll starts (S1)", () => {
  const seq = [clip({ id: "a", take: take("A") }), clip({ id: "b", take: take("B"), atMs: 3000 }), clip({ id: "c", take: take("C"), atMs: 6000 })];

  it("is sought only at its pre-roll, to the very moment, where seeks are quick (Chrome, as in 0.10.0)", () => {
    const v = { A: video(2500), B: video(500), C: video(500) };
    const frame = play(seq, v, false);
    // 1 s before the join: nothing sought ahead
    frame(1000);
    expect(v.B.seeks).toEqual([]);
    // 290 ms before it (the frame after the pre-roll's 300): to where it must start, 70 ms ahead for its start
    v.A.runTo(500 + 2710);
    frame(1710);
    expect(v.B.seeks).toEqual([500 - 290 + 70]);
    expect(v.B.paused).toBe(false);
  });

  it("is sought ahead on WebKit, not again a refresh short at its pre-roll, and that refresh is never learned as its delay", () => {
    const v = { A: video(2500), B: video(500), C: video(500) };
    const frame = play(seq, v, true);
    frame(1000);
    expect(v.B.seeks).toEqual([500 - 300 + 70]);
    // its pre-roll 10 ms late (a frame's time): left where it was, 10 ms behind, and started
    v.A.runTo(500 + 2710);
    frame(1710);
    expect(v.B.seeks).toEqual([270]);
    expect(v.B.paused).toBe(false);
    // settled 250 ms later it lost the 70 ms it was started ahead for, no more: 10 ms behind, as it was put
    v.A.runTo(500 + 2960);
    v.B.runTo(270 + 250 - 70);
    frame(1960);
    // the take-over, in step
    v.A.runTo(500 + 2990);
    v.B.runTo(490);
    frame(1990);
    // the next join sought ahead with the delay learned: 70 ms + 4, not the 10 ms behind it was put on top (7 more)
    v.B.runTo(500 + 2000);
    frame(3000);
    expect(v.C.seeks).toEqual([500 - 300 + 74]);
  });
});

describe("the clip after of the take still held under a dissolve (S2)", () => {
  // A, then B dissolved in over A held on its last frame, then C of A's take: one video for A and C, as the Player keeps them
  const x = take("X", { startMs: 0 });
  const seq = [clip({ id: "a", take: x }), clip({ id: "b", joined: "continue", lengthMs: 1000, atMs: 3000, take: take("Y", { headMs: 917, startMs: 917, endMs: 1917 }) }), clip({ id: "c", atMs: 4000, take: x })];

  it("is left on A's last frame while the dissolve shows it, and put where C's pre-roll starts once it is over", () => {
    const v = { X: video(3000), Y: video(917) };
    v.X.paused = false;
    v.X.ended = true;
    const frame = play(seq, v, true);
    // A ends: B dissolves in over it, A's video held on its last frame
    frame(1000);
    expect(v.X.pause).toHaveBeenCalled();
    expect(v.Y.animate).toHaveBeenCalled();
    v.X.ended = false;
    // 100 ms into B, its dissolve (170 ms) still on: 900 ms from C, A's frame is not sought to C's
    v.Y.paused = false;
    v.Y.runTo(917 + 100);
    frame(1100);
    expect(v.X.seeks).toEqual([]);
    expect(v.X.currentTime).toBe(3);
    // past the dissolve (and its 60 ms of margin): sought ahead for C's pre-roll, which starts at its first frame
    v.Y.runTo(917 + 400);
    frame(1400);
    expect(v.X.seeks).toEqual([0]);
  });
});
