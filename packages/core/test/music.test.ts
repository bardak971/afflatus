import { describe, expect, it } from "vitest";
import { CLIP_FADE_MS, clipMusicOf, curveAt, duckDbAt, mostFromMs, musicGainAt, musicLevel, musicPlan, MUSIC_RAMP_MS, songAt, strongDuckDb, type MusicBase, type MusicClip } from "../src";

const base: MusicBase = { volume: 50, fadeInMs: 0, fadeOutMs: 0, duck: true, duckDb: 10, fromMs: 0, durationMs: 60_000, startClip: null };
/** Three clips of 2, 3 and 4 s, and one with nothing to play yet. */
const clips = (music: Partial<Record<string, MusicClip["music"]>> = {}): MusicClip[] => [
  { id: "a", atMs: 0, lengthMs: 2000, music: music.a ?? null },
  { id: "b", atMs: 2000, lengthMs: 3000, music: music.b ?? null },
  { id: "planned", atMs: 5000, lengthMs: 0, music: null },
  { id: "c", atMs: 5000, lengthMs: 4000, music: music.c ?? null },
];

describe("the music plan", () => {
  it("plays from the start of the song with clip 1 by default, at the music's volume, over the whole video", () => {
    const plan = musicPlan(base, clips());
    expect(plan).toMatchObject({ startMs: 0, endMs: 9000, fromMs: 0 });
    expect(plan.spans.map((s) => [s.clip, s.atMs, s.lengthMs])).toEqual([["a", 0, 2000], ["b", 2000, 3000], ["c", 5000, 4000]]);
    expect(musicLevel(plan, 1000)).toBeCloseTo(0.5);
    expect(musicLevel(plan, 9000)).toBe(0);
  });

  it("plays the part of the song asked, from the clip asked, and stops where the song does", () => {
    const plan = musicPlan({ ...base, fromMs: 20_000, startClip: "b", durationMs: 24_000 }, clips());
    expect(plan).toMatchObject({ startMs: 2000, endMs: 6000 });
    // silent before its clip; the song heard from 0:20 there
    expect(musicLevel(plan, 1500)).toBe(0);
    expect(songAt(plan, 2000)).toBe(20_000);
    expect(songAt(plan, 5000)).toBe(23_000);
    expect(musicLevel(plan, 6500)).toBe(0);
    // a clip no longer there: with clip 1 again
    expect(musicPlan({ ...base, startClip: "gone" }, clips()).startMs).toBe(0);
  });

  it("takes each clip's own level, mute, fades and ducking, ramping at the boundaries", () => {
    const plan = musicPlan(base, clips({ b: { volume: 40, duck: "strong" }, c: { muted: true } }));
    expect(musicLevel(plan, 1000)).toBeCloseTo(0.5);
    expect(musicLevel(plan, 3500)).toBeCloseTo(0.2);
    expect(musicLevel(plan, 7000)).toBe(0);
    // half way through the ramp at the boundary, the mean of the two levels
    expect(musicLevel(plan, 2000)).toBeCloseTo(0.35);
    expect(musicLevel(plan, 2000 - MUSIC_RAMP_MS / 2)).toBeCloseTo(0.5);
    expect(musicLevel(plan, 2000 + MUSIC_RAMP_MS / 2)).toBeCloseTo(0.2);
    expect(duckDbAt(plan, 1000)).toBe(10);
    expect(duckDbAt(plan, 3000)).toBe(strongDuckDb(10));
    const off = musicPlan(base, clips({ a: { duck: "off" } }));
    expect(duckDbAt(off, 1000)).toBe(0);
    // its own fades: from nothing at its start, to nothing at its end
    const faded = musicPlan({ ...base, volume: 100 }, clips({ b: { fadeIn: true, fadeOut: true } }));
    expect(musicLevel(faded, 2000 + MUSIC_RAMP_MS)).toBeCloseTo(MUSIC_RAMP_MS / CLIP_FADE_MS);
    expect(musicLevel(faded, 3500)).toBeCloseTo(1);
    expect(musicLevel(faded, 5000 - CLIP_FADE_MS / 2)).toBeCloseTo(0.5);
  });

  it("fades the whole music in from where it starts and out where it stops", () => {
    const plan = musicPlan({ ...base, volume: 100, fadeInMs: 1000, fadeOutMs: 2000, startClip: "b" }, clips());
    expect(musicLevel(plan, 2500)).toBeCloseTo(0.5);
    expect(musicLevel(plan, 8000)).toBeCloseTo(0.5);
  });

  it("multiplies the level by the ducking curve, eased between its points", () => {
    const plan = musicPlan({ ...base, volume: 100 }, clips());
    const curve = { rate: 20, gains: [1, 0.5, 0.5] };
    expect(curveAt(curve, 25)).toBeCloseTo(0.75);
    expect(musicGainAt(plan, curve, 75)).toBeCloseTo(0.5);
    expect(musicGainAt(plan, null, 75)).toBeCloseTo(1);
  });

  it("starts no later in the song than its end less the video under it", () => {
    expect(mostFromMs(base, clips())).toBe(51_000);
    expect(mostFromMs({ ...base, startClip: "c" }, clips())).toBe(56_000);
    expect(mostFromMs({ ...base, durationMs: 5000 }, clips())).toBe(0);
  });

  it("keeps only what a clip changes", () => {
    expect(clipMusicOf({ volume: 100, muted: false, duck: "rest" })).toBeNull();
    expect(clipMusicOf({ volume: 400, fadeIn: true })).toEqual({ volume: 150, fadeIn: true });
    expect(clipMusicOf(null)).toBeNull();
  });
});
