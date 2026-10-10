/**
 * Frames of a video by their index. A video element seeked to the exact start of frame k (k / fps) often shows frame
 * k − 1 (Chrome showed the one before at 41.7, 104, 125, 167 and 229 ms of a 24 fps video): stepping by adding a frame's
 * length to the time then repeats or skips frames, and an In or Out set there lands a frame from the picture on screen.
 * So a step goes by the index of the frame shown, and seeks to the middle of the next one, which every browser shows.
 */

/** The index of the frame on screen at a moment of the file (a hair of rounding is forgiven: 41.66… ms is frame 1). */
export const frameAt = (ms: number, fps: number): number => Math.max(0, Math.floor((ms * fps) / 1000 + 1e-6));

/** Where frame `k` starts, and its middle, in ms of the file. */
const frameStart = (k: number, fps: number): number => (k * 1000) / fps;
const frameMiddle = (k: number, fps: number): number => ((k + 0.5) * 1000) / fps;

/** The frames of a file `durationMs` long: the last one starts before its end. */
export const lastFrame = (durationMs: number, fps: number): number => Math.max(0, Math.ceil((durationMs * fps) / 1000 - 1e-6) - 1);

/** The moment to seek to for the frame `by` frames from the one shown at `ms` (kept inside the file): that frame's middle. */
export function stepFrames(ms: number, by: number, fps: number, durationMs: number): number {
  const k = Math.max(0, Math.min(lastFrame(durationMs, fps), frameAt(ms, fps) + by));
  return Math.min(durationMs, frameMiddle(k, fps));
}

/** The frame shown at `ms`, as the range it covers: In set there starts on it, Out set there ends after it. */
export function frameSpan(ms: number, fps: number): { startMs: number; endMs: number } {
  const k = frameAt(ms, fps);
  return { startMs: frameStart(k, fps), endMs: frameStart(k + 1, fps) };
}
