import { describe, expect, it } from "vitest";
import { curveAt } from "@afflatus/core";
import { DUCK_RATE, eased, gainWav } from "../src/duck";

describe("the music ducked under speech", () => {
  it("goes down quickly while people speak, holds a moment after, and comes back slowly", () => {
    const talk = [...Array(10).fill(false), ...Array(20).fill(true), ...Array(40).fill(false)];
    const g = eased(talk, 12);
    const low = 10 ** (-12 / 20);
    expect(g[9]).toBe(1);
    // down within a few samples (80 ms attack at 20 a second)
    expect(g[14]!).toBeLessThan(low + 0.05);
    // held for 300 ms after the last word, then back up over about half a second
    expect(g[30 + 5]!).toBeLessThan(low + 0.05);
    expect(g[30 + 6 + 20]!).toBeGreaterThan(0.9);
    expect(Math.min(...g)).toBeGreaterThanOrEqual(low - 0.001);
  });

  it("is written as a float WAV the export multiplies the music by", () => {
    const wav = gainWav((ms) => curveAt({ rate: DUCK_RATE, gains: [1, 0.5, 0.25] }, ms), 150, 8000);
    const b = Buffer.from(wav);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.readUInt16LE(20)).toBe(3);
    expect(b.readUInt32LE(24)).toBe(8000);
    expect(b.readUInt32LE(40)).toBe(Math.ceil(0.15 * 8000) * 4);
    // between two points it is eased: half way from 1 to 0.5 at 25 ms, at the second point at 50 ms
    expect(b.readFloatLE(44 + 200 * 4)).toBeCloseTo(0.75, 2);
    expect(b.readFloatLE(44 + 400 * 4)).toBeCloseTo(0.5, 2);
  });
});
