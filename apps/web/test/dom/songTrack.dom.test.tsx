import { useRef } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip } from "../../src/api";
import { due, heardByVideo, pieceKey, piecesOf, pieceUrl, useSong } from "../../src/timeline/useSong";

/**
 * The song under Lip sync clips played as one track in the player (useSong, card #131): each clip's parts on the sound
 * card's clock, end to end across a cut, as the export lays them. Timeline 6's player skipped 56 ms of the song at the cut
 * from clip 7 to 8, its two videos switched on their own timing (2026-10-27).
 */
const clip = (id: string, atMs: number, lengthMs: number, atS: number, extra: Partial<Clip> = {}) =>
  ({ id, kind: "video", sound: "own", volume: 100, atMs, lengthMs, take: { id: `take-${id}`, startMs: 0 }, soundParts: [{ kind: "song", asset: "song", fromMs: 0, toMs: lengthMs, atS, gainDb: -2 }], ...extra }) as unknown as Clip;

describe("the song's pieces", () => {
  it("places each clip's parts on the timeline, a few seconds a piece, at its level", () => {
    const pieces = piecesOf([clip("7", 30644, 4979, 30.644), clip("8", 35623, 4458, 35.623, { volume: 50 })]);
    expect(pieces.map((p) => [p.fromMs, p.toMs, +p.atS.toFixed(3)])).toEqual([[30644, 34644, 30.644], [34644, 35623, 34.644], [35623, 39623, 35.623], [39623, 40081, 39.623]]);
    expect(pieces[0]!.gain).toBeCloseTo(10 ** (-2 / 20), 6);
    expect(pieces[2]!.gain).toBeCloseTo(10 ** (-2 / 20) * 0.5, 6);
    // the end of one and the start of the next are the same moment, on the timeline and in the song
    expect(pieces[1]!.toMs).toBe(pieces[2]!.fromMs);
    expect(pieces[1]!.atS + (pieces[1]!.toMs - pieces[1]!.fromMs) / 1000).toBeCloseTo(pieces[2]!.atS, 6);
    expect(pieceUrl(pieces[2]!)).toBe("/api/assets/song/slice?from=35.623000&ms=4000.000&v=1");
  });

  it("starts what is due from where the timeline stands, once", () => {
    const pieces = piecesOf([clip("7", 30644, 4979, 30.644), clip("8", 35623, 4458, 35.623)]);
    const started = new Set<string>();
    const first = due(pieces, 35500, 6000, started);
    // under way: from 40 ms on, that far into it; the next from its start
    expect(first.map((d) => [d.piece.fromMs, d.atMs, d.intoMs])).toEqual([[34644, 35540, 896], [35623, 35623, 0], [39623, 39623, 0]]);
    for (const d of first) started.add(pieceKey(d.piece));
    expect(due(piecesOf([clip("7", 30644, 4979, 30.644), clip("8", 35623, 4458, 35.623)]), 35600, 6000, started)).toEqual([]);
  });

  it("mutes the video of a clip played as parts, and only those", () => {
    expect(heardByVideo(clip("7", 0, 1000, 0))).toBe(false);
    expect(heardByVideo({ ...clip("7", 0, 1000, 0), soundParts: undefined })).toBe(true);
    expect(heardByVideo({ ...clip("7", 0, 1000, 0), soundParts: undefined, sound: "muted" })).toBe(false);
  });
});

/** A pretend sound card: what was started, when, from where, how long and how loud, and what was stopped. */
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
  decodeAudioData = async () => ({ duration: 4 });
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

describe("the player's song", () => {
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
  afterEach(() => vi.unstubAllGlobals());

  const play = (seq: Clip[], at: number, nowMs: { v: number }) =>
    renderHook(({ playing }) => {
      const els = useRef(new Map<string, HTMLVideoElement>());
      const masterRef = useRef(1);
      const seeks = useRef(0);
      useSong({ seq, at, playing, els, masterRef, where: () => nowMs.v, seeks });
      return seeks;
    }, { initialProps: { playing: true } });

  it("plays clip 7's end and clip 8 end to end on the sound card's clock across the cut", async () => {
    const seq = [clip("7", 30644, 4979, 30.644), clip("8", 35623, 4458, 35.623)];
    play(seq, 0, { v: 35500 });
    await waitFor(() => expect(FakeAudio.made[0]?.started.length).toBe(3));
    const card = FakeAudio.made[0]!;
    const [end7, start8] = [...card.started].sort((a, b) => a.when - b.when);
    // clip 7's last piece from 35.540 s of the timeline, 896 ms into it, to its end; clip 8's first from exactly there
    expect(end7!.when).toBeCloseTo(10.04, 6);
    expect(end7!.offset).toBeCloseTo(0.896, 6);
    expect(end7!.when + end7!.duration).toBeCloseTo(start8!.when, 9);
    expect(start8).toMatchObject({ offset: 0 });
    expect(start8!.gain).toBeCloseTo(10 ** (-2 / 20), 6);
  });

  it("stops on a pause and is put back on the playhead after a seek", async () => {
    const nowMs = { v: 35500 };
    const hook = play([clip("7", 30644, 4979, 30.644), clip("8", 35623, 4458, 35.623)], 0, nowMs);
    await waitFor(() => expect(FakeAudio.made[0]?.started.length).toBe(3));
    const card = FakeAudio.made[0]!;
    // a seek back to 31 s: what was scheduled stops, the song starts again from there
    nowMs.v = 31000;
    hook.result.current.current++;
    await waitFor(() => expect(card.stopped).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(card.started.some((s) => Math.abs(s.offset - 0.396) < 1e-6)).toBe(true));
    hook.rerender({ playing: false });
    expect(card.stopped).toBeGreaterThan(3);
  });

  it("does nothing for clips without parts (their videos are heard as before)", async () => {
    play([{ ...clip("7", 0, 4000, 0), soundParts: undefined }], 0, { v: 1000 });
    await new Promise((r) => setTimeout(r, 80));
    expect(fetched).toEqual([]);
    expect(FakeAudio.made).toEqual([]);
  });
});
