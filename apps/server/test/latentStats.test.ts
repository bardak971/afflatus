import { describe, expect, it } from "vitest";
import { latentDriftOf, videoTokensOf } from "../src/latentStats";

/** A saved H3 latent as the node pack writes it, with a video stream of the given shape and values. */
function latentFile(shape: number[], fill: (c: number, t: number, i: number) => number, frames: number): Uint8Array {
  const [, channels, tokens, h, w] = shape as [number, number, number, number, number];
  const plane = h * w;
  const data = new Float32Array(channels * tokens * plane);
  for (let c = 0; c < channels; c++) for (let t = 0; t < tokens; t++) for (let i = 0; i < plane; i++) data[(c * tokens + t) * plane + i] = fill(c, t, i);
  const audio = new Float32Array(4);
  const header = JSON.stringify({
    __metadata__: { format: "afflatus-h3-av-latent/1", frames: String(frames) },
    video: { dtype: "F32", shape, data_offsets: [0, data.byteLength] },
    audio: { dtype: "F32", shape: [1, 1, 1, 4], data_offsets: [data.byteLength, data.byteLength + audio.byteLength] },
  });
  // an odd header length, so the values do not sit on a 4-byte boundary in the file (as in real files)
  const padded = header + " ".repeat((7 - (header.length % 8) + 8) % 8 + 1);
  const head = new TextEncoder().encode(padded);
  const out = new Uint8Array(8 + head.length + data.byteLength + audio.byteLength);
  new DataView(out.buffer).setBigUint64(0, BigInt(head.length), true);
  out.set(head, 8);
  out.set(new Uint8Array(data.buffer), 8 + head.length);
  out.set(new Uint8Array(audio.buffer), 8 + head.length + data.byteLength);
  return out;
}

describe("latent drift", () => {
  it("knows the video token count of the 17k + 5 frame grid", () => {
    expect(videoTokensOf(5)).toBe(2);
    expect(videoTokensOf(22)).toBe(7);
    expect(videoTokensOf(39)).toBe(12);
    expect(videoTokensOf(24)).toBe(0);
  });

  it("reads how much wider a window's run-up is than the tail it was guided by, channel by channel", () => {
    // the clip before: 7 tokens whose values alternate ±1 (spread 1) in every channel
    const before = latentFile([1, 2, 7, 2, 2], (_c, _t, i) => (i % 2 ? 1 : -1), 22);
    // the window: its first 7 tokens are the same pattern 5 % wider in channel 0 and 1 % in channel 1, the rest anything
    const window = latentFile([1, 2, 12, 2, 2], (c, t, i) => (t < 7 ? (i % 2 ? 1 : -1) * (c === 0 ? 1.05 : 1.01) : i * 3), 39);
    const drift = latentDriftOf(window, before, 22);
    expect(drift).not.toBeNull();
    expect(drift!.width).toBeCloseTo(1.03, 3);
    // the same window against itself as the guide: no drift
    const same = latentFile([1, 2, 12, 2, 2], (_c, _t, i) => (i % 2 ? 1 : -1), 39);
    expect(latentDriftOf(same, same, 22)!.width).toBe(1);
  });

  it("gives null for another size, an overlap off the grid, or a file that is not a latent", () => {
    const before = latentFile([1, 2, 7, 2, 2], () => 1, 22);
    const window = latentFile([1, 2, 12, 2, 2], () => 1, 39);
    expect(latentDriftOf(window, latentFile([1, 2, 7, 3, 2], () => 1, 22), 22)).toBeNull();
    expect(latentDriftOf(window, before, 20)).toBeNull();
    expect(latentDriftOf(window, before, 56)).toBeNull();
    expect(latentDriftOf(new Uint8Array([1, 2, 3]), before, 22)).toBeNull();
  });
});
