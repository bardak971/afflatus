import { useRef } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "../../src/api";
import { fillGain, fillStartsIn, fillUrl, useSoundFill } from "../../src/timeline/useSoundFill";

/**
 * The end of a take whose sound stops short of its frames before a cut, filled in the player from its recording on the
 * sound card's clock (useSoundFill), as the export lays it: Timeline 6's clip 7, its sound 30 ms short (2026-10-27).
 */
const FILL = { asset: "zz-test-song", fromMs: 5845, ms: 30, songS: 35.593, gainDb: -1.5 };

describe("a fill's moment and level", () => {
  it("is due within a quarter second before it starts, never once past it", () => {
    expect(fillStartsIn(FILL, 5845 - 145)).toBeCloseTo(0.145, 6);
    expect(fillStartsIn(FILL, 5845 - 400)).toBeNull();
    expect(fillStartsIn(FILL, 5846)).toBeNull();
    expect(fillGain(FILL, 80, 1)).toBeCloseTo(10 ** (-1.5 / 20) * 0.8, 6);
    expect(fillGain(FILL, 100, 0)).toBe(0);
    // its moment of the recording cut by the server, to the microsecond, kept by the browser
    expect(fillUrl(FILL)).toBe("/api/assets/zz-test-song/slice?from=35.593000&ms=30.000&v=1");
  });
});

/** A pretend sound card: what was started, at what time and level, and stopped. */
class FakeAudio {
  static made: FakeAudio[] = [];
  currentTime = 10;
  state = "running";
  destination = {};
  started: Array<{ when: number; offset: number; duration: number; gain: number }> = [];
  stopped = 0;
  constructor() {
    FakeAudio.made.push(this);
  }
  resume = async () => {};
  close = async () => {};
  decodeAudioData = async () => ({ duration: 0.03 });
  createGain() {
    return { gain: { value: 1 }, connect: (x: unknown) => x };
  }
  createBufferSource() {
    const card = this;
    let gain: { gain: { value: number } } | null = null;
    return {
      buffer: null as unknown,
      onended: null as null | (() => void),
      connect(g: { gain: { value: number } }) {
        gain = g;
        return { connect: () => {} };
      },
      start(when: number, offset: number, duration: number) {
        card.started.push({ when, offset, duration, gain: gain?.gain.value ?? 1 });
      },
      stop() {
        card.stopped++;
      },
    };
  }
}

const clipOf = (fill?: typeof FILL) => ({ id: "zz-test-c7", kind: "video", sound: "own", volume: 80, atMs: 0, lengthMs: 4958, take: { id: "zz-test-take-7" }, ...(fill ? { soundFill: fill } : {}) }) as unknown as Clip;

describe("the player's fill", () => {
  const fetched: string[] = [];
  beforeEach(() => {
    FakeAudio.made = [];
    fetched.length = 0;
    vi.stubGlobal("AudioContext", FakeAudio);
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const play = (clip: Clip, videoMs: number) => {
    const video = { currentTime: videoMs / 1000, paused: false } as HTMLVideoElement;
    const hook = renderHook(({ playing }) => {
      const els = useRef(new Map([["zz-test-take-7", video]]));
      const masterRef = useRef(1);
      useSoundFill({ seq: [clip], at: 0, playing, els, masterRef });
    }, { initialProps: { playing: true } });
    return { video, hook };
  };

  it("plays the recording's moment on the sound card when the video reaches the end of its sound, at the take's level", async () => {
    const { video } = play(clipOf(FILL), 5000);
    await waitFor(() => expect(fetched).toEqual([fillUrl(FILL)]));
    // too early: nothing yet
    await new Promise((r) => setTimeout(r, 60));
    const card = FakeAudio.made[0]!;
    expect(card.started).toEqual([]);
    // 145 ms before it: scheduled that far ahead on the card's clock, from the slice's start, 30 ms long
    video.currentTime = 5.7;
    await waitFor(() => expect(card.started).toHaveLength(1));
    expect(card.started[0]!.when).toBeCloseTo(10 + 0.145, 3);
    expect(card.started[0]).toMatchObject({ offset: 0, duration: 0.03 });
    expect(card.started[0]!.gain).toBeCloseTo(10 ** (-1.5 / 20) * 0.8, 6);
    // once only
    await new Promise((r) => setTimeout(r, 60));
    expect(card.started).toHaveLength(1);
  });

  it("stops it on a pause, and on a step back before it", async () => {
    const { video, hook } = play(clipOf(FILL), 5700);
    await waitFor(() => expect(FakeAudio.made[0]?.started).toHaveLength(1));
    const card = FakeAudio.made[0]!;
    hook.rerender({ playing: false });
    expect(card.stopped).toBe(1);
    hook.rerender({ playing: true });
    video.currentTime = 5.7;
    await waitFor(() => expect(card.started).toHaveLength(2));
    video.currentTime = 2;
    await waitFor(() => expect(card.stopped).toBe(2));
  });

  it("does nothing for a clip with no fill (a join that carries on)", async () => {
    play(clipOf(), 5700);
    await new Promise((r) => setTimeout(r, 80));
    expect(fetched).toEqual([]);
    expect(FakeAudio.made).toEqual([]);
  });
});
