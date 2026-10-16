import { describe, expect, it } from "vitest";
import { musicPlan, type MusicBase } from "@afflatus/core";
import { musicChain, musicGainWav } from "../src/exportJoin";
import { eased } from "../src/duck";

const base: MusicBase = { volume: 80, fadeInMs: 0, fadeOutMs: 0, duck: false, duckDb: 10, fromMs: 0, durationMs: 60_000, startClip: null };
const clips = [
  { id: "a", atMs: 0, lengthMs: 2000, music: null },
  { id: "b", atMs: 2000, lengthMs: 2000, music: { muted: true } },
  { id: "c", atMs: 4000, lengthMs: 2000, music: { volume: 50 } },
];
/** The gain WAV's sample at a moment (4000 a second, after its 44-byte head). */
const sampleAt = (wav: Uint8Array, ms: number) => Buffer.from(wav).readFloatLE(44 + Math.round((ms / 1000) * 4000) * 4);

describe("the export's music mix", () => {
  it("takes the part of the song asked, delayed to the clip it starts with, multiplied by the plan's gain", () => {
    const plan = musicPlan({ ...base, fromMs: 20_000, startClip: "b" }, clips);
    const chain = musicChain(plan, { index: 3 }, { index: 4 });
    expect(chain[0]).toBe("[3:a]aresample=48000,aformat=channel_layouts=stereo,atrim=start=20.000:duration=4.000,asetpts=PTS-STARTPTS,adelay=delays=2000:all=1[music]");
    expect(chain.slice(1)).toEqual(["[4:a]aresample=48000,aformat=channel_layouts=stereo[gain]", "[music][gain]amultiply[under]", "[voices][under]amix=inputs=2:duration=first:normalize=0[a]"]);
    // from its start with clip 1: no delay, no start in the song
    expect(musicChain(musicPlan(base, clips), { index: 1 }, { index: 2 })[0]).toBe("[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=6.000,asetpts=PTS-STARTPTS[music]");
  });

  it("is silent under a muted clip and at the clip's own level elsewhere, as the player sets it", () => {
    const wav = musicGainWav({ plan: musicPlan(base, clips), duck: null }, 6000);
    expect(Buffer.from(wav).readUInt32LE(24)).toBe(4000);
    expect(sampleAt(wav, 1000)).toBeCloseTo(0.8);
    expect(sampleAt(wav, 3000)).toBe(0);
    expect(sampleAt(wav, 5000)).toBeCloseTo(0.4);
    // the ducking on top
    const duck = { rate: 20, gains: eased(new Array(120).fill(true), 6) };
    expect(sampleAt(musicGainWav({ plan: musicPlan(base, clips), duck }, 6000), 1000)).toBeCloseTo(0.8 * 10 ** (-6 / 20), 2);
  });
});
