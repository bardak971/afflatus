/**
 * Figures read from the latents the Afflatus node pack saves (a safetensors file: a float32 video stream
 * [1, 24, T, H, W] and an audio stream), without torch: enough to tell how a continuation sits against the
 * latent it was guided by. This is the measure that showed the exact-latent drift (2026-10-05): a window
 * guided by a sampled latent reproduces that tail almost exactly but a few per cent wider in every channel,
 * at every hop, and nothing re-anchors it, so a chain slides softer and darker.
 */

/** The video stream of a saved latent: its float32 values and shape, or null when the file is not one. */
function videoOf(bytes: Uint8Array): { data: Float32Array; shape: number[] } | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Number(view.getBigUint64(0, true));
    if (n <= 0 || n > 1_000_000 || 8 + n > bytes.byteLength) return null;
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as Record<string, { dtype?: string; shape?: number[]; data_offsets?: [number, number] }>;
    const t = header.video;
    if (!t || t.dtype !== "F32" || !t.shape || t.shape.length !== 5 || !t.data_offsets) return null;
    const [a, b] = t.data_offsets;
    const start = 8 + n + a;
    const end = 8 + n + b;
    if (end > bytes.byteLength || (end - start) !== t.shape.reduce((p, x) => p * x, 1) * 4) return null;
    // a copy: the values must sit on a 4-byte boundary, which the file's header length does not promise
    return { data: new Float32Array(bytes.slice(start, end).buffer), shape: t.shape };
  } catch {
    return null;
  }
}

/** The video latent length (tokens) of an aligned frame count on MiniMax H3's 17k + 5 grid, or 0 when off it. */
export function videoTokensOf(frames: number): number {
  if (frames < 5 || (frames - 5) % 17 !== 0) return 0;
  return ((frames - 5) / 17) * 5 + 2;
}

/**
 * How wide a continuation's hidden run-up (its first `overlapFrames`) came out against the tail of the latent
 * it was guided by, as the mean over the channels of the ratio of their spreads: 1 is the same, 1.03 three per
 * cent wider. null when either file is not a saved latent, the sizes differ, or the overlap is off the grid.
 */
export function latentDriftOf(current: Uint8Array, previous: Uint8Array, overlapFrames: number): { width: number } | null {
  const cur = videoOf(current);
  const prev = videoOf(previous);
  if (!cur || !prev) return null;
  const [, channels, tc, h, w] = cur.shape as [number, number, number, number, number];
  const [, pc, tp, ph, pw] = prev.shape as [number, number, number, number, number];
  if (channels !== pc || h !== ph || w !== pw) return null;
  const ov = videoTokensOf(overlapFrames);
  if (!ov || ov >= tc || ov > tp) return null;
  const plane = h * w;
  const spread = (data: Float32Array, t: number, from: number, channel: number) => {
    let s = 0;
    let s2 = 0;
    for (let k = from; k < from + ov; k++) {
      const base = (channel * t + k) * plane;
      for (let i = 0; i < plane; i++) {
        const x = data[base + i]!;
        s += x;
        s2 += x * x;
      }
    }
    const n = ov * plane;
    const m = s / n;
    return Math.sqrt(Math.max(0, s2 / n - m * m));
  };
  let sum = 0;
  for (let c = 0; c < channels; c++) sum += spread(cur.data, tc, 0, c) / Math.max(1e-6, spread(prev.data, tp, tp - ov, c));
  return { width: Math.round((sum / channels) * 1000) / 1000 };
}
